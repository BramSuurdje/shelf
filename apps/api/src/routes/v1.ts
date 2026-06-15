import { Readable } from "node:stream"
import { auth, requireAdmin, requireSession } from "@shelf/auth"
import { openSecret, sealSecret } from "@shelf/config"
import { db, loadS3SettingsFromDb } from "@shelf/db"
import {
  appSettings,
  auditEvents,
  avatarUploadSessions,
  devices,
  fileVersions,
  invites,
  mutationReceipts,
  nodeEvents,
  nodePermissions,
  nodes,
  publicLinkAccessEvents,
  publicLinks,
  quotas,
  storageUsage,
  uploadSessions,
  user,
  usernameHistory,
} from "@shelf/db/schema"
import { maintenanceQueue } from "@shelf/jobs"
import {
  completeUploadSchema,
  createFolderSchema,
  createId,
  eventCursor,
  publicLinkToken,
  registrationModeSchema,
  setupSchema,
  sha256Hex,
  uploadSessionSchema,
} from "@shelf/shared"
import {
  abortMultipartUpload,
  completeMultipartUpload,
  createMultipartUpload,
  createObjectKey,
  createS3Client,
  defaultPartSizeBytes,
  deleteObject,
  getObjectStream,
  headObject,
  multipartThresholdBytes,
  presignGetObject,
  presignMultipartPart,
  presignSinglePutUpload,
} from "@shelf/storage"
import {
  and,
  count,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNotNull,
  isNull,
  sql,
} from "drizzle-orm"
import { Hono } from "hono"
import nodemailer from "nodemailer"
import { ZipFile } from "yazl"
import { z } from "zod"

import type { ApiVariables } from "../context"
import { created, fail, ok, parseJson } from "../http"
import { rateLimit } from "../rate-limit"

export const v1Routes = new Hono<{ Variables: ApiVariables }>()

const secretSettingKeys = new Set([
  "storage.accessKeyId",
  "storage.secretAccessKey",
  "oauth.githubClientSecret",
  "oauth.googleClientSecret",
  "smtp.password",
])

const settingValueSchemas = {
  "app.name": z.string().min(1).max(120),
  "app.publicUrl": z.url(),
  "registration.mode": registrationModeSchema,
  "registration.defaultRole": z.enum(["user", "admin"]),
  "storage.endpoint": z.url(),
  "storage.region": z.string().min(1),
  "storage.bucket": z.string().min(1),
  "storage.accessKeyId": z.string().min(1),
  "storage.secretAccessKey": z.string().min(1),
  "storage.forcePathStyle": z.boolean(),
  "storage.publicBaseUrl": z.url().nullable(),
  "storage.multipartThresholdBytes": z.number().int().positive(),
  "storage.maxFileSizeBytes": z.number().int().positive().nullable(),
  "storage.globalQuotaBytes": z.number().int().positive().nullable(),
  "storage.defaultUserQuotaBytes": z.number().int().positive(),
  "sharing.publicLinksEnabled": z.boolean(),
  "sharing.defaultPublicLinkExpirationDays": z.number().int().positive(),
  "sharing.maxPublicLinkExpirationDays": z.number().int().positive(),
  "sharing.folderSharingEnabled": z.boolean(),
  "security.emailVerificationRequired": z.boolean(),
  "security.passwordMinLength": z.number().int().min(8).max(128),
  "security.sessionLifetimeDays": z.number().int().positive(),
  "maintenance.trashRetentionDays": z.number().int().positive(),
  "maintenance.pendingUploadExpirationMinutes": z.number().int().positive(),
  "maintenance.thumbnailsEnabled": z.boolean(),
  "smtp.enabled": z.boolean(),
  "smtp.host": z.string().min(1).nullable(),
  "smtp.port": z.number().int().positive().max(65535),
  "smtp.secure": z.boolean(),
  "smtp.user": z.string().min(1).nullable(),
  "smtp.from": z.email().nullable(),
  "smtp.password": z.string().min(1),
  "oauth.githubEnabled": z.boolean(),
  "oauth.githubClientSecret": z.string().min(1),
  "oauth.googleEnabled": z.boolean(),
  "oauth.googleClientSecret": z.string().min(1),
} as const

const settingsUpdateSchema = z.object({
  settings: z.record(z.string(), z.unknown()).superRefine((settings, ctx) => {
    for (const [key, value] of Object.entries(settings)) {
      const schema =
        settingValueSchemas[key as keyof typeof settingValueSchemas]
      if (!schema) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "Unsupported setting key",
        })
        continue
      }
      const result = schema.safeParse(value)
      if (!result.success) {
        for (const issue of result.error.issues) {
          ctx.addIssue({ ...issue, path: [key, ...issue.path] })
        }
      }
    }
  }),
  mutationId: z.string().min(8),
})

const s3SettingsPatchSchema = z.object({
  settings: z.object({
    endpoint: z.url().optional(),
    region: z.string().min(1).optional(),
    bucket: z.string().min(1).optional(),
    accessKeyId: z.string().min(1).optional(),
    secretAccessKey: z.string().min(1).optional(),
    forcePathStyle: z.boolean().optional(),
    publicBaseUrl: z.url().optional().or(z.literal("")),
  }),
})

const smtpSettingsPatchSchema = z.object({
  settings: z.object({
    host: z.string().min(1).optional(),
    port: z.number().int().positive().max(65535).optional(),
    secure: z.boolean().optional(),
    user: z.string().min(1).nullable().optional(),
    password: z.string().min(1).optional(),
    from: z.email().optional(),
  }),
})

