import { openSecret } from "@shelf/config"
import { db, loadS3SettingsFromDb } from "@shelf/db"
import {
  appSettings,
  fileVersions,
  nodes,
  storageUsage,
  uploadSessions,
  user,
} from "@shelf/db/schema"
import { createWorker, maintenanceQueue } from "@shelf/jobs"
import { logger } from "@shelf/logger"
import {
  abortMultipartUpload,
  createS3Client,
  createThumbnailObjectKey,
  deleteObject,
  getObjectStream,
  putObjectBytes,
} from "@shelf/storage"
import { and, eq, lt, sql } from "drizzle-orm"
import nodemailer from "nodemailer"
import sharp from "sharp"

async function readSetting<T>(key: string, fallback: T): Promise<T> {
  const [row] = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, key))
  return (row?.value as T | undefined) ?? fallback
}

async function readSecretSetting(key: string) {
  const [row] = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, key))
  if (typeof row?.value !== "string") return undefined
  return row.encrypted ? openSecret(row.value) : row.value
}

async function sendEmail(data: unknown) {
  const payload = data as {
    to?: string
    subject?: string
    text?: string
    html?: string
  }
  if (!payload.to || !payload.subject || !payload.text) {
    throw new Error("Email job is missing to, subject, or text")
  }

  const enabled = await readSetting("smtp.enabled", false)
  const host = await readSetting<string | null>("smtp.host", null)
  const from = await readSetting<string | null>("smtp.from", null)
  if (!enabled || !host || !from) {
    logger.info("Email job accepted in dev logging mode", { data: payload })
    return { sent: false, mode: "dev-log" }
  }

  const userName = await readSetting<string | null>("smtp.user", null)
  const password = await readSecretSetting("smtp.password")
  const transporter = nodemailer.createTransport({
    host,
    port: await readSetting("smtp.port", 587),
    secure: await readSetting("smtp.secure", false),
    auth: userName
      ? {
          user: userName,
          pass: password,
        }
      : undefined,
  })

  const info = await transporter.sendMail({
    from,
    to: payload.to,
    subject: payload.subject,
    text: payload.text,
    html: payload.html,
  })
  return { sent: true, messageId: info.messageId }
}

