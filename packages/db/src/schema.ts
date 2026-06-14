import { sql } from "drizzle-orm"
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core"

export const roleEnum = pgEnum("user_role", ["owner", "admin", "user"])
export const registrationModeEnum = pgEnum("registration_mode", [
  "invite_only",
  "open",
  "disabled",
])
export const nodeTypeEnum = pgEnum("node_type", ["file", "folder"])
export const permissionEnum = pgEnum("node_permission", ["viewer", "editor"])
export const fileVersionStatusEnum = pgEnum("file_version_status", [
  "pending",
  "complete",
  "failed",
  "deleted",
])
export const scanStatusEnum = pgEnum("scan_status", [
  "not_required",
  "pending",
  "clean",
  "failed",
])
export const uploadKindEnum = pgEnum("upload_kind", ["single", "multipart"])
export const uploadStatusEnum = pgEnum("upload_status", [
  "pending",
  "uploading",
  "completed",
  "aborted",
  "expired",
  "failed",
])
export const publicLinkStatusEnum = pgEnum("public_link_status", [
  "active",
  "disabled",
  "expired",
])

export const user = pgTable(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    username: text("username").notNull().unique(),
    displayUsername: text("display_username"),
    usernameChangedAt: timestamp("username_changed_at", { withTimezone: true }),
    role: roleEnum("role").notNull().default("user"),
    banned: boolean("banned").notNull().default(false),
    banReason: text("ban_reason"),
    banExpires: timestamp("ban_expires", { withTimezone: true }),
    storageQuotaBytes: bigint("storage_quota_bytes", { mode: "number" }),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    onboardingCompletedAt: timestamp("onboarding_completed_at", {
      withTimezone: true,
    }),
    preferences: jsonb("preferences").$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => ({
    usernameIdx: index("user_username_idx").on(table.username),
    roleIdx: index("user_role_idx").on(table.role),
  })
)

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
})

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
    withTimezone: true,
  }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

export const usernameHistory = pgTable(
  "username_history",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    username: text("username").notNull(),
    reservedUntil: timestamp("reserved_until", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    usernameUnique: unique("username_history_username_unique").on(table.username),
  })
)

export const devices = pgTable("devices", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export const nodes = pgTable(
  "nodes",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    parentId: text("parent_id"),
    type: nodeTypeEnum("type").notNull(),
    name: text("name").notNull(),
    revision: integer("revision").notNull().default(1),
    activeFileVersionId: text("active_file_version_id"),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
    mimeType: text("mime_type"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    tombstoneAt: timestamp("tombstone_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    ownerIdx: index("nodes_owner_idx").on(table.ownerId),
    parentIdx: index("nodes_parent_idx").on(table.parentId),
    siblingUnique: uniqueIndex("nodes_owner_parent_name_active_unique").on(
      table.ownerId,
      sql`coalesce(${table.parentId}, '')`,
      table.name
    ).where(sql`${table.deletedAt} is null`),
  })
)

export const fileVersions = pgTable(
  "file_versions",
  {
    id: text("id").primaryKey(),
    nodeId: text("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    objectKey: text("object_key").notNull().unique(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    mimeType: text("mime_type").notNull(),
    checksumSha256: text("checksum_sha256"),
    eTag: text("etag"),
    status: fileVersionStatusEnum("status").notNull().default("pending"),
    scanStatus: scanStatusEnum("scan_status").notNull().default("not_required"),
    thumbnailObjectKey: text("thumbnail_object_key"),
    thumbnailStatus: text("thumbnail_status").notNull().default("not_required"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    nodeIdx: index("file_versions_node_idx").on(table.nodeId),
  })
)

export const nodePermissions = pgTable(
  "node_permissions",
  {
    nodeId: text("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    permission: permissionEnum("permission").notNull(),
    inheritedFromNodeId: text("inherited_from_node_id"),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.nodeId, table.userId] }),
  })
)