async function prepareSettingValue(key: string, value: unknown) {
  if (secretSettingKeys.has(key)) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${key} must be a non-empty string`)
    }
    return { value: await sealSecret(value), encrypted: true }
  }

  return { value, encrypted: false }
}

async function readRawSetting(key: string) {
  const [row] = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, key))
  return row
}

async function mergedS3Settings(
  input: z.infer<typeof s3SettingsPatchSchema>["settings"]
) {
  const current = await loadS3SettingsFromDb()
  return {
    endpoint: input.endpoint ?? current.endpoint,
    region: input.region ?? current.region,
    bucket: input.bucket ?? current.bucket,
    accessKeyId: input.accessKeyId ?? current.accessKeyId,
    secretAccessKey: input.secretAccessKey ?? current.secretAccessKey,
    forcePathStyle: input.forcePathStyle ?? current.forcePathStyle,
    publicBaseUrl:
      input.publicBaseUrl === ""
        ? undefined
        : (input.publicBaseUrl ?? current.publicBaseUrl),
  }
}

async function mergedSmtpSettings(
  input: z.infer<typeof smtpSettingsPatchSchema>["settings"]
) {
  const passwordRow = await readRawSetting("smtp.password")
  const currentPassword =
    typeof passwordRow?.value === "string"
      ? passwordRow.encrypted
        ? await openSecret(passwordRow.value)
        : passwordRow.value
      : undefined
  const userValue = await readSetting<string | null>("smtp.user", null)

  const settings = {
    host: input.host ?? (await readSetting("smtp.host", "")),
    port: input.port ?? (await readSetting("smtp.port", 587)),
    secure: input.secure ?? (await readSetting("smtp.secure", false)),
    user: input.user === undefined ? userValue : input.user,
    password: input.password ?? currentPassword,
    from: input.from ?? (await readSetting("smtp.from", "")),
  }

  if (!settings.host || !settings.from) {
    throw new Error("SMTP host and from address are required")
  }
  if (settings.user && !settings.password) {
    throw new Error("SMTP password is required when SMTP user is configured")
  }

  return settings
}

const shareSchema = z.object({
  nodeId: z.string(),
  username: z.string(),
  permission: z.enum(["viewer", "editor"]),
  mutationId: z.string().min(8),
})

const publicLinkSchema = z.object({
  nodeId: z.string(),
  expiresAt: z.string().datetime().optional(),
  password: z.string().min(8).optional(),
  maxDownloads: z.number().int().positive().optional(),
  mutationId: z.string().min(8),
})

const profileUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  preferences: z.record(z.string(), z.unknown()).optional(),
  mutationId: z.string().min(8),
})

const mutationOnlySchema = z.object({
  mutationId: z.string().min(8),
})

v1Routes.use(
  "/auth/*",
  rateLimit({ name: "auth", limit: 20, windowSeconds: 60 })
)
v1Routes.use(
  "/uploads/*",
  rateLimit({ name: "uploads", limit: 60, windowSeconds: 60 })
)
v1Routes.use(
  "/public/*",
  rateLimit({ name: "public", limit: 120, windowSeconds: 60 })
)

const usernameChangeSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(32)
    .regex(/^[a-z0-9_]{3,32}$/),
  mutationId: z.string().min(8),
})

const avatarUploadSchema = z.object({
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(5 * 1024 * 1024),
  mutationId: z.string().min(8),
})

const inviteAcceptSchema = z.object({
  token: z.string().min(16),
  name: z.string().min(1),
  email: z.email(),
  username: z
    .string()
    .min(3)
    .max(32)
    .regex(/^[a-z0-9_]{3,32}$/),
  password: z.string().min(10),
  mutationId: z.string().min(8),
})

async function readSetting<T>(key: string, fallback: T): Promise<T> {
  const [row] = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, key))
  return (row?.value as T | undefined) ?? fallback
}

async function changeUsername(params: {
  actorUserId: string
  targetUserId: string
  username: string
  mutationId: string
  auditType: "username.changed" | "username.admin_overridden"
}) {
  const [target] = await db
    .select()
    .from(user)
    .where(eq(user.id, params.targetUserId))
  if (!target) return { status: "not_found" as const }
  if (target.username === params.username) {
    return { status: "ok" as const, username: params.username }
  }

  const [reserved] = await db
    .select()
    .from(usernameHistory)
    .where(
      and(
        eq(usernameHistory.username, params.username),
        gt(usernameHistory.reservedUntil, new Date())
      )
    )
  if (reserved && reserved.userId !== params.targetUserId) {
    return { status: "reserved" as const }
  }

  const cooldownMs = 365 * 24 * 60 * 60 * 1000
  await db.transaction(async (tx) => {
    await tx
      .insert(usernameHistory)
      .values({
        id: createId("unh"),
        userId: target.id,
        username: target.username,
        reservedUntil: new Date(Date.now() + cooldownMs),
      })
      .onConflictDoUpdate({
        target: usernameHistory.username,
        set: {
          userId: target.id,
          reservedUntil: new Date(Date.now() + cooldownMs),
        },
      })
    await tx
      .update(user)
      .set({
        username: params.username,
        displayUsername: params.username,
        usernameChangedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(user.id, target.id))
    await tx.insert(auditEvents).values({
      id: createId("aud"),
      actorUserId: params.actorUserId,
      targetUserId: target.id,
      type: params.auditType,
      data: { mutationId: params.mutationId },
    })
  })

  return { status: "ok" as const, username: params.username }
}

async function canAccessNode(
  nodeId: string,
  userId: string,
  permission: "viewer" | "editor" = "viewer"
) {
  const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId))
  if (!node || node.deletedAt) return false
  if (node.ownerId === userId) return true

  const allowedPermissions: Array<"viewer" | "editor"> =
    permission === "viewer" ? ["viewer", "editor"] : ["editor"]
  let current: typeof node | undefined = node

  while (current) {
    const [permissionRow] = await db
      .select()
      .from(nodePermissions)
      .where(
        and(
          eq(nodePermissions.nodeId, current.id),
          eq(nodePermissions.userId, userId),
          inArray(nodePermissions.permission, allowedPermissions)
        )
      )
    if (permissionRow) return true
    if (!current.parentId) break
    const [parent] = await db
      .select()
      .from(nodes)
      .where(eq(nodes.id, current.parentId))
    current = parent
  }

  return false
}

async function requireNodeAccess(
  nodeId: string,
  userId: string,
  permission: "viewer" | "editor" = "viewer"
) {
  if (!(await canAccessNode(nodeId, userId, permission))) {
    throw new Response("Forbidden", { status: 403 })
  }
}

async function findActiveSibling(params: {
  ownerId: string
  parentId: string | null
  name: string
  excludeNodeId?: string
}) {
  const rows = await db
    .select()
    .from(nodes)
    .where(
      and(
        params.parentId
          ? eq(nodes.parentId, params.parentId)
          : and(eq(nodes.ownerId, params.ownerId), isNull(nodes.parentId)),
        eq(nodes.name, params.name),
        isNull(nodes.deletedAt)
      )
    )

  return rows.find((row) => row.id !== params.excludeNodeId)
}

async function listDescendantNodes(rootNodeId: string) {
  const descendants: Array<typeof nodes.$inferSelect> = []
  const queue = [rootNodeId]

  while (queue.length > 0) {
    const parentId = queue.shift()
    if (!parentId) continue
    const children = await db
      .select()
      .from(nodes)
      .where(and(eq(nodes.parentId, parentId), isNull(nodes.deletedAt)))
    descendants.push(...children)
    queue.push(
      ...children
        .filter((child) => child.type === "folder")
        .map((child) => child.id)
    )
  }

  return descendants
}

function zipEntryName(pathSegments: string[]) {
  return pathSegments
    .map((segment) => segment.replaceAll("/", "_").replaceAll("\\", "_"))
    .filter(Boolean)
    .join("/")
}

async function createFolderZipResponse(rootNode: typeof nodes.$inferSelect) {
  if (rootNode.type !== "folder") {
    throw new Response("Folder node required", { status: 422 })
  }

  const maxZipBytes = await readSetting<number>(
    "downloads.maxZipBytes",
    2 * 1024 * 1024 * 1024
  )
  const maxZipFiles = await readSetting<number>("downloads.maxZipFiles", 10_000)
  const descendants = await listDescendantNodes(rootNode.id)
  const fileNodes = descendants.filter(
    (node) => node.type === "file" && node.activeFileVersionId
  )
  const totalBytes = fileNodes.reduce(
    (total, node) => total + node.sizeBytes,
    0
  )

  if (fileNodes.length > maxZipFiles) {
    throw new Response("Folder has too many files to zip", { status: 413 })
  }
  if (totalBytes > maxZipBytes) {
    throw new Response("Folder is too large to zip", { status: 413 })
  }

  const versionIds = fileNodes
    .map((node) => node.activeFileVersionId)
    .filter((id): id is string => Boolean(id))
  const versions =
    versionIds.length > 0
      ? await db
          .select()
          .from(fileVersions)
          .where(inArray(fileVersions.id, versionIds))
      : []
  const versionsById = new Map(versions.map((version) => [version.id, version]))
  const nodesById = new Map(
    [rootNode, ...descendants].map((node) => [node.id, node])
  )
  const settings = await loadS3SettingsFromDb()
  const client = createS3Client(settings)
  const zip = new ZipFile()

  for (const fileNode of fileNodes) {
    const version = fileNode.activeFileVersionId
      ? versionsById.get(fileNode.activeFileVersionId)
      : undefined
    if (version?.status !== "complete") continue
    const segments = [fileNode.name]
    let parentId = fileNode.parentId
    while (parentId && parentId !== rootNode.id) {
      const parent = nodesById.get(parentId)
      if (!parent) break
      segments.unshift(parent.name)
      parentId = parent.parentId
    }

    zip.addReadStreamLazy(zipEntryName(segments), async (callback) => {
      try {
        const object = await getObjectStream(
          client,
          settings,
          version.objectKey
        )
        if (!object.Body) throw new Error("S3 object has no body")
        callback(null, object.Body as NodeJS.ReadableStream)
      } catch (error) {
        callback(
          error instanceof Error ? error : new Error("Unable to stream object"),
          undefined as unknown as NodeJS.ReadableStream
        )
      }
    })
  }

  zip.end()
  return new Response(
    Readable.toWeb(zip.outputStream as Readable) as unknown as ReadableStream,
    {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${rootNode.name.replaceAll('"', "")}.zip"`,
      },
    }
  )
}

async function assertPublicLinkPassword(
  requestPassword: string | undefined,
  passwordHash: string | null
) {
  if (!passwordHash) return
  if (!requestPassword) {
    throw new Response("Public link password required", { status: 401 })
  }
  if ((await sha256Hex(requestPassword)) !== passwordHash) {
    throw new Response("Invalid public link password", { status: 403 })
  }
}

async function readMutationReceipt(userId: string, mutationId: string) {
  const [receipt] = await db
    .select()
    .from(mutationReceipts)
    .where(
      and(
        eq(mutationReceipts.userId, userId),
        eq(mutationReceipts.mutationId, mutationId)
      )
    )
  return receipt?.response
}

async function writeMutationReceipt(
  userId: string,
  mutationId: string,
  response: Record<string, unknown>
) {
  await db
    .insert(mutationReceipts)
    .values({ userId, mutationId, response })
    .onConflictDoNothing()
}

async function recordPublicLinkAccess(
  request: Request,
  publicLinkId: string,
  nodeId: string,
  outcome: string
) {
  const ip = request.headers.get("x-forwarded-for") ?? "local"
  const userAgent = request.headers.get("user-agent") ?? "unknown"
  await db.insert(publicLinkAccessEvents).values({
    id: createId("pla"),
    publicLinkId,
    nodeId,
    outcome,
    ipHash: await sha256Hex(ip),
    userAgentHash: await sha256Hex(userAgent),
  })
}

async function assertRegistrationAllowed(request: Request) {
  const body = (await request
    .clone()
    .json()
    .catch(() => ({}))) as {
    inviteToken?: string
    email?: string
  }
  const mode = await readSetting("registration.mode", "invite_only")

  if (mode === "open") return
  if (mode === "disabled")
    throw new Response("Registration disabled", { status: 403 })

  if (!body.inviteToken || !body.email) {
    throw new Response("Invite required", { status: 403 })
  }

  const [invite] = await db
    .select()
    .from(invites)
    .where(
      and(
        eq(invites.email, body.email.toLowerCase()),
        eq(invites.tokenHash, await sha256Hex(body.inviteToken)),
        isNull(invites.revokedAt),
        isNull(invites.acceptedAt),
        gt(invites.expiresAt, new Date())
      )
    )

  if (!invite) throw new Response("Invite required", { status: 403 })
}

v1Routes.post("/auth/sign-up/email", async (c) => {
  const body = (await c.req.raw
    .clone()
    .json()
    .catch(() => ({}))) as {
    inviteToken?: string
    email?: string
    username?: string
    mutationId?: string
  }
  await assertRegistrationAllowed(c.req.raw)
  const response = await auth.handler(c.req.raw)
  if (response.ok && body.email) {
    const email = body.email.toLowerCase()
    const [createdUser] = await db
      .select()
      .from(user)
      .where(eq(user.email, email))
    if (createdUser) {
      await db.transaction(async (tx) => {
        await tx
          .insert(storageUsage)
          .values({ userId: createdUser.id })
          .onConflictDoNothing()
        if (body.username) {
          await tx
            .insert(usernameHistory)
            .values({
              id: createId("unh"),
              userId: createdUser.id,
              username: body.username,
              reservedUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
            })
            .onConflictDoNothing()
        }
        if (body.inviteToken) {
          await tx
            .update(invites)
            .set({ acceptedAt: new Date(), acceptedByUserId: createdUser.id })
            .where(
              and(
                eq(invites.email, email),
                eq(invites.tokenHash, await sha256Hex(body.inviteToken)),
                isNull(invites.revokedAt),
                isNull(invites.acceptedAt)
              )
            )
        }
      })
    }
  }
  return response
})

v1Routes.post("/invites/accept", async (c) => {
  const input = await parseJson(c, inviteAcceptSchema)
  const tokenHash = await sha256Hex(input.token)
  const [invite] = await db
    .select()
    .from(invites)
    .where(
      and(
        eq(invites.email, input.email.toLowerCase()),
        eq(invites.tokenHash, tokenHash),
        isNull(invites.revokedAt),
        gt(invites.expiresAt, new Date())
      )
    )

  if (!invite) return fail(c, 404, "Invite not found")
  if (invite.acceptedByUserId) {
    const existingResponse = await readMutationReceipt(
      invite.acceptedByUserId,
      input.mutationId
    )
    if (existingResponse) return ok(c, existingResponse)
  }
  if (invite.acceptedAt) return fail(c, 409, "Invite has already been accepted")

  const createdUser = await auth.api.createUser({
    body: {
      name: input.name,
      email: input.email,
      password: input.password,
      role: invite.role === "admin" ? "admin" : "user",
      data: {
        username: input.username,
        usernameChangedAt: new Date(),
        preferences: {},
      },
    },
  })

  await db.transaction(async (tx) => {
    await tx
      .update(invites)
      .set({ acceptedAt: new Date(), acceptedByUserId: createdUser.user.id })
      .where(eq(invites.id, invite.id))
    await tx.insert(storageUsage).values({ userId: createdUser.user.id })
    await tx.insert(usernameHistory).values({
      id: createId("unh"),
      userId: createdUser.user.id,
      username: input.username,
      reservedUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    })
    await tx.insert(auditEvents).values({
      id: createId("aud"),
      actorUserId: createdUser.user.id,
      targetUserId: createdUser.user.id,
      type: "invite.accepted",
      data: { inviteId: invite.id, mutationId: input.mutationId },
    })
  })

  const response = { user: createdUser.user }
  await writeMutationReceipt(createdUser.user.id, input.mutationId, response)
  return created(c, response)
})