const worker = createWorker(async (job) => {
  const log = logger
  log.info("Processing worker job", { jobId: job.id, name: job.name })

  switch (job.name) {
    case "uploads.expireIncomplete": {
      const expired = await db
        .update(uploadSessions)
        .set({ status: "expired", updatedAt: new Date() })
        .where(
          and(
            lt(uploadSessions.expiresAt, new Date()),
            eq(uploadSessions.status, "pending")
          )
        )
        .returning()

      for (const upload of expired) {
        await db
          .update(storageUsage)
          .set({
            reservedBytes: sql`${storageUsage.reservedBytes} - ${upload.reservedBytes}`,
            updatedAt: new Date(),
          })
          .where(eq(storageUsage.userId, upload.ownerId))
      }

      return { expired: expired.length }
    }

    case "uploads.abortStaleMultipart": {
      const settings = await loadS3SettingsFromDb()
      const client = createS3Client(settings)
      const stale = await db
        .select()
        .from(uploadSessions)
        .where(
          and(
            lt(uploadSessions.expiresAt, new Date()),
            eq(uploadSessions.status, "expired")
          )
        )

      for (const upload of stale) {
        if (upload.multipartUploadId) {
          await abortMultipartUpload(client, settings, {
            objectKey: upload.objectKey,
            uploadId: upload.multipartUploadId,
          })
        }
      }

      return { aborted: stale.length }
    }

    case "trash.purgeExpired": {
      const retentionDays = await readSetting(
        "maintenance.trashRetentionDays",
        30
      )
      const retentionDate = new Date(
        Date.now() - retentionDays * 24 * 60 * 60 * 1000
      )
      const settings = await loadS3SettingsFromDb()
      const client = createS3Client(settings)
      const trashed = await db
        .select({ node: nodes, version: fileVersions })
        .from(nodes)
        .leftJoin(fileVersions, eq(fileVersions.nodeId, nodes.id))
        .where(lt(nodes.deletedAt, retentionDate))

      for (const row of trashed) {
        if (row.version?.objectKey) {
          await deleteObject(client, settings, row.version.objectKey)
        }
      }
      const purgedNodeIds = Array.from(
        new Set(trashed.map((row) => row.node.id))
      )
      for (const nodeId of purgedNodeIds) {
        await db.delete(nodes).where(eq(nodes.id, nodeId))
      }

      return { purged: purgedNodeIds.length }
    }

    case "quotas.recalculate":
      await db.execute(sql`
        insert into storage_usage (user_id, used_bytes, reserved_bytes, trash_bytes, recalculated_at, updated_at)
        select owner_id,
          coalesce(sum(size_bytes) filter (where deleted_at is null), 0),
          0,
          coalesce(sum(size_bytes) filter (where deleted_at is not null), 0),
          now(),
          now()
        from nodes
        where type = 'file'
        group by owner_id
        on conflict (user_id) do update set
          used_bytes = excluded.used_bytes,
          trash_bytes = excluded.trash_bytes,
          recalculated_at = excluded.recalculated_at,
          updated_at = excluded.updated_at
      `)
      return { recalculated: true }

    case "images.generateThumbnail": {
      const data = job.data as {
        fileVersionId?: string
        avatarUploadSessionId?: string
        userId?: string
        objectKey?: string
        mimeType?: string
      }
      let objectKey = data.objectKey
      let mimeType = data.mimeType
      let thumbnailSubjectId = data.avatarUploadSessionId

      if (data.fileVersionId) {
        const [version] = await db
          .select()
          .from(fileVersions)
          .where(eq(fileVersions.id, data.fileVersionId))
        if (!version) return { skipped: "missing file version" }
        objectKey = version.objectKey
        mimeType = version.mimeType
        thumbnailSubjectId = version.id
        await db
          .update(fileVersions)
          .set({ thumbnailStatus: "processing" })
          .where(eq(fileVersions.id, version.id))
      }

      if (
        !objectKey ||
        !mimeType?.startsWith("image/") ||
        !thumbnailSubjectId
      ) {
        return { skipped: "not an image" }
      }
      const settings = await loadS3SettingsFromDb()
      const client = createS3Client(settings)
      const object = await getObjectStream(client, settings, objectKey)
      if (!object.Body) throw new Error("S3 object has no body")
      const input = await new Response(object.Body as BodyInit).arrayBuffer()
      const output = await sharp(Buffer.from(input))
        .rotate()
        .resize(256, 256, { fit: "cover" })
        .webp({ quality: 82 })
        .toBuffer()
      const thumbnailObjectKey = createThumbnailObjectKey(thumbnailSubjectId)
      await putObjectBytes(client, settings, {
        objectKey: thumbnailObjectKey,
        body: output,
        contentType: "image/webp",
      })
      if (data.fileVersionId) {
        await db
          .update(fileVersions)
          .set({ thumbnailStatus: "complete", thumbnailObjectKey })
          .where(eq(fileVersions.id, data.fileVersionId))
      }
      if (data.userId) {
        await db
          .update(user)
          .set({ image: thumbnailObjectKey, updatedAt: new Date() })
          .where(eq(user.id, data.userId))
      }
      return { thumbnailObjectKey }
    }

    case "email.passwordReset":
    case "email.verification":
    case "email.invite":
      return sendEmail(job.data)

    case "jobs.recordFailure":
      return { recorded: true }
  }
})

worker.on("failed", (job, error) => {
  logger.error("Worker job failed", {
    jobId: job?.id,
    name: job?.name,
    error: error.message,
  })
})

await maintenanceQueue.upsertJobScheduler(
  "uploads-expire-incomplete",
  {
    every: 60_000,
  },
  {
    name: "uploads.expireIncomplete",
    data: {},
  }
)

await maintenanceQueue.upsertJobScheduler(
  "uploads-abort-stale-multipart",
  {
    every: 300_000,
  },
  {
    name: "uploads.abortStaleMultipart",
    data: {},
  }
)

await maintenanceQueue.upsertJobScheduler(
  "trash-purge-expired",
  {
    every: 3_600_000,
  },
  {
    name: "trash.purgeExpired",
    data: {},
  }
)

await maintenanceQueue.upsertJobScheduler(
  "quotas-recalculate",
  {
    every: 3_600_000,
  },
  {
    name: "quotas.recalculate",
    data: {},
  }
)

logger.info("Shelf worker started")