export const publicLinks = pgTable(
  "public_links",
  {
    id: text("id").primaryKey(),
    nodeId: text("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    passwordHash: text("password_hash"),
    status: publicLinkStatusEnum("status").notNull().default("active"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    maxDownloads: integer("max_downloads"),
    downloadCount: integer("download_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    ownerIdx: index("public_links_owner_idx").on(table.ownerId),
  })
)

export const uploadSessions = pgTable(
  "upload_sessions",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    nodeId: text("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    fileVersionId: text("file_version_id")
      .notNull()
      .references(() => fileVersions.id, { onDelete: "cascade" }),
    objectKey: text("object_key").notNull(),
    kind: uploadKindEnum("kind").notNull(),
    status: uploadStatusEnum("status").notNull().default("pending"),
    multipartUploadId: text("multipart_upload_id"),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    reservedBytes: bigint("reserved_bytes", { mode: "number" }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    mutationId: text("mutation_id").notNull(),
    deviceId: text("device_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    mutationUnique: unique("upload_sessions_owner_mutation_unique").on(
      table.ownerId,
      table.mutationId
    ),
    ownerStatusIdx: index("upload_sessions_owner_status_idx").on(
      table.ownerId,
      table.status
    ),
  })
)

export const avatarUploadSessions = pgTable(
  "avatar_upload_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    objectKey: text("object_key").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    status: uploadStatusEnum("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    mutationId: text("mutation_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    mutationUnique: unique("avatar_upload_sessions_user_mutation_unique").on(
      table.userId,
      table.mutationId
    ),
  })
)

export const multipartUploadParts = pgTable(
  "multipart_upload_parts",
  {
    uploadSessionId: text("upload_session_id")
      .notNull()
      .references(() => uploadSessions.id, { onDelete: "cascade" }),
    partNumber: integer("part_number").notNull(),
    eTag: text("etag"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.uploadSessionId, table.partNumber] }),
  })
)

export const nodeEvents = pgTable(
  "node_events",
  {
    id: text("id").primaryKey(),
    cursor: text("cursor").notNull().unique(),
    nodeId: text("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    deviceId: text("device_id"),
    mutationId: text("mutation_id").notNull(),
    type: text("type").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    cursorIdx: index("node_events_cursor_idx").on(table.cursor),
    mutationUnique: unique("node_events_user_mutation_type_unique").on(
      table.userId,
      table.mutationId,
      table.type
    ),
  })
)

export const quotas = pgTable("quotas", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  quotaBytes: bigint("quota_bytes", { mode: "number" }).notNull(),
  updatedByUserId: text("updated_by_user_id").references(() => user.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

export const storageUsage = pgTable("storage_usage", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  usedBytes: bigint("used_bytes", { mode: "number" }).notNull().default(0),
  reservedBytes: bigint("reserved_bytes", { mode: "number" }).notNull().default(0),
  trashBytes: bigint("trash_bytes", { mode: "number" }).notNull().default(0),
  recalculatedAt: timestamp("recalculated_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>(),
  encrypted: boolean("encrypted").notNull().default(false),
  updatedByUserId: text("updated_by_user_id").references(() => user.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

export const auditEvents = pgTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    actorUserId: text("actor_user_id").references(() => user.id),
    targetUserId: text("target_user_id").references(() => user.id),
    nodeId: text("node_id").references(() => nodes.id),
    type: text("type").notNull(),
    ipHash: text("ip_hash"),
    userAgentHash: text("user_agent_hash"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    typeIdx: index("audit_events_type_idx").on(table.type),
    actorIdx: index("audit_events_actor_idx").on(table.actorUserId),
  })
)

export const invites = pgTable(
  "invites",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    role: roleEnum("role").notNull().default("user"),
    invitedByUserId: text("invited_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    acceptedByUserId: text("accepted_by_user_id").references(() => user.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    emailIdx: index("invites_email_idx").on(table.email),
  })
)

export const publicLinkAccessEvents = pgTable("public_link_access_events", {
  id: text("id").primaryKey(),
  publicLinkId: text("public_link_id")
    .notNull()
    .references(() => publicLinks.id, { onDelete: "cascade" }),
  nodeId: text("node_id")
    .notNull()
    .references(() => nodes.id, { onDelete: "cascade" }),
  outcome: text("outcome").notNull(),
  ipHash: text("ip_hash"),
  userAgentHash: text("user_agent_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export const mutationReceipts = pgTable(
  "mutation_receipts",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    mutationId: text("mutation_id").notNull(),
    response: jsonb("response").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.mutationId] }),
  })
)