v1Routes.get("/auth/current-user", async (c) => {
  const session = await requireSession(c.req.raw)
  return ok(c, { user: session.user, session: session.session })
})

v1Routes.all("/auth/*", (c) => auth.handler(c.req.raw))

v1Routes.get("/setup/status", async (c) => {
  const [row] = await db.select({ value: count() }).from(user)
  const value = row?.value ?? 0
  return ok(c, {
    required: value === 0,
    disabled: value > 0,
  })
})

v1Routes.post("/setup", async (c) => {
  const input = await parseJson(c, setupSchema)
  const [row] = await db.select({ value: count() }).from(user)
  const value = row?.value ?? 0
  if (value > 0) {
    const [owner] = await db
      .select()
      .from(user)
      .where(eq(user.email, input.owner.email.toLowerCase()))
    if (owner) {
      const existingResponse = await readMutationReceipt(
        owner.id,
        input.mutationId
      )
      if (existingResponse) return ok(c, existingResponse)
    }
    return fail(c, 409, "First-run setup is permanently disabled")
  }

  const result = await auth.api.createUser({
    body: {
      name: input.owner.name,
      email: input.owner.email,
      password: input.owner.password,
      role: "admin",
      data: {
        username: input.owner.username,
        usernameChangedAt: new Date(),
        storageQuotaBytes: input.quotas.defaultUserQuotaBytes,
        onboardingCompletedAt: new Date(),
        preferences: {},
      },
    },
  })
  const ownerId = result.user.id

  await db.transaction(async (tx) => {
    await tx
      .update(user)
      .set({
        emailVerified: true,
        role: "owner",
        username: input.owner.username,
        displayUsername: input.owner.username,
        usernameChangedAt: new Date(),
        storageQuotaBytes: input.quotas.defaultUserQuotaBytes,
        onboardingCompletedAt: new Date(),
      })
      .where(eq(user.id, ownerId))

    await tx.insert(storageUsage).values({ userId: ownerId })
    await tx.insert(usernameHistory).values({
      id: createId("unh"),
      userId: ownerId,
      username: input.owner.username,
      reservedUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    })

    await tx.insert(appSettings).values([
      { key: "app.name", value: input.appName, updatedByUserId: ownerId },
      {
        key: "app.publicUrl",
        value: input.publicAppUrl,
        updatedByUserId: ownerId,
      },
      {
        key: "registration.mode",
        value: input.registrationMode,
        updatedByUserId: ownerId,
      },
      {
        key: "storage.endpoint",
        value: input.storage.endpoint,
        updatedByUserId: ownerId,
      },
      {
        key: "storage.region",
        value: input.storage.region,
        updatedByUserId: ownerId,
      },
      {
        key: "storage.bucket",
        value: input.storage.bucket,
        updatedByUserId: ownerId,
      },
      {
        key: "storage.forcePathStyle",
        value: input.storage.forcePathStyle,
        updatedByUserId: ownerId,
      },
      {
        key: "storage.publicBaseUrl",
        value: input.storage.publicBaseUrl || null,
        updatedByUserId: ownerId,
      },
      {
        key: "storage.accessKeyId",
        value: await sealSecret(input.storage.accessKeyId),
        encrypted: true,
        updatedByUserId: ownerId,
      },
      {
        key: "storage.secretAccessKey",
        value: await sealSecret(input.storage.secretAccessKey),
        encrypted: true,
        updatedByUserId: ownerId,
      },
      {
        key: "storage.defaultUserQuotaBytes",
        value: input.quotas.defaultUserQuotaBytes,
        updatedByUserId: ownerId,
      },
      {
        key: "storage.globalQuotaBytes",
        value: input.quotas.globalQuotaBytes ?? null,
        updatedByUserId: ownerId,
      },
      {
        key: "oauth.githubEnabled",
        value: input.oauth.githubEnabled,
        updatedByUserId: ownerId,
      },
      {
        key: "oauth.googleEnabled",
        value: input.oauth.googleEnabled,
        updatedByUserId: ownerId,
      },
      {
        key: "smtp.enabled",
        value: input.smtpEnabled,
        updatedByUserId: ownerId,
      },
      { key: "smtp.host", value: "", updatedByUserId: ownerId },
      { key: "smtp.port", value: 587, updatedByUserId: ownerId },
      { key: "smtp.secure", value: false, updatedByUserId: ownerId },
      { key: "smtp.user", value: null, updatedByUserId: ownerId },
      { key: "smtp.from", value: input.owner.email, updatedByUserId: ownerId },
    ])

    await tx.insert(auditEvents).values({
      id: createId("aud"),
      actorUserId: ownerId,
      targetUserId: ownerId,
      type: "setup.completed",
      data: { appName: input.appName, mutationId: input.mutationId },
    })
  })

  const response = { ownerId }
  await writeMutationReceipt(ownerId, input.mutationId, response)
  return created(c, response)
})

v1Routes.post("/setup/test-s3", async (c) => {
  const input = await parseJson(c, setupSchema.shape.storage)
  const { testS3Connection } = await import("@shelf/storage")
  await testS3Connection({
    endpoint: input.endpoint,
    region: input.region,
    bucket: input.bucket,
    accessKeyId: input.accessKeyId,
    secretAccessKey: input.secretAccessKey,
    forcePathStyle: input.forcePathStyle,
    publicBaseUrl: input.publicBaseUrl || undefined,
  })
  return ok(c, { connected: true })
})

v1Routes.get("/nodes", async (c) => {
  const session = await requireSession(c.req.raw)
  const parentId = c.req.query("parentId") ?? null
  if (parentId) {
    await requireNodeAccess(parentId, session.user.id, "viewer")
    const rows = await db
      .select()
      .from(nodes)
      .where(and(eq(nodes.parentId, parentId), isNull(nodes.deletedAt)))
      .orderBy(nodes.type, nodes.name)
    const visibleRows = []
    for (const row of rows) {
      if (await canAccessNode(row.id, session.user.id, "viewer"))
        visibleRows.push(row)
    }
    return ok(c, { nodes: visibleRows })
  }

  const rows = await db
    .select()
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, session.user.id),
        parentId ? eq(nodes.parentId, parentId) : isNull(nodes.parentId),
        isNull(nodes.deletedAt)
      )
    )
    .orderBy(nodes.type, nodes.name)

  return ok(c, { nodes: rows })
})

v1Routes.get("/nodes/search", async (c) => {
  const session = await requireSession(c.req.raw)
  const query = c.req.query("q")?.trim()
  if (!query) return ok(c, { nodes: [] })

  const rows = await db
    .select()
    .from(nodes)
    .where(and(isNull(nodes.deletedAt), ilike(nodes.name, `%${query}%`)))
    .orderBy(desc(nodes.updatedAt))
    .limit(50)
  const visibleRows = []
  for (const row of rows) {
    if (await canAccessNode(row.id, session.user.id, "viewer"))
      visibleRows.push(row)
  }

  return ok(c, { nodes: visibleRows })
})

v1Routes.get("/nodes/recent", async (c) => {
  const session = await requireSession(c.req.raw)
  const rows = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.ownerId, session.user.id), isNull(nodes.deletedAt)))
    .orderBy(desc(nodes.updatedAt))
    .limit(50)

  return ok(c, { nodes: rows })
})

v1Routes.post("/nodes/folders", async (c) => {
  const session = await requireSession(c.req.raw)
  const input = await parseJson(c, createFolderSchema)
  const existingResponse = await readMutationReceipt(
    session.user.id,
    input.mutationId
  )
  if (existingResponse) return ok(c, existingResponse)
  if (input.parentId)
    await requireNodeAccess(input.parentId, session.user.id, "editor")
  if (
    await findActiveSibling({
      ownerId: session.user.id,
      parentId: input.parentId,
      name: input.name,
    })
  ) {
    return fail(c, 409, "A node with that name already exists in this folder")
  }
  const nodeId = createId("nod")
  const cursor = eventCursor()

  await db.transaction(async (tx) => {
    await tx.insert(nodes).values({
      id: nodeId,
      ownerId: session.user.id,
      parentId: input.parentId,
      type: "folder",
      name: input.name,
    })
    await tx.insert(nodeEvents).values({
      id: createId("evt"),
      cursor,
      nodeId,
      userId: session.user.id,
      deviceId: input.deviceId,
      mutationId: input.mutationId,
      type: "folder.created",
      data: { name: input.name, parentId: input.parentId },
    })
  })

  const response = { nodeId, revision: 1, eventCursor: cursor }
  await writeMutationReceipt(session.user.id, input.mutationId, response)
  return created(c, response)
})

v1Routes.patch("/nodes/:id", async (c) => {
  const session = await requireSession(c.req.raw)
  const input = await parseJson(
    c,
    z.object({
      name: z.string().min(1).max(255).optional(),
      parentId: z.string().nullable().optional(),
      mutationId: z.string().min(8),
      baseNodeRevision: z.number().int().positive().optional(),
    })
  )
  const id = c.req.param("id")
  const existingResponse = await readMutationReceipt(
    session.user.id,
    input.mutationId
  )
  if (existingResponse) return ok(c, existingResponse)
  await requireNodeAccess(id, session.user.id, "editor")
  const [current] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), isNull(nodes.deletedAt)))

  if (!current) return fail(c, 404, "Node not found")
  if (input.baseNodeRevision && input.baseNodeRevision !== current.revision) {
    return fail(c, 409, "Base node revision is stale")
  }
  if (input.parentId)
    await requireNodeAccess(input.parentId, session.user.id, "editor")
  const nextParentId = Object.hasOwn(input, "parentId")
    ? (input.parentId ?? null)
    : current.parentId
  const nextName = input.name ?? current.name
  if (
    await findActiveSibling({
      ownerId: current.ownerId,
      parentId: nextParentId,
      name: nextName,
      excludeNodeId: current.id,
    })
  ) {
    return fail(c, 409, "A node with that name already exists in this folder")
  }

  const cursor = eventCursor()
  const [updated] = await db
    .update(nodes)
    .set({
      name: nextName,
      parentId: nextParentId,
      revision: current.revision + 1,
      updatedAt: new Date(),
    })
    .where(eq(nodes.id, id))
    .returning()

  await db.insert(nodeEvents).values({
    id: createId("evt"),
    cursor,
    nodeId: id,
    userId: session.user.id,
    mutationId: input.mutationId,
    type: "node.updated",
    data: { name: input.name, parentId: input.parentId },
  })

  const response = { node: updated, eventCursor: cursor }
  await writeMutationReceipt(session.user.id, input.mutationId, response)
  return ok(c, response)
})

