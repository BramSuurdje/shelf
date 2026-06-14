import { ulid } from "ulid"
import { z } from "zod"

export const userRoleSchema = z.enum(["owner", "admin", "user"])
export type UserRole = z.infer<typeof userRoleSchema>

export const registrationModeSchema = z.enum(["invite_only", "open", "disabled"])
export type RegistrationMode = z.infer<typeof registrationModeSchema>

export const nodeTypeSchema = z.enum(["file", "folder"])
export type NodeType = z.infer<typeof nodeTypeSchema>

export const nodePermissionSchema = z.enum(["viewer", "editor"])
export type NodePermission = z.infer<typeof nodePermissionSchema>

export const fileVersionStatusSchema = z.enum([
  "pending",
  "complete",
  "failed",
  "deleted",
])
export type FileVersionStatus = z.infer<typeof fileVersionStatusSchema>

export const scanStatusSchema = z.enum(["not_required", "pending", "clean", "failed"])
export type ScanStatus = z.infer<typeof scanStatusSchema>

export const uploadKindSchema = z.enum(["single", "multipart"])
export type UploadKind = z.infer<typeof uploadKindSchema>

export const uploadStatusSchema = z.enum([
  "pending",
  "uploading",
  "completed",
  "aborted",
  "expired",
  "failed",
])
export type UploadStatus = z.infer<typeof uploadStatusSchema>

export const settingKeySchema = z.enum([
  "app.name",
  "app.publicUrl",
  "registration.mode",
  "registration.defaultRole",
  "storage.endpoint",
  "storage.region",
  "storage.bucket",
  "storage.forcePathStyle",
  "storage.publicBaseUrl",
  "storage.multipartThresholdBytes",
  "storage.maxFileSizeBytes",
  "storage.globalQuotaBytes",
  "storage.defaultUserQuotaBytes",
  "sharing.publicLinksEnabled",
  "sharing.defaultPublicLinkExpirationDays",
  "sharing.maxPublicLinkExpirationDays",
  "sharing.folderSharingEnabled",
  "security.emailVerificationRequired",
  "security.passwordMinLength",
  "security.sessionLifetimeDays",
  "maintenance.trashRetentionDays",
  "maintenance.pendingUploadExpirationMinutes",
  "maintenance.thumbnailsEnabled",
  "smtp.enabled",
  "smtp.host",
  "smtp.port",
  "smtp.secure",
  "smtp.user",
  "smtp.from",
  "oauth.githubEnabled",
  "oauth.googleEnabled",
])
export type SettingKey = z.infer<typeof settingKeySchema>

export const usernameSchema = z
  .string()
  .min(3)
  .max(32)
  .regex(/^[a-z0-9_]{3,32}$/)

export const mutationSchema = z.object({
  mutationId: z.string().min(8),
  deviceId: z.string().min(8).optional(),
})

export const nodeMutationSchema = mutationSchema.extend({
  baseNodeRevision: z.number().int().positive().optional(),
})

export const createFolderSchema = nodeMutationSchema.extend({
  parentId: z.string().nullable(),
  name: z.string().min(1).max(255),
})

export const uploadSessionSchema = mutationSchema.extend({
  parentId: z.string().nullable(),
  fileName: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(255),
  sizeBytes: z.number().int().positive(),
  checksumSha256: z.string().optional(),
})

export const completeUploadSchema = mutationSchema.extend({
  uploadSessionId: z.string(),
  eTag: z.string().optional(),
  checksumSha256: z.string().optional(),
  parts: z
    .array(
      z.object({
        partNumber: z.number().int().positive(),
        eTag: z.string().min(1),
      })
    )
    .optional(),
})

export const setupSchema = z.object({
  mutationId: z.string().min(8),
  appName: z.string().min(1).default("Shelf"),
  publicAppUrl: z.url(),
  owner: z.object({
    name: z.string().min(1),
    email: z.email(),
    username: usernameSchema,
    password: z.string().min(10),
  }),
  storage: z.object({
    endpoint: z.url(),
    region: z.string().min(1),
    bucket: z.string().min(1),
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(1),
    forcePathStyle: z.boolean(),
    publicBaseUrl: z.url().optional().or(z.literal("")),
  }),
  quotas: z.object({
    defaultUserQuotaBytes: z.number().int().positive(),
    globalQuotaBytes: z.number().int().positive().optional(),
  }),
  registrationMode: registrationModeSchema.default("invite_only"),
  oauth: z.object({
    githubEnabled: z.boolean(),
    googleEnabled: z.boolean(),
  }),
  smtpEnabled: z.boolean(),
})

export function createId(prefix: string) {
  return `${prefix}_${ulid()}`
}

export function eventCursor() {
  return ulid()
}

export function publicLinkToken() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export async function sha256Hex(value: string) {
  const data = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest("SHA-256", data)
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}