v1Routes.post("/nodes/:id/copy", async (c) => {
  const session = await requireSession(c.req.raw)
  const input = await parseJson(
    c,
    z.object({
      parentId: z.string().nullable(),
      name: z.string().min(1).max(255).optional(),
      mutationId: z.string().min(8),
    })
  )
  const id = c.req.param("id")
  const existingResponse = await readMutationReceipt(
    session.user.id,
    input.mutationId
  )
  if (existingResponse) return ok(c, existingResponse)
  await requireNodeAccess(id, session.user.id, "viewer")
  if (input.parentId)
    await requireNodeAccess(input.parentId, session.user.id, "editor")

  const [source] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), isNull(nodes.deletedAt)))
  if (!source) return fail(c, 404, "Node not found")
  const copyName = input.name ?? `${source.name} copy`
  if (
    await findActiveSibling({
      ownerId: session.user.id,
      parentId: input.parentId,
      name: copyName,
    })
  ) {
    return fail(c, 409, "A node with that name already exists in this folder")
  }

  const rootCopyId = createId("nod")
  const cursor = eventCursor()
  const idMap = new Map<string, string>([[source.id, rootCopyId]])
  const descendants =
    source.type === "folder" ? await listDescendantNodes(source.id) : []

  await db.transaction(async (tx) => {
    await tx.insert(nodes).values({
      id: rootCopyId,
      ownerId: session.user.id,
      parentId: input.parentId,
      type: source.type,
      name: copyName,
      activeFileVersionId: source.activeFileVersionId,
      sizeBytes: source.sizeBytes,
      mimeType: source.mimeType,
    })

    if (source.type === "folder") {
      for (const descendant of descendants) {
        const copiedId = createId("nod")
        idMap.set(descendant.id, copiedId)
        const copiedParentId = descendant.parentId
          ? (idMap.get(descendant.parentId) ?? rootCopyId)
          : rootCopyId
        await tx.insert(nodes).values({
          id: copiedId,
          ownerId: session.user.id,
          parentId: copiedParentId,
          type: descendant.type,
          name: descendant.name,
          activeFileVersionId: descendant.activeFileVersionId,
          sizeBytes: descendant.sizeBytes,
          mimeType: descendant.mimeType,
        })
      }
    }

    await tx.insert(nodeEvents).values({
      id: createId("evt"),
      cursor,
      nodeId: rootCopyId,
      userId: session.user.id,
      mutationId: input.mutationId,
      type: "node.copied",
      data: { sourceNodeId: source.id, parentId: input.parentId },
    })
  })

  const response = { nodeId: rootCopyId, revision: 1, eventCursor: cursor }
  await writeMutationReceipt(session.user.id, input.mutationId, response)
  return created(c, response)
})

v1Routes.delete("/nodes/:id", async (c) => {
  const session = await requireSession(c.req.raw)
  const input = await parseJson(c, z.object({ mutationId: z.string().min(8) }))
  const id = c.req.param("id")
  const existingResponse = await readMutationReceipt(
    session.user.id,
    input.mutationId
  )
  if (existingResponse) return ok(c, existingResponse)
  await requireNodeAccess(id, session.user.id, "editor")
  const cursor = eventCursor()
  const [updated] = await db
    .update(nodes)
    .set({
      deletedAt: new Date(),
      tombstoneAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(nodes.id, id))
    .returning()

  if (!updated) return fail(c, 404, "Node not found")

  await db.insert(nodeEvents).values({
    id: createId("evt"),
    cursor,
    nodeId: id,
    userId: session.user.id,
    mutationId: input.mutationId,
    type: "node.trashed",
    data: {},
  })

  const response = { node: updated, eventCursor: cursor }
  await writeMutationReceipt(session.user.id, input.mutationId, response)
  return ok(c, response)
})

v1Routes.get("/nodes/:id/download", async (c) => {
  const session = await requireSession(c.req.raw)
  const id = c.req.param("id")
  await requireNodeAccess(id, session.user.id, "viewer")
  const [node] = await db.select().from(nodes).where(eq(nodes.id, id))
  if (node?.type !== "file" || !node.activeFileVersionId) {
    return fail(c, 404, "Downloadable file not found")
  }
  const [version] = await db
    .select()
    .from(fileVersions)
    .where(eq(fileVersions.id, node.activeFileVersionId))
  if (version?.status !== "complete") {
    return fail(c, 404, "Completed file version not found")
  }
  const settings = await loadS3SettingsFromDb()
  const url = await presignGetObject(
    createS3Client(settings),
    settings,
    version.objectKey
  )
  await db.insert(auditEvents).values({
    id: createId("aud"),
    actorUserId: session.user.id,
    nodeId: id,
    type: "download.presigned",
    data: { fileVersionId: version.id },
  })
  return ok(c, { url, expiresInSeconds: 15 * 60 })
})

v1Routes.get("/nodes/:id/preview/text", async (c) => {
  const session = await requireSession(c.req.raw)
  const id = c.req.param("id")
  await requireNodeAccess(id, session.user.id, "viewer")
  const [node] = await db.select().from(nodes).where(eq(nodes.id, id))
  if (node?.type !== "file" || !node.activeFileVersionId) {
    return fail(c, 404, "Previewable file not found")
  }
  if (
    !node.mimeType?.startsWith("text/") &&
    node.mimeType !== "application/json"
  ) {
    return fail(c, 415, "Text preview is not available for this file type")
  }
  const maxPreviewBytes = 1024 * 1024
  if (node.sizeBytes > maxPreviewBytes) {
    return fail(c, 413, "Text preview is limited to 1 MiB")
  }
  const [version] = await db
    .select()
    .from(fileVersions)
    .where(eq(fileVersions.id, node.activeFileVersionId))
  if (version?.status !== "complete") {
    return fail(c, 404, "Completed file version not found")
  }
  const settings = await loadS3SettingsFromDb()
  const object = await getObjectStream(
    createS3Client(settings),
    settings,
    version.objectKey
  )
  if (!object.Body) return fail(c, 404, "Object body not found")
  const text = await new Response(object.Body as BodyInit).text()
  return ok(c, { text, truncated: false, sizeBytes: node.sizeBytes })
})

v1Routes.get("/nodes/:id/zip", async (c) => {
  const session = await requireSession(c.req.raw)
  const id = c.req.param("id")
  await requireNodeAccess(id, session.user.id, "viewer")
  const [node] = await db.select().from(nodes).where(eq(nodes.id, id))
  if (node?.type !== "folder") return fail(c, 404, "Folder not found")
  await db.insert(auditEvents).values({
    id: createId("aud"),
    actorUserId: session.user.id,
    nodeId: id,
    type: "download.zip",
    data: {},
  })
  return createFolderZipResponse(node)
})

v1Routes.get("/trash", async (c) => {
  const session = await requireSession(c.req.raw)
  const rows = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.ownerId, session.user.id), isNotNull(nodes.deletedAt)))
    .orderBy(desc(nodes.deletedAt))

  return ok(c, { nodes: rows })
})

v1Routes.post("/trash/:id/restore", async (c) => {
  const session = await requireSession(c.req.raw)
  const input = await parseJson(c, z.object({ mutationId: z.string().min(8) }))
  const id = c.req.param("id")
  const existingResponse = await readMutationReceipt(
    session.user.id,
    input.mutationId
  )
  if (existingResponse) return ok(c, existingResponse)
  const cursor = eventCursor()
  const [current] = await db
    .select()
    .from(nodes)
    .where(
      and(
        eq(nodes.id, id),
        eq(nodes.ownerId, session.user.id),
        isNotNull(nodes.deletedAt)
      )
    )
  if (!current) return fail(c, 404, "Node not found")
  if (
    await findActiveSibling({
      ownerId: current.ownerId,
      parentId: current.parentId,
      name: current.name,
      excludeNodeId: current.id,
    })
  ) {
    return fail(c, 409, "A node with that name already exists in this folder")
  }
  const [updated] = await db
    .update(nodes)
    .set({
      deletedAt: null,
      tombstoneAt: null,
      revision: sql`${nodes.revision} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(nodes.id, id))
    .returning()

  if (!updated) return fail(c, 404, "Node not found")
  await db.insert(nodeEvents).values({
    id: createId("evt"),
    cursor,
    nodeId: id,
    userId: session.user.id,
    mutationId: input.mutationId,
    type: "node.restored",
    data: {},
  })

  const response = { node: updated, eventCursor: cursor }
  await writeMutationReceipt(session.user.id, input.mutationId, response)
  return ok(c, response)
})

v1Routes.delete("/trash/:id", async (c) => {
  const session = await requireSession(c.req.raw)
  const input = await parseJson(c, mutationOnlySchema)
  const id = c.req.param("id")
  const existingResponse = await readMutationReceipt(
    session.user.id,
    input.mutationId
  )
  if (existingResponse) return ok(c, existingResponse)
  const settings = await loadS3SettingsFromDb()
  const client = createS3Client(settings)
  const versions = await db
    .select()
    .from(fileVersions)
    .where(eq(fileVersions.nodeId, id))

  for (const version of versions) {
    await deleteObject(client, settings, version.objectKey)
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(nodes)
      .where(and(eq(nodes.id, id), eq(nodes.ownerId, session.user.id)))
    await tx.insert(auditEvents).values({
      id: createId("aud"),
      actorUserId: session.user.id,
      nodeId: id,
      type: "node.permanently_deleted",
      data: { mutationId: input.mutationId },
    })
  })
  const response = { nodeId: id, deleted: true }
  await writeMutationReceipt(session.user.id, input.mutationId, response)
  return ok(c, response)
})

v1Routes.get("/events", async (c) => {
  const session = await requireSession(c.req.raw)
  const cursor = c.req.query("cursor")
  const rows = await db
    .select()
    .from(nodeEvents)
    .where(
      cursor
        ? and(
            eq(nodeEvents.userId, session.user.id),
            gt(nodeEvents.cursor, cursor)
          )
        : eq(nodeEvents.userId, session.user.id)
    )
    .orderBy(nodeEvents.cursor)
    .limit(200)

  return ok(c, {
    events: rows,
    nextCursor: rows.at(-1)?.cursor ?? cursor ?? null,
  })
})

v1Routes.get("/devices", async (c) => {
  const session = await requireSession(c.req.raw)
  const rows = await db
    .select()
    .from(devices)
    .where(eq(devices.userId, session.user.id))
    .orderBy(desc(devices.lastSeenAt))
  return ok(c, { devices: rows })
})

v1Routes.post("/devices", async (c) => {
  const session = await requireSession(c.req.raw)
  const input = await parseJson(
    c,
    z.object({
      name: z.string().min(1).max(120),
      mutationId: z.string().min(8),
    })
  )
  const existingResponse = await readMutationReceipt(
    session.user.id,
    input.mutationId
  )
  if (existingResponse) return ok(c, existingResponse)
  const id = createId("dev")
  await db.insert(devices).values({
    id,
    userId: session.user.id,
    name: input.name,
    lastSeenAt: new Date(),
  })
  const response = { id }
  await writeMutationReceipt(session.user.id, input.mutationId, response)
  return created(c, response)
})

v1Routes.get("/users/lookup", async (c) => {
  await requireSession(c.req.raw)
  const username = c.req.query("username")?.trim()
  if (!username) return fail(c, 422, "Username is required")
  const [targetUser] = await db
    .select({
      id: user.id,
      username: user.username,
      name: user.name,
      image: user.image,
    })
    .from(user)
    .where(
      and(
        eq(user.username, username),
        isNull(user.disabledAt),
        eq(user.banned, false)
      )
    )
  if (!targetUser) return fail(c, 404, "User not found")
  return ok(c, { user: targetUser })
})

v1Routes.post("/uploads", async (c) => {
  const session = await requireSession(c.req.raw)
  const input = await parseJson(c, uploadSessionSchema)
  const existingResponse = await readMutationReceipt(
    session.user.id,
    input.mutationId
  )
  if (existingResponse) return ok(c, existingResponse)
  if (input.parentId)
    await requireNodeAccess(input.parentId, session.user.id, "editor")
  const maxFileSizeBytes = await readSetting<number | null>(
    "storage.maxFileSizeBytes",
    null
  )
  if (maxFileSizeBytes && input.sizeBytes > maxFileSizeBytes) {
    return fail(c, 413, "Upload exceeds max file size", {
      maxFileSizeBytes,
      sizeBytes: input.sizeBytes,
    })
  }
  const [usage] = await db
    .select()
    .from(storageUsage)
    .where(eq(storageUsage.userId, session.user.id))
  const [quotaOverride] = await db
    .select()
    .from(quotas)
    .where(eq(quotas.userId, session.user.id))
  const quotaBytes =
    quotaOverride?.quotaBytes ??
    session.user.storageQuotaBytes ??
    (await readSetting<number>(
      "storage.defaultUserQuotaBytes",
      10 * 1024 * 1024 * 1024
    ))
  const projectedBytes =
    (usage?.usedBytes ?? 0) + (usage?.reservedBytes ?? 0) + input.sizeBytes
  if (projectedBytes > quotaBytes) {
    return fail(c, 413, "Upload exceeds user quota", {
      quotaBytes,
      projectedBytes,
    })
  }
  const globalQuotaBytes = await readSetting<number | null>(
    "storage.globalQuotaBytes",
    null
  )
  if (globalQuotaBytes) {
    const [globalUsage] = await db
      .select({
        usedBytes: sql<number>`coalesce(sum(${storageUsage.usedBytes}), 0)`,
        reservedBytes: sql<number>`coalesce(sum(${storageUsage.reservedBytes}), 0)`,
      })
      .from(storageUsage)
    const projectedGlobalBytes =
      (globalUsage?.usedBytes ?? 0) +
      (globalUsage?.reservedBytes ?? 0) +
      input.sizeBytes
    if (projectedGlobalBytes > globalQuotaBytes) {
      return fail(c, 413, "Upload exceeds global quota", {
        globalQuotaBytes,
        projectedGlobalBytes,
      })
    }
  }
  const settings = await loadS3SettingsFromDb()
  const client = createS3Client(settings)
  const existingSibling = await findActiveSibling({
    ownerId: session.user.id,
    parentId: input.parentId,
    name: input.fileName,
  })
  if (existingSibling?.type === "folder") {
    return fail(c, 409, "A folder with that name already exists")
  }
  const nodeId = existingSibling?.id ?? createId("nod")
  const fileVersionId = createId("ver")
  const uploadSessionId = createId("upl")
  const objectKey = createObjectKey(session.user.id)
  const kind =
    input.sizeBytes >= multipartThresholdBytes ? "multipart" : "single"
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000)

  let response:
    | { kind: "single"; url: string; expiresAt: string }
    | {
        kind: "multipart"
        uploadId: string
        partSizeBytes: number
        parts: Array<{ partNumber: number; url: string }>
        expiresAt: string
      }

  if (kind === "single") {
    response = {
      kind,
      url: await presignSinglePutUpload(client, settings, {
        objectKey,
        contentType: input.mimeType,
        sizeBytes: input.sizeBytes,
      }),
      expiresAt: expiresAt.toISOString(),
    }
  } else {
    const uploadId = await createMultipartUpload(client, settings, {
      objectKey,
      contentType: input.mimeType,
    })
    const partCount = Math.ceil(input.sizeBytes / defaultPartSizeBytes)
    const parts = await Promise.all(
      Array.from({ length: partCount }, async (_, index) => {
        const partNumber = index + 1
        return {
          partNumber,
          url: await presignMultipartPart(client, settings, {
            objectKey,
            uploadId,
            partNumber,
          }),
        }
      })
    )
    response = {
      kind,
      uploadId,
      partSizeBytes: defaultPartSizeBytes,
      parts,
      expiresAt: expiresAt.toISOString(),
    }
  }

  await db.transaction(async (tx) => {
    if (!existingSibling) {
      await tx.insert(nodes).values({
        id: nodeId,
        ownerId: session.user.id,
        parentId: input.parentId,
        type: "file",
        name: input.fileName,
        sizeBytes: input.sizeBytes,
        mimeType: input.mimeType,
      })
    }
    await tx.insert(fileVersions).values({
      id: fileVersionId,
      nodeId,
      ownerId: session.user.id,
      objectKey,
      sizeBytes: input.sizeBytes,
      mimeType: input.mimeType,
      checksumSha256: input.checksumSha256,
    })
    await tx.insert(uploadSessions).values({
      id: uploadSessionId,
      ownerId: session.user.id,
      nodeId,
      fileVersionId,
      objectKey,
      kind,
      status: "pending",
      multipartUploadId:
        response.kind === "multipart" ? response.uploadId : null,
      sizeBytes: input.sizeBytes,
      reservedBytes: input.sizeBytes,
      expiresAt,
      mutationId: input.mutationId,
      deviceId: input.deviceId,
    })
    await tx
      .insert(storageUsage)
      .values({ userId: session.user.id, reservedBytes: input.sizeBytes })
      .onConflictDoUpdate({
        target: storageUsage.userId,
        set: {
          reservedBytes: sql`${storageUsage.reservedBytes} + ${input.sizeBytes}`,
          updatedAt: new Date(),
        },
      })
  })

  const responseBody = {
    uploadSessionId,
    nodeId,
    fileVersionId,
    objectKey,
    upload: response,
  }
  await writeMutationReceipt(session.user.id, input.mutationId, responseBody)
  return created(c, responseBody)
})

v1Routes.post("/uploads/:id/complete", async (c) => {
  const session = await requireSession(c.req.raw)
  const input = await parseJson(c, completeUploadSchema)
  const existingResponse = await readMutationReceipt(
    session.user.id,
    input.mutationId
  )
  if (existingResponse) return ok(c, existingResponse)
  const id = c.req.param("id")
  const [sessionRow] = await db
    .select()
    .from(uploadSessions)
    .where(
      and(
        eq(uploadSessions.id, id),
        eq(uploadSessions.ownerId, session.user.id)
      )
    )

  if (!sessionRow) return fail(c, 404, "Upload session not found")
  const [pendingVersion] = await db
    .select()
    .from(fileVersions)
    .where(eq(fileVersions.id, sessionRow.fileVersionId))
  if (!pendingVersion) return fail(c, 404, "Pending file version not found")
  const settings = await loadS3SettingsFromDb()
  const client = createS3Client(settings)
  if (sessionRow.kind === "multipart") {
    if (!sessionRow.multipartUploadId || !input.parts?.length) {
      return fail(c, 422, "Multipart upload requires completed parts")
    }
    await completeMultipartUpload(client, settings, {
      objectKey: sessionRow.objectKey,
      uploadId: sessionRow.multipartUploadId,
      parts: input.parts.map((part) => ({
        PartNumber: part.partNumber,
        ETag: part.eTag,
      })),
    })
  }

  const metadata = await headObject(client, settings, sessionRow.objectKey)
  if (metadata.ContentLength !== sessionRow.sizeBytes) {
    return fail(c, 422, "Uploaded object size does not match session size", {
      expected: sessionRow.sizeBytes,
      actual: metadata.ContentLength,
    })
  }
  const cursor = eventCursor()

  await db.transaction(async (tx) => {
    await tx
      .update(uploadSessions)
      .set({
        status: "completed",
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(uploadSessions.id, id))
    await tx
      .update(fileVersions)
      .set({
        status: "complete",
        eTag: input.eTag,
        checksumSha256: input.checksumSha256,
        completedAt: new Date(),
      })
      .where(eq(fileVersions.id, sessionRow.fileVersionId))
    await tx
      .update(nodes)
      .set({
        activeFileVersionId: sessionRow.fileVersionId,
        sizeBytes: sessionRow.sizeBytes,
        mimeType: pendingVersion.mimeType,
        revision: sql`${nodes.revision} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(nodes.id, sessionRow.nodeId))
    await tx
      .update(storageUsage)
      .set({
        usedBytes: sql`${storageUsage.usedBytes} + ${sessionRow.sizeBytes}`,
        reservedBytes: sql`${storageUsage.reservedBytes} - ${sessionRow.reservedBytes}`,
        updatedAt: new Date(),
      })
      .where(eq(storageUsage.userId, session.user.id))
    await tx.insert(nodeEvents).values({
      id: createId("evt"),
      cursor,
      nodeId: sessionRow.nodeId,
      userId: session.user.id,
      mutationId: input.mutationId,
      type: "file.completed",
      data: { fileVersionId: sessionRow.fileVersionId },
    })
  })

  if (sessionRow.kind && metadata.ContentType?.startsWith("image/")) {
    await maintenanceQueue.add("images.generateThumbnail", {
      fileVersionId: sessionRow.fileVersionId,
      requestId: c.var.requestId,
    })
  }

  const response = { uploadSessionId: id, eventCursor: cursor }
  await writeMutationReceipt(session.user.id, input.mutationId, response)
  return ok(c, response)
})

v1Routes.post("/uploads/:id/abort", async (c) => {
  const session = await requireSession(c.req.raw)
  const input = await parseJson(c, mutationOnlySchema)
  const existingResponse = await readMutationReceipt(
    session.user.id,
    input.mutationId
  )
  if (existingResponse) return ok(c, existingResponse)
  const id = c.req.param("id")
  const [sessionRow] = await db
    .update(uploadSessions)
    .set({ status: "aborted", updatedAt: new Date() })
    .where(
      and(
        eq(uploadSessions.id, id),
        eq(uploadSessions.ownerId, session.user.id)
      )
    )
    .returning()

  if (!sessionRow) return fail(c, 404, "Upload session not found")
  if (sessionRow.multipartUploadId) {
    const settings = await loadS3SettingsFromDb()
    await abortMultipartUpload(createS3Client(settings), settings, {
      objectKey: sessionRow.objectKey,
      uploadId: sessionRow.multipartUploadId,
    })
  }

  await db
    .update(storageUsage)
    .set({
      reservedBytes: sql`${storageUsage.reservedBytes} - ${sessionRow.reservedBytes}`,
      updatedAt: new Date(),
    })
    .where(eq(storageUsage.userId, session.user.id))
  await db.insert(auditEvents).values({
    id: createId("aud"),
    actorUserId: session.user.id,
    nodeId: sessionRow.nodeId,
    type: "upload.aborted",
    data: { uploadSessionId: id, mutationId: input.mutationId },
  })

  const response = { uploadSessionId: id, status: "aborted" }
  await writeMutationReceipt(session.user.id, input.mutationId, response)
  return ok(c, response)
})

v1Routes.post("/shares", async (c) => {
  const session = await requireSession(c.req.raw)
  const input = await parseJson(c, shareSchema)
  const existingResponse = await readMutationReceipt(
    session.user.id,
    input.mutationId
  )
  if (existingResponse) return ok(c, existingResponse)
  const [targetUser] = await db
    .select()
    .from(user)
    .where(eq(user.username, input.username))
  if (!targetUser) return fail(c, 404, "User not found")
  await requireNodeAccess(input.nodeId, session.user.id, "editor")

  await db.insert(nodePermissions).values({
    nodeId: input.nodeId,
    userId: targetUser.id,
    permission: input.permission,
    createdByUserId: session.user.id,
  })
  await db.insert(auditEvents).values({
    id: createId("aud"),
    actorUserId: session.user.id,
    targetUserId: targetUser.id,
    nodeId: input.nodeId,
    type: "share.created",
    data: { permission: input.permission, mutationId: input.mutationId },
  })

  const response = { nodeId: input.nodeId, userId: targetUser.id }
  await writeMutationReceipt(session.user.id, input.mutationId, response)
  return created(c, response)
})

v1Routes.get("/shares/shared-with-me", async (c) => {
  const session = await requireSession(c.req.raw)
  const rows = await db
    .select({ node: nodes, permission: nodePermissions.permission })
    .from(nodePermissions)
    .innerJoin(nodes, eq(nodes.id, nodePermissions.nodeId))
    .where(eq(nodePermissions.userId, session.user.id))

  return ok(c, { items: rows })
})

v1Routes.get("/shares/:nodeId", async (c) => {
  const session = await requireSession(c.req.raw)
  const nodeId = c.req.param("nodeId")
  await requireNodeAccess(nodeId, session.user.id, "editor")
  const rows = await db
    .select({
      nodeId: nodePermissions.nodeId,
      userId: nodePermissions.userId,
      permission: nodePermissions.permission,
      username: user.username,
      name: user.name,
      email: user.email,
      createdAt: nodePermissions.createdAt,
    })
    .from(nodePermissions)
    .innerJoin(user, eq(user.id, nodePermissions.userId))
    .where(eq(nodePermissions.nodeId, nodeId))
    .orderBy(user.username)
  return ok(c, { shares: rows })
})

v1Routes.patch("/shares/:nodeId/:userId", async (c) => {
  const session = await requireSession(c.req.raw)
  const input = await parseJson(
    c,
    z.object({
      permission: z.enum(["viewer", "editor"]),
      mutationId: z.string().min(8),
    })
  )
  const nodeId = c.req.param("nodeId")
  const userId = c.req.param("userId")
  const existingResponse = await readMutationReceipt(
    session.user.id,
    input.mutationId
  )
  if (existingResponse) return ok(c, existingResponse)
  await requireNodeAccess(nodeId, session.user.id, "editor")
  const [updated] = await db
    .update(nodePermissions)
    .set({ permission: input.permission })
    .where(
      and(
        eq(nodePermissions.nodeId, nodeId),
        eq(nodePermissions.userId, userId)
      )
    )
    .returning()
  if (!updated) return fail(c, 404, "Share not found")
  await db.insert(auditEvents).values({
    id: createId("aud"),
    actorUserId: session.user.id,
    targetUserId: userId,
    nodeId,
    type: "share.updated",
    data: { permission: input.permission, mutationId: input.mutationId },
  })
  const response = { share: updated }
  await writeMutationReceipt(session.user.id, input.mutationId, response)
  return ok(c, response)
})

v1Routes.delete("/shares/:nodeId/:userId", async (c) => {
  const session = await requireSession(c.req.raw)
  const input = await parseJson(c, mutationOnlySchema)
  const nodeId = c.req.param("nodeId")
  const userId = c.req.param("userId")
  const existingResponse = await readMutationReceipt(
    session.user.id,
    input.mutationId
  )
  if (existingResponse) return ok(c, existingResponse)
  await requireNodeAccess(nodeId, session.user.id, "editor")
  await db
    .delete(nodePermissions)
    .where(
      and(
        eq(nodePermissions.nodeId, nodeId),
        eq(nodePermissions.userId, userId)
      )
    )
  await db.insert(auditEvents).values({
    id: createId("aud"),
    actorUserId: session.user.id,
    targetUserId: userId,
    nodeId,
    type: "share.revoked",
    data: { mutationId: input.mutationId },
  })
  const response = { nodeId, userId, revoked: true }
  await writeMutationReceipt(session.user.id, input.mutationId, response)
  return ok(c, response)
})

v1Routes.post("/public-links", async (c) => {
  const session = await requireSession(c.req.raw)
  const input = await parseJson(c, publicLinkSchema)
  const existingResponse = await readMutationReceipt(
    session.user.id,
    input.mutationId
  )
  if (existingResponse) return ok(c, existingResponse)
  const publicLinksEnabled = await readSetting(
    "sharing.publicLinksEnabled",
    true
  )
  if (!publicLinksEnabled) return fail(c, 403, "Public links are disabled")
  await requireNodeAccess(input.nodeId, session.user.id, "editor")
  const token = publicLinkToken()
  const tokenHash = await sha256Hex(token)
  const linkId = createId("plk")

  await db.insert(publicLinks).values({
    id: linkId,
    nodeId: input.nodeId,
    ownerId: session.user.id,
    tokenHash,
    passwordHash: input.password ? await sha256Hex(input.password) : null,
    expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
    maxDownloads: input.maxDownloads,
  })

  const response = { id: linkId, token }
  await writeMutationReceipt(session.user.id, input.mutationId, response)
  return created(c, response)
})

v1Routes.get("/public-links", async (c) => {
  const session = await requireSession(c.req.raw)
  const rows = await db
    .select()
    .from(publicLinks)
    .where(eq(publicLinks.ownerId, session.user.id))
    .orderBy(desc(publicLinks.createdAt))
  return ok(c, { publicLinks: rows })
})

v1Routes.get("/public/:token", async (c) => {
  const tokenHash = await sha256Hex(c.req.param("token"))
  const [link] = await db
    .select()
    .from(publicLinks)
    .where(
      and(
        eq(publicLinks.tokenHash, tokenHash),
        eq(publicLinks.status, "active")
      )
    )

  if (!link) return fail(c, 404, "Public link not found")
  if (link.expiresAt && link.expiresAt.getTime() < Date.now()) {
    return fail(c, 410, "Public link expired")
  }
  if (link.maxDownloads && link.downloadCount >= link.maxDownloads) {
    return fail(c, 410, "Public link download limit reached")
  }
  await assertPublicLinkPassword(
    c.req.header("x-public-link-password"),
    link.passwordHash
  )

  const [node] = await db.select().from(nodes).where(eq(nodes.id, link.nodeId))
  await recordPublicLinkAccess(c.req.raw, link.id, link.nodeId, "view.allowed")
  const children =
    node?.type === "folder"
      ? await db
          .select()
          .from(nodes)
          .where(and(eq(nodes.parentId, node.id), isNull(nodes.deletedAt)))
          .orderBy(nodes.type, nodes.name)
      : []
  return ok(c, { node, children })
})

v1Routes.get("/public/:token/download", async (c) => {
  const tokenHash = await sha256Hex(c.req.param("token"))
  const [link] = await db
    .select()
    .from(publicLinks)
    .where(
      and(
        eq(publicLinks.tokenHash, tokenHash),
        eq(publicLinks.status, "active")
      )
    )
  if (!link) return fail(c, 404, "Public link not found")
  if (link.expiresAt && link.expiresAt.getTime() < Date.now()) {
    return fail(c, 410, "Public link expired")
  }
  if (link.maxDownloads && link.downloadCount >= link.maxDownloads) {
    return fail(c, 410, "Public link download limit reached")
  }
  await assertPublicLinkPassword(
    c.req.header("x-public-link-password"),
    link.passwordHash
  )
  const [node] = await db.select().from(nodes).where(eq(nodes.id, link.nodeId))
  if (node?.type === "folder") {
    await db
      .update(publicLinks)
      .set({
        downloadCount: sql`${publicLinks.downloadCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(publicLinks.id, link.id))
    await recordPublicLinkAccess(c.req.raw, link.id, link.nodeId, "zip.allowed")
    return createFolderZipResponse(node)
  }
  if (node?.type !== "file" || !node.activeFileVersionId) {
    return fail(c, 404, "Downloadable file not found")
  }
  const [version] = await db
    .select()
    .from(fileVersions)
    .where(eq(fileVersions.id, node.activeFileVersionId))
  if (version?.status !== "complete") {
    return fail(c, 404, "Completed file version not found")
  }
  const settings = await loadS3SettingsFromDb()
  const url = await presignGetObject(
    createS3Client(settings),
    settings,
    version.objectKey
  )
  await db
    .update(publicLinks)
    .set({
      downloadCount: sql`${publicLinks.downloadCount} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(publicLinks.id, link.id))
  await recordPublicLinkAccess(
    c.req.raw,
    link.id,
    link.nodeId,
    "download.allowed"
  )
  return ok(c, { url, expiresInSeconds: 15 * 60 })
})

v1Routes.patch("/public-links/:id", async (c) => {
  const session = await requireSession(c.req.raw)
  const input = await parseJson(
    c,
    z.object({
      expiresAt: z.string().datetime().nullable().optional(),
      maxDownloads: z.number().int().positive().nullable().optional(),
      status: z.enum(["active", "disabled"]).optional(),
      mutationId: z.string().min(8),
    })
  )
  const existingResponse = await readMutationReceipt(
    session.user.id,
    input.mutationId
  )
  if (existingResponse) return ok(c, existingResponse)
  const [updated] = await db
    .update(publicLinks)
    .set({
      expiresAt:
        input.expiresAt === undefined
          ? undefined
          : input.expiresAt
            ? new Date(input.expiresAt)
            : null,
      maxDownloads: input.maxDownloads,
      status: input.status,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(publicLinks.id, c.req.param("id")),
        eq(publicLinks.ownerId, session.user.id)
      )
    )
    .returning()
  if (!updated) return fail(c, 404, "Public link not found")
  const response = { publicLink: updated }
  await writeMutationReceipt(session.user.id, input.mutationId, response)
  return ok(c, response)
})

v1Routes.delete("/public-links/:id", async (c) => {
  const session = await requireSession(c.req.raw)
  const input = await parseJson(c, mutationOnlySchema)
  const existingResponse = await readMutationReceipt(
    session.user.id,
    input.mutationId
  )
  if (existingResponse) return ok(c, existingResponse)
  const [updated] = await db
    .update(publicLinks)
    .set({ status: "disabled", updatedAt: new Date() })
    .where(
      and(
        eq(publicLinks.id, c.req.param("id")),
        eq(publicLinks.ownerId, session.user.id)
      )
    )
    .returning()
  if (!updated) return fail(c, 404, "Public link not found")
  await db.insert(auditEvents).values({
    id: createId("aud"),
    actorUserId: session.user.id,
    nodeId: updated.nodeId,
    type: "public_link.disabled",
    data: { publicLinkId: updated.id, mutationId: input.mutationId },
  })
  const response = { publicLink: updated }
  await writeMutationReceipt(session.user.id, input.mutationId, response)
  return ok(c, response)
})

v1Routes.get("/settings", async (c) => {
  await requireAdmin(c.req.raw)
  const rows = await db.select().from(appSettings)
  return ok(c, {
    settings: Object.fromEntries(
      rows.map((row) => [row.key, row.encrypted ? "[encrypted]" : row.value])
    ),
  })
})

v1Routes.post("/settings/test-s3", async (c) => {
  await requireAdmin(c.req.raw)
  const input = await parseJson(c, s3SettingsPatchSchema)
  const { testS3Connection } = await import("@shelf/storage")
  await testS3Connection(await mergedS3Settings(input.settings))
  return ok(c, { connected: true })
})

v1Routes.post("/settings/test-smtp", async (c) => {
  await requireAdmin(c.req.raw)
  const input = await parseJson(c, smtpSettingsPatchSchema)
  const settings = await mergedSmtpSettings(input.settings)
  const transporter = nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    auth: settings.user
      ? {
          user: settings.user,
          pass: settings.password,
        }
      : undefined,
  })
  await transporter.verify()
  return ok(c, { connected: true })
})

v1Routes.patch("/settings", async (c) => {
  const session = await requireAdmin(c.req.raw)
  const input = await parseJson(c, settingsUpdateSchema)
  const existingResponse = await readMutationReceipt(
    session.user.id,
    input.mutationId
  )
  if (existingResponse) return ok(c, existingResponse)
  await db.transaction(async (tx) => {
    for (const [key, value] of Object.entries(input.settings)) {
      const prepared = await prepareSettingValue(key, value)
      await tx
        .insert(appSettings)
        .values({
          key,
          value: prepared.value,
          encrypted: prepared.encrypted,
          updatedByUserId: session.user.id,
        })
        .onConflictDoUpdate({
          target: appSettings.key,
          set: {
            value: prepared.value,
            encrypted: prepared.encrypted,
            updatedByUserId: session.user.id,
            updatedAt: new Date(),
          },
        })
    }
    await tx.insert(auditEvents).values({
      id: createId("aud"),
      actorUserId: session.user.id,
      type: "settings.updated",
      data: { keys: Object.keys(input.settings), mutationId: input.mutationId },
    })
  })
  const response = { updated: Object.keys(input.settings) }
  await writeMutationReceipt(session.user.id, input.mutationId, response)
  return ok(c, response)
})

v1Routes.get("/quotas/me", async (c) => {
  const session = await requireSession(c.req.raw)
  const [usage] = await db
    .select()
    .from(storageUsage)
    .where(eq(storageUsage.userId, session.user.id))
  const [quota] = await db
    .select()
    .from(quotas)
    .where(eq(quotas.userId, session.user.id))
  return ok(c, {
    usage,
    quotaBytes:
      quota?.quotaBytes ??
      session.user.storageQuotaBytes ??
      (await readSetting<number>(
        "storage.defaultUserQuotaBytes",
        10 * 1024 * 1024 * 1024
      )),
  })
})

v1Routes.patch("/admin/users/:id/quota", async (c) => {
  const session = await requireAdmin(c.req.raw)
  const input = await parseJson(
    c,
    z.object({
      quotaBytes: z.number().int().positive(),
      mutationId: z.string().min(8),
    })
  )
  const targetUserId = c.req.param("id")
  const existingResponse = await readMutationReceipt(
    session.user.id,
    input.mutationId
  )
  if (existingResponse) return ok(c, existingResponse)
  await db
    .insert(quotas)
    .values({
      userId: targetUserId,
      quotaBytes: input.quotaBytes,
      updatedByUserId: session.user.id,
    })
    .onConflictDoUpdate({
      target: quotas.userId,
      set: {
        quotaBytes: input.quotaBytes,
        updatedByUserId: session.user.id,
        updatedAt: new Date(),
      },
    })
  await db.insert(auditEvents).values({
    id: createId("aud"),
    actorUserId: session.user.id,
    targetUserId,
    type: "quota.updated",
    data: { quotaBytes: input.quotaBytes, mutationId: input.mutationId },
  })
  const response = { userId: targetUserId, quotaBytes: input.quotaBytes }
  await writeMutationReceipt(session.user.id, input.mutationId, response)
  return ok(c, response)
})

v1Routes.get("/profile", async (c) => {
  const session = await requireSession(c.req.raw)
  return ok(c, { user: session.user })
})

v1Routes.patch("/profile", async (c) => {
  const session = await requireSession(c.req.raw)
  const input = await parseJson(c, profileUpdateSchema)
  const existingResponse = await readMutationReceipt(
    session.user.id,
    input.mutationId
  )
  if (existingResponse) return ok(c, existingResponse)
  const [updated] = await db.transaction(async (tx) => {
    const rows = await tx
      .update(user)
      .set({
        name: input.name,
        preferences: input.preferences,
        updatedAt: new Date(),
      })
      .where(eq(user.id, session.user.id))
      .returning()
    await tx.insert(auditEvents).values({
      id: createId("aud"),
      actorUserId: session.user.id,
      targetUserId: session.user.id,
      type: "profile.updated",
      data: { mutationId: input.mutationId },
    })
    return rows
  })
  const response = { user: updated }
  await writeMutationReceipt(session.user.id, input.mutationId, response)
  return ok(c, response)
})

v1Routes.post("/profile/username", async (c) => {
  const session = await requireSession(c.req.raw)
  const input = await parseJson(c, usernameChangeSchema)
  const existingResponse = await readMutationReceipt(
    session.user.id,
    input.mutationId
  )
  if (existingResponse) return ok(c, existingResponse)
  const lastChanged = session.user.usernameChangedAt
  const cooldownMs = 365 * 24 * 60 * 60 * 1000
  if (
    lastChanged &&
    Date.now() - new Date(lastChanged).getTime() < cooldownMs
  ) {
    return fail(c, 429, "Username can only be changed once every 365 days")
  }
  const result = await changeUsername({
    actorUserId: session.user.id,
    targetUserId: session.user.id,
    username: input.username,
    mutationId: input.mutationId,
    auditType: "username.changed",
  })
  if (result.status === "not_found") return fail(c, 404, "User not found")
  if (result.status === "reserved") return fail(c, 409, "Username is reserved")
  const response = { username: input.username }
  await writeMutationReceipt(session.user.id, input.mutationId, response)
  return ok(c, response)
})

v1Routes.post("/profile/avatar/upload-session", async (c) => {
  const session = await requireSession(c.req.raw)
  const input = await parseJson(c, avatarUploadSchema)
  const existingResponse = await readMutationReceipt(
    session.user.id,
    input.mutationId
  )
  if (existingResponse) return ok(c, existingResponse)
  const settings = await loadS3SettingsFromDb()
  const client = createS3Client(settings)
  const id = createId("avu")
  const objectKey = `avatars/${session.user.id}/${createId("ava")}`
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000)
  const url = await presignSinglePutUpload(client, settings, {
    objectKey,
    contentType: input.mimeType,
    sizeBytes: input.sizeBytes,
  })
  await db.insert(avatarUploadSessions).values({
    id,
    userId: session.user.id,
    objectKey,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    expiresAt,
    mutationId: input.mutationId,
  })
  const response = {
    uploadSessionId: id,
    url,
    expiresAt: expiresAt.toISOString(),
  }
  await writeMutationReceipt(session.user.id, input.mutationId, response)
  return created(c, response)
})

v1Routes.post("/profile/avatar/:id/complete", async (c) => {
  const session = await requireSession(c.req.raw)
  const input = await parseJson(c, mutationOnlySchema)
  const id = c.req.param("id")
  const existingResponse = await readMutationReceipt(
    session.user.id,
    input.mutationId
  )
  if (existingResponse) return ok(c, existingResponse)
  const [upload] = await db
    .select()
    .from(avatarUploadSessions)
    .where(
      and(
        eq(avatarUploadSessions.id, id),
        eq(avatarUploadSessions.userId, session.user.id),
        eq(avatarUploadSessions.status, "pending")
      )
    )
  if (!upload) return fail(c, 404, "Avatar upload session not found")
  if (upload.expiresAt.getTime() < Date.now()) {
    await db
      .update(avatarUploadSessions)
      .set({ status: "expired" })
      .where(eq(avatarUploadSessions.id, id))
    return fail(c, 410, "Avatar upload session expired")
  }
  const settings = await loadS3SettingsFromDb()
  const metadata = await headObject(
    createS3Client(settings),
    settings,
    upload.objectKey
  )
  if (metadata.ContentLength !== upload.sizeBytes) {
    return fail(c, 422, "Uploaded avatar size does not match session size")
  }
  await db.transaction(async (tx) => {
    await tx
      .update(avatarUploadSessions)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(avatarUploadSessions.id, id))
    await tx
      .update(user)
      .set({ image: upload.objectKey, updatedAt: new Date() })
      .where(eq(user.id, session.user.id))
    await tx.insert(auditEvents).values({
      id: createId("aud"),
      actorUserId: session.user.id,
      targetUserId: session.user.id,
      type: "avatar.updated",
      data: { objectKey: upload.objectKey, mutationId: input.mutationId },
    })
  })
  await maintenanceQueue.add("images.generateThumbnail", {
    avatarUploadSessionId: id,
    userId: session.user.id,
    objectKey: upload.objectKey,
    mimeType: upload.mimeType,
    requestId: c.var.requestId,
  })
  const response = { image: upload.objectKey }
  await writeMutationReceipt(session.user.id, input.mutationId, response)
  return ok(c, response)
})

v1Routes.get("/admin/users", async (c) => {
  await requireAdmin(c.req.raw)
  const rows = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      username: user.username,
      role: user.role,
      disabledAt: user.disabledAt,
      usedBytes: storageUsage.usedBytes,
      reservedBytes: storageUsage.reservedBytes,
      trashBytes: storageUsage.trashBytes,
    })
    .from(user)
    .leftJoin(storageUsage, eq(storageUsage.userId, user.id))
  return ok(c, { users: rows })
})

v1Routes.post("/admin/users/:id/suspend", async (c) => {
  const session = await requireAdmin(c.req.raw)
  const input = await parseJson(c, mutationOnlySchema)
  const targetUserId = c.req.param("id")
  const existingResponse = await readMutationReceipt(
    session.user.id,
    input.mutationId
  )
  if (existingResponse) return ok(c, existingResponse)
  if (targetUserId === session.user.id) {
    return fail(c, 409, "Admins cannot suspend themselves")
  }
  await db
    .update(user)
    .set({ disabledAt: new Date() })
    .where(eq(user.id, targetUserId))
  await db.insert(auditEvents).values({
    id: createId("aud"),
    actorUserId: session.user.id,
    targetUserId,
    type: "user.suspended",
    data: { mutationId: input.mutationId },
  })
  const response = { userId: targetUserId, disabled: true }
  await writeMutationReceipt(session.user.id, input.mutationId, response)
  return ok(c, response)
})

v1Routes.post("/admin/users/:id/restore", async (c) => {
  const session = await requireAdmin(c.req.raw)
  const input = await parseJson(c, mutationOnlySchema)
  const targetUserId = c.req.param("id")
  const existingResponse = await readMutationReceipt(
    session.user.id,
    input.mutationId
  )
  if (existingResponse) return ok(c, existingResponse)
  await db
    .update(user)
    .set({ disabledAt: null, banned: false, banReason: null, banExpires: null })
    .where(eq(user.id, targetUserId))
  await db.insert(auditEvents).values({
    id: createId("aud"),
    actorUserId: session.user.id,
    targetUserId,
    type: "user.restored",
    data: { mutationId: input.mutationId },
  })
  const response = { userId: targetUserId, disabled: false }
  await writeMutationReceipt(session.user.id, input.mutationId, response)
  return ok(c, response)
})

v1Routes.post("/admin/users/:id/promote", async (c) => {
  const session = await requireAdmin(c.req.raw)
  const input = await parseJson(c, mutationOnlySchema)
  const targetUserId = c.req.param("id")
  const existingResponse = await readMutationReceipt(
    session.user.id,
    input.mutationId
  )
  if (existingResponse) return ok(c, existingResponse)
  await db.update(user).set({ role: "admin" }).where(eq(user.id, targetUserId))
  await db.insert(auditEvents).values({
    id: createId("aud"),
    actorUserId: session.user.id,
    targetUserId,
    type: "user.promoted",
    data: { mutationId: input.mutationId },
  })
  const response = { userId: targetUserId, role: "admin" }
  await writeMutationReceipt(session.user.id, input.mutationId, response)
  return ok(c, response)
})

v1Routes.post("/admin/users/:id/demote", async (c) => {
  const session = await requireAdmin(c.req.raw)
  const input = await parseJson(c, mutationOnlySchema)
  const targetUserId = c.req.param("id")
  const existingResponse = await readMutationReceipt(
    session.user.id,
    input.mutationId
  )
  if (existingResponse) return ok(c, existingResponse)
  if (targetUserId === session.user.id) {
    return fail(c, 409, "Admins cannot demote themselves")
  }
  await db.update(user).set({ role: "user" }).where(eq(user.id, targetUserId))
  await db.insert(auditEvents).values({
    id: createId("aud"),
    actorUserId: session.user.id,
    targetUserId,
    type: "user.demoted",
    data: { mutationId: input.mutationId },
  })
  const response = { userId: targetUserId, role: "user" }
  await writeMutationReceipt(session.user.id, input.mutationId, response)
  return ok(c, response)
})

v1Routes.post("/admin/users/:id/username", async (c) => {
  const session = await requireAdmin(c.req.raw)
  const input = await parseJson(c, usernameChangeSchema)
  const existingResponse = await readMutationReceipt(
    session.user.id,
    input.mutationId
  )
  if (existingResponse) return ok(c, existingResponse)
  const result = await changeUsername({
    actorUserId: session.user.id,
    targetUserId: c.req.param("id"),
    username: input.username,
    mutationId: input.mutationId,
    auditType: "username.admin_overridden",
  })
  if (result.status === "not_found") return fail(c, 404, "User not found")
  if (result.status === "reserved") return fail(c, 409, "Username is reserved")
  const response = { userId: c.req.param("id"), username: input.username }
  await writeMutationReceipt(session.user.id, input.mutationId, response)
  return ok(c, response)
})

v1Routes.get("/admin/owner-transfer/:id/eligibility", async (c) => {
  const session = await requireSession(c.req.raw)
  if (session.user.role !== "owner")
    return fail(c, 403, "Owner access required")
  const [target] = await db
    .select()
    .from(user)
    .where(eq(user.id, c.req.param("id")))
  return ok(c, {
    eligible: Boolean(target && !target.disabledAt && !target.banned),
    targetUserId: c.req.param("id"),
  })
})

v1Routes.post("/admin/owner-transfer/:id", async (c) => {
  const session = await requireSession(c.req.raw)
  if (session.user.role !== "owner")
    return fail(c, 403, "Owner access required")
  const input = await parseJson(
    c,
    z.object({
      confirmation: z.literal("transfer owner"),
      mutationId: z.string().min(8),
    })
  )
  const targetUserId = c.req.param("id")
  const existingResponse = await readMutationReceipt(
    session.user.id,
    input.mutationId
  )
  if (existingResponse) return ok(c, existingResponse)
  const [target] = await db.select().from(user).where(eq(user.id, targetUserId))
  if (!target || target.disabledAt || target.banned) {
    return fail(c, 409, "Target user is not eligible for owner transfer")
  }
  await db.transaction(async (tx) => {
    await tx
      .update(user)
      .set({ role: "admin" })
      .where(eq(user.id, session.user.id))
    await tx
      .update(user)
      .set({ role: "owner" })
      .where(eq(user.id, targetUserId))
    await tx.insert(auditEvents).values({
      id: createId("aud"),
      actorUserId: session.user.id,
      targetUserId,
      type: "owner.transferred",
      data: { mutationId: input.mutationId },
    })
  })
  const response = { ownerUserId: targetUserId }
  await writeMutationReceipt(session.user.id, input.mutationId, response)
  return ok(c, response)
})

v1Routes.post("/admin/invites", async (c) => {
  const session = await requireAdmin(c.req.raw)
  const input = await parseJson(
    c,
    z.object({
      email: z.email(),
      role: z.enum(["admin", "user"]).default("user"),
      mutationId: z.string().min(8),
    })
  )
  const existingResponse = await readMutationReceipt(
    session.user.id,
    input.mutationId
  )
  if (existingResponse) return ok(c, existingResponse)
  const token = publicLinkToken()
  const id = createId("inv")
  await db.insert(invites).values({
    id,
    email: input.email,
    role: input.role,
    tokenHash: await sha256Hex(token),
    invitedByUserId: session.user.id,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  })
  const publicAppUrl = await readSetting("app.publicUrl", "")
  const inviteUrl = publicAppUrl
    ? `${publicAppUrl.replace(/\/$/, "")}/?invite=${encodeURIComponent(token)}&email=${encodeURIComponent(input.email)}`
    : token
  await maintenanceQueue.add("email.invite", {
    to: input.email,
    subject: "You have been invited to Shelf",
    text: `You have been invited to Shelf. Use this invite token to sign up: ${token}\n\n${inviteUrl}`,
  })
  await db.insert(auditEvents).values({
    id: createId("aud"),
    actorUserId: session.user.id,
    type: "invite.created",
    data: { inviteId: id, mutationId: input.mutationId },
  })
  const response = { id, token }
  await writeMutationReceipt(session.user.id, input.mutationId, response)
  return created(c, response)
})

v1Routes.get("/admin/invites", async (c) => {
  await requireAdmin(c.req.raw)
  const rows = await db.select().from(invites).orderBy(desc(invites.createdAt))
  return ok(c, { invites: rows })
})

v1Routes.post("/admin/invites/:id/revoke", async (c) => {
  const session = await requireAdmin(c.req.raw)
  const input = await parseJson(c, mutationOnlySchema)
  const inviteId = c.req.param("id")
  const existingResponse = await readMutationReceipt(
    session.user.id,
    input.mutationId
  )
  if (existingResponse) return ok(c, existingResponse)
  const [invite] = await db
    .update(invites)
    .set({ revokedAt: new Date() })
    .where(eq(invites.id, inviteId))
    .returning()
  if (!invite) return fail(c, 404, "Invite not found")
  await db.insert(auditEvents).values({
    id: createId("aud"),
    actorUserId: session.user.id,
    type: "invite.revoked",
    data: { inviteId, mutationId: input.mutationId },
  })
  const response = { invite }
  await writeMutationReceipt(session.user.id, input.mutationId, response)
  return ok(c, response)
})

v1Routes.get("/admin/diagnostics", async (c) => {
  await requireAdmin(c.req.raw)
  const jobCounts = await maintenanceQueue.getJobCounts(
    "waiting",
    "active",
    "delayed",
    "failed",
    "completed"
  )
  const failedJobs = await maintenanceQueue.getFailed(0, 10)
  return ok(c, {
    version: "1.0.0-rc.1",
    queueDepth:
      (jobCounts.waiting ?? 0) +
      (jobCounts.active ?? 0) +
      (jobCounts.delayed ?? 0),
    jobCounts,
    failedJobs: failedJobs.map((job) => ({
      id: job.id,
      name: job.name,
      failedReason: job.failedReason,
      attemptsMade: job.attemptsMade,
      timestamp: job.timestamp,
    })),
    database: "configured",
    redis: "configured",
    s3: "configured",
  })
})

v1Routes.get("/audit", async (c) => {
  await requireAdmin(c.req.raw)
  const rows = await db
    .select()
    .from(auditEvents)
    .orderBy(desc(auditEvents.createdAt))
    .limit(100)
  return ok(c, { events: rows })
})
