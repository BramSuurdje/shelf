# Shelf Build Plan

Shelf is a local-first, open-source, self-hosted Google Drive, OneDrive, and Dropbox alternative. For v1, "local-first" means self-hosted data ownership: metadata in the operator's Postgres database and file bytes in the operator's S3-compatible storage. True offline-first sync and native Finder integration are future work, but the backend must be designed for them from day one.

License: AGPL-3.0.

## Product Scope

### V1 Goal

Build a fast, easy-to-use, self-hosted web drive for individuals and small teams.

V1 includes:

- Multi-user single-instance app.
- First-run owner onboarding.
- Invite-only signup by default.
- Email/password auth.
- GitHub and Google OAuth.
- S3-compatible storage.
- Direct browser-to-S3 uploads.
- Multipart uploads for large files.
- Drag-and-drop file and folder uploads.
- Upload queue with progress, retry, and cancel.
- File and folder sharing by username.
- Public file and folder links.
- Global and per-user quotas.
- Admin settings and diagnostics.
- Profile avatars, username changes, and basic preferences.
- Docker Compose self-hosting.
- GitHub CI.

Deferred:

- Native desktop sync clients.
- Mobile app.
- Offline-first web app.
- Content search.
- Malware scanning engine.
- Comments.
- Realtime collaboration.
- Online document editing.
- WebDAV.
- Rich media transcoding.
- Workspaces or organizations.

## Architecture Decisions

### Stack

- Runtime/package manager: Bun.
- Monorepo: Bun workspaces.
- Web: Vite, React, shadcn/ui, Tailwind CSS.
- Routing: Vite default app structure. Do not add React Router or TanStack Router unless a later concrete need appears.
- Server state: TanStack Query.
- Local UI state: small Zustand stores where useful.
- Forms: React Hook Form and Zod.
- API: Hono on Bun.
- Database: Postgres.
- ORM/migrations: Drizzle.
- Auth: Better Auth.
- Sessions/cache/queues: Redis. Use Better Auth secondary storage for session acceleration.
- Jobs: BullMQ.
- Storage: generic S3-compatible provider.
- Icons: Heroicons.
- License: AGPL-3.0.

### Repository Shape

```text
shelf/
  apps/
    web/
    api/
    worker/
  packages/
    auth/
    config/
    db/
    logger/
    shared/
    storage/
  docker/
  docs/
  .github/
    workflows/
  compose.yml
  .env.example
  AGENTS.md
  LICENSE
  README.md
```

### Runtime Services

- `web`: Vite React app.
- `api`: Hono API under `/api/v1`.
- `worker`: BullMQ workers for cleanup, thumbnails, email, and maintenance.
- `postgres`: metadata source of truth.
- `redis`: sessions, queues, short-lived coordination, rate limits.
- External S3-compatible object storage configured by the admin.

The Compose template must not include S3. Users bring AWS S3, Railway S3, MinIO, Cloudflare R2, or another compatible provider.

The repository has already been initialized as a Bun monorepo with a Vite app and a shadcn package. Keep that structure and extend it instead of re-scaffolding from scratch.

## Identity And Auth

### Better Auth Integration

Use Better Auth's `user` table as the canonical user table. Extend it with Shelf-specific fields through Better Auth `additionalFields` and Drizzle schema mapping.

Better Auth user fields:

- `id`
- `name`
- `email`
- `emailVerified`
- `image`
- `createdAt`
- `updatedAt`

Shelf user extensions:

- `username`
- `usernameChangedAt`
- `role`: `owner | admin | user`
- `storageQuotaBytes`
- `disabledAt`
- `onboardingCompletedAt`
- `preferences`

Use Better Auth user IDs for ownership and permissions. Use ULIDs for Shelf domain records such as nodes, file versions, upload sessions, events, devices, and public links.

### First-Run Setup

If there are zero users, Shelf shows a polished first-run onboarding flow. The first completed account becomes `owner`.

During onboarding, collect and validate:

- App name, default `Shelf`.
- Public app URL.
- S3 endpoint, bucket, region, credentials, and path-style flag.
- Default per-user quota.
- Optional global quota.
- Upload limits.
- Public link policy.
- Registration mode.
- OAuth provider status.
- SMTP status.

After the first user exists, first-run onboarding is permanently disabled.

### Registration

Default post-onboarding mode: invite-only.

Supported modes:

- `invite_only`
- `open`
- `disabled`

OAuth signup is allowed only when registration mode permits it or when a valid invite exists.

### Username Rules

- Unique.
- Lowercase.
- URL-safe.
- Pattern: `^[a-z0-9_]{3,32}$`.
- Users can change username once every 365 days.
- Admins can override cooldown.
- Old usernames are reserved for 365 days.
- Permissions bind to immutable user IDs, not usernames.
- Username changes create audit events.

### Avatars

Better Auth's `image` field stores the canonical avatar URL or reference. Shelf stores avatar bytes in S3, not as base64 in Postgres.

Rules:

- Max avatar size: 5 MiB.
- Allowed formats: JPEG, PNG, WebP.
- Generate square thumbnail asynchronously.
- OAuth image can be imported as the initial avatar.

## Storage

### S3 Contract

Shelf supports generic S3-compatible storage. Railway S3 is documented but not hardcoded.

Admin-configured fields:

- `endpoint`
- `region`
- `bucket`
- `accessKeyId`
- `secretAccessKey`
- `forcePathStyle`
- optional public/CDN base URL

Object keys are opaque IDs, not user-visible paths.

### Railway S3 Notes

Railway Buckets are S3-compatible and support common object operations, presigned URLs, and multipart uploads. Shelf should treat Railway as one provider profile, not a separate storage backend.

Railway defaults and quirks to support:

- Endpoint: `https://storage.railway.app`.
- Region: `auto`.
- Bucket name comes from Railway bucket credentials.
- Current buckets commonly use virtual-hosted-style URLs.
- Older buckets may require path-style URLs.
- The bucket credentials UI indicates which URL style to use.
- Shelf must expose URL style/path-style as explicit config, not infer it silently.
- Advanced bucket features such as object versioning, bucket lifecycle policies, and server-side encryption are not currently available.

Implementation consequence: Shelf must own file versioning, trash retention, stale upload cleanup, and object lifecycle cleanup in Postgres plus the worker. Do not rely on Railway bucket lifecycle rules.

### Upload Contract

Uploads use server-orchestrated upload sessions.

Flow:

1. Client requests an upload session for target folder and file metadata.
2. API validates auth, permissions, quotas, and limits.
3. API creates pending upload session and pending file version.
4. API returns either single PUT presigned URL or multipart instructions.
5. Browser uploads bytes directly to S3.
6. Client completes upload session with ETag, checksum, and multipart part list.
7. API verifies completion and marks the file version complete.
8. Worker expires stale sessions and aborts stale multipart uploads.

Defaults:

- Multipart threshold: 64 MiB.
- Signed URL expiry: 15 minutes.
- Concurrent file uploads: 4.
- Concurrent multipart parts per file: 4.

Files do not appear as complete until S3 completion is confirmed.

## Filesystem Model

Shelf uses a database-backed folder tree. S3 prefixes are not the source of truth.

Core node behavior:

- Every file or folder is a node.
- Every node has a stable ID.
- Every node has a parent ID, except root nodes.
- Every node has a revision.
- Rename and move do not rewrite S3 objects.
- Folder permissions inherit to descendants.
- Deletes create tombstones before hard deletion.

Names must be unique among non-deleted siblings in the same effective tree context.

### Versioning

Every file has one or more immutable file versions.

Rules:

- Uploading over an existing file creates a new file version.
- Active version is the current visible file.
- Deleting a file soft-deletes the node and versions.
- Background cleanup removes S3 objects after trash retention or hard delete.
- Data model includes `scanStatus`, but v1 does not include malware scanning.

### Sync-Ready Contract

V1 must be ready for future native sync clients.

Rules:

- Stable node IDs.
- Monotonic node revisions.
- Append-only node events.
- Mutation IDs for all writes.
- Future device IDs supported.
- Base node revision accepted on mutations.
- Tombstones for deletes.
- Idempotent writes.
- Server time is authoritative.
- Conflicts preserve data instead of silently overwriting.

Future sync clients should be able to query `GET /api/v1/events?cursor=...`.

## Permissions And Sharing

### Roles

Instance roles:

- `owner`
- `admin`
- `user`

Node permissions:

- `viewer`
- `editor`

Owner access is implicit and not assignable in v1.

### Admin Privacy Rule

Admins never get private file access by role.

Admins can:

- Manage users.
- Suspend users.
- Set quotas.
- View aggregate user storage usage.
- Trigger cleanup jobs.
- Manage instance settings.
- View operational metadata.

Admins cannot:

- Browse private files.
- Preview private files.
- Download private files.
- Share private files.
- See private filenames by default.

An admin can access a file only if the user explicitly shares it with that admin like any other user.

### Public Links

Public links are token-based capabilities.

Rules:

- Can target file or folder.
- View/download only in v1.
- Optional expiration.
- Optional password.
- Optional max download count.
- Opaque random token.
- Store only token hash.
- No owner email leakage.
- Public folder links allow browsing and downloading descendants.
- Access is logged with timestamp, IP hash, user-agent hash, target ID, and outcome.

## Admin Settings

### Instance Settings

- App name.
- Public app URL.
- Registration mode.
- Default role for new users.

### Storage Settings

- S3 endpoint.
- S3 region.
- S3 bucket.
- S3 credentials.
- Path-style flag.
- Public/CDN base URL.
- Multipart threshold.
- Max single-file size.
- Global storage limit.
- Default per-user quota.

S3 changes require a successful connection test before save.

### Sharing Settings

- Public links enabled/disabled.
- Default public link expiration.
- Maximum public link expiration.
- Folder sharing enabled/disabled.

### Security Settings

- OAuth providers enabled/disabled.
- Email verification required.
- Password policy minimums.
- Session lifetime.

### Maintenance Settings

- Trash retention days.
- Pending upload expiration.
- Thumbnail generation enabled.

### Settings Storage

Env-only:

- `DATABASE_URL`
- `REDIS_URL`
- encryption/seal secret
- runtime ports

Database settings:

- Admin-managed non-secret settings.
- S3 non-secret config.
- OAuth enabled flags.

Encrypted database secrets:

- S3 access key.
- S3 secret key.
- OAuth client secrets.
- SMTP password.

## Quotas

V1 supports global and per-user hard quotas.

Rules:

- Upload session creation checks projected usage before presigning.
- Pending uploads reserve quota.
- Completion finalizes usage.
- Cancel/expiration releases reservation.
- Trash counts toward quota until purged.
- Admin dashboard shows used, reserved, trash, and available storage.
- Per-user quota override beats default quota.

## UI Model

Shelf should feel like a fast, quiet, polished file utility.

Navigation:

- My Shelf.
- Shared with me.
- Public links.
- Recent.
- Trash.
- Admin.

Primary layout:

- Left sidebar.
- Top command/search bar.
- Table-first file browser.
- Optional grid view.
- Right-side details/share panel.
- Upload drawer/queue.
- Accessible dialogs and menus.
- Light/dark/system themes.
- Comfortable/compact density preference.

Use Heroicons for icons. Keep icon usage restrained and functional.

## API Shape

All app API routes live under `/api/v1`.

Initial route groups:

- `/api/v1/auth`
- `/api/v1/setup`
- `/api/v1/nodes`
- `/api/v1/uploads`
- `/api/v1/shares`
- `/api/v1/public`
- `/api/v1/events`
- `/api/v1/devices`
- `/api/v1/admin`
- `/api/v1/settings`
- `/api/v1/quotas`
- `/api/v1/audit`

Required write behavior:

- Every write accepts `mutationId`.
- Future device clients can send `deviceId`.
- Mutations that touch nodes accept `baseNodeRevision`.
- Responses include changed node revision and event cursor where relevant.

Health routes:

- `/healthz`
- `/readyz`
- optional `/metrics`

## Core Database Tables

Auth:

- `user`
- `session`
- `account`
- `verification`

Shelf:

- `username_history`
- `nodes`
- `file_versions`
- `node_permissions`
- `public_links`
- `upload_sessions`
- `multipart_upload_parts`
- `node_events`
- `devices`
- `quotas`
- `storage_usage`
- `audit_events`
- `app_settings`
- `invites`

Use Redis/BullMQ for queues. Do not add a Postgres jobs table unless needed later.

## Background Jobs

Worker jobs:

- Expire incomplete upload sessions.
- Abort stale multipart uploads.
- Generate image thumbnails.
- Recalculate quota usage.
- Purge trash after retention.
- Send password reset emails.
- Send verification emails.
- Send invite emails.
- Record failed job diagnostics.

## Security Baseline

V1 security requirements:

- Better Auth password hashing.
- Better Auth session protections.
- Rate limit auth routes.
- Rate limit public links.
- Rate limit upload session creation.
- Rate limit password reset.
- Short-lived presigned URLs.
- Hashed public-link tokens.
- Unguessable S3 object keys.
- File size enforced before upload and after completion.
- MIME validation.
- Audit logs for auth, sharing, public links, admin changes, username changes, and destructive operations.
- Security headers.
- No telemetry by default.

## Observability

V1 includes:

- Structured JSON logs.
- Request IDs.
- Request ID propagation into jobs and S3 operations.
- API health check.
- DB health check.
- Redis health check.
- S3 health check.
- Admin diagnostics page.
- Queue depth display.
- Recent failed jobs display.
- Optional Prometheus metrics.

## Docker And CI

### Compose Template

`compose.yml` starts:

- web
- api
- worker
- Postgres
- Redis

It does not include S3.

Compose must use published GHCR images. It must not require users to build images locally.

### GitHub CI

CI should run:

- `bun install --frozen-lockfile`
- typecheck
- lint
- test
- build web
- build API
- build worker
- build Docker images
- publish Docker images to GHCR

GHCR image publishing is required for v1. Self-hosters should run the published images from `compose.yml`.

## Implementation Tickets

### Milestone 0: Repository Foundation

- Inspect existing Bun monorepo structure.
- Keep the existing Vite app.
- Keep the existing shadcn package.
- Add root `bunfig.toml` if needed.
- Add root `tsconfig.base.json` if missing.
- Add or normalize `apps/api`.
- Add or normalize `apps/worker`.
- Add or normalize `packages/shared`.
- Add or normalize `packages/config`.
- Add or normalize `packages/logger`.
- Add or normalize `packages/db`.
- Add or normalize `packages/auth`.
- Add or normalize `packages/storage`.
- Add AGPL-3.0 `LICENSE`.
- Add initial `README.md`.
- Add root `AGENTS.md`.
- Add `.gitignore`.
- Add `.env.example`.
- Add GHCR-image-based `compose.yml`.
- Add API Dockerfile target.
- Add web Dockerfile target.
- Add worker Dockerfile target.
- Add GitHub Actions workflow skeleton.

### Milestone 1: Tooling And Quality Gates

- Add TypeScript strict config.
- Add shared lint config.
- Add formatting config.
- Add `bun typecheck` script.
- Add `bun lint` script.
- Add `bun test` script.
- Add `bun build` script.
- Add CI install step.
- Add CI typecheck step.
- Add CI lint step.
- Add CI test step.
- Add CI build step.
- Add Docker image build step.
- Add GHCR login step.
- Add GHCR publish step.

### Milestone 2: Config And Logging

- Implement env parser in `packages/config`.
- Add typed `DATABASE_URL`.
- Add typed `REDIS_URL`.
- Add typed encryption secret.
- Add typed port config.
- Add typed runtime mode.
- Add structured logger in `packages/logger`.
- Add request ID helper.
- Add API logger middleware.
- Add worker logger helper.
- Add redaction for known secret keys.

### Milestone 3: Database Foundation

- Add Drizzle config.
- Add Postgres connection module.
- Add migration script.
- Add Better Auth base tables.
- Add extended `user` schema fields.
- Add `username_history` table.
- Add `app_settings` table.
- Add `audit_events` table.
- Add first migration.
- Add DB health check helper.
- Add transaction helper.

### Milestone 4: Better Auth

- Add Better Auth config package.
- Wire Drizzle adapter.
- Configure email/password auth.
- Configure GitHub OAuth placeholders.
- Configure Google OAuth placeholders.
- Configure Better Auth secondary storage with Redis for sessions.
- Add auth route mounting in API.
- Add current-user endpoint.
- Add auth client in web.
- Add login page.
- Add signup page.
- Add logout action.
- Add protected route wrapper.
- Add disabled-user guard.

### Milestone 5: First-Run Owner Onboarding

- Add setup status endpoint.
- Add zero-user setup detection.
- Add setup route guard.
- Add first-run onboarding UI shell.
- Add owner account creation step.
- Add app URL settings step.
- Add S3 settings form step.
- Add S3 connection test endpoint.
- Add quota settings step.
- Add registration mode step.
- Add OAuth status step.
- Add SMTP status step.
- Persist setup settings transactionally.
- Mark owner onboarding completed.
- Block normal signup until setup complete.
- Disable setup after first user exists.

### Milestone 6: Admin Settings

- Add settings read endpoint.
- Add settings update endpoint.
- Add encrypted secret storage helper.
- Add S3 settings validation.
- Add upload limit settings.
- Add sharing policy settings.
- Add security settings.
- Add maintenance settings.
- Add SMTP settings.
- Add admin settings UI.
- Add audit events for setting changes.
- Add owner/admin route guards.

### Milestone 7: S3 Storage Adapter

- Add S3 client factory.
- Add object key generator.
- Add single PUT presign helper.
- Add multipart create helper.
- Add multipart presign part helper.
- Add multipart complete helper.
- Add multipart abort helper.
- Add object delete helper.
- Add object metadata/head helper.
- Add object stream helper.
- Add S3 connection test helper.
- Add storage adapter unit tests with mocked S3 client.

### Milestone 8: Nodes And File Versions

- Add `nodes` table.
- Add `file_versions` table.
- Add node type enum.
- Add file version status enum.
- Add scan status enum.
- Add sibling uniqueness constraint.
- Add node revision column.
- Add root node creation helper.
- Add create folder mutation.
- Add rename node mutation.
- Add move node mutation.
- Add copy node mutation.
- Add trash node mutation.
- Add restore node mutation.
- Add permanent delete mutation marker.
- Add active file version helper.
- Add node service tests.

### Milestone 9: Events And Idempotent Mutations

- Add `node_events` table.
- Add event cursor generator.
- Add mutation ID uniqueness table or constraint.
- Emit event on folder create.
- Emit event on rename.
- Emit event on move.
- Emit event on copy.
- Emit event on trash.
- Emit event on restore.
- Emit event on file version completion.
- Add `/api/v1/events?cursor=...`.
- Add base revision validation.
- Add stale destructive operation rejection.
- Add event service tests.

### Milestone 10: Quotas

- Add `quotas` table if per-user overrides are not stored only on user.
- Add `storage_usage` table.
- Add quota calculation helper.
- Add quota reservation on upload session create.
- Add quota finalization on upload complete.
- Add quota release on upload abort.
- Add quota release on upload expiration.
- Add admin global quota setting.
- Add admin per-user quota override endpoint.
- Add user quota display endpoint.
- Add quota tests.

### Milestone 11: Upload Sessions

- Add `upload_sessions` table.
- Add `multipart_upload_parts` table.
- Add create upload session endpoint.
- Add single upload response shape.
- Add multipart upload response shape.
- Add complete upload session endpoint.
- Add abort upload session endpoint.
- Add stale upload expiration job.
- Add stale multipart abort job.
- Add pending file version creation.
- Add completion verification.
- Add upload audit events.
- Add upload API tests.

### Milestone 12: Web App Shell

- Use the existing shadcn package.
- Use Heroicons for icons.
- Add Tailwind setup.
- Add app layout.
- Add sidebar.
- Add top search/command bar shell.
- Add theme provider.
- Add density preference shell.
- Add route tree.
- Add auth redirects.
- Add loading states.
- Add empty states.
- Add accessible dialog baseline.

### Milestone 13: File Browser

- Add My Shelf route.
- Add folder children query.
- Add file table.
- Add folder navigation.
- Add breadcrumbs.
- Add create folder dialog.
- Add rename dialog.
- Add move dialog.
- Add delete to trash action.
- Add restore action.
- Add permanent delete action.
- Add list/grid view toggle.
- Add sorting.
- Add selection state.
- Add keyboard navigation basics.

### Milestone 14: Browser Upload Manager

- Add upload manager module.
- Add folder drag/drop traversal.
- Add task queue model.
- Add per-file progress.
- Add aggregate progress.
- Add speed calculation.
- Add ETA calculation.
- Add concurrency controls.
- Add single PUT upload implementation.
- Add multipart upload implementation.
- Add part retry.
- Add cancellation.
- Add upload retry.
- Add upload store.
- Add upload drawer UI.
- Add drag overlay.
- Add upload completion invalidation.

### Milestone 15: Sharing

- Add `node_permissions` table.
- Add user lookup by username endpoint.
- Add share with user endpoint.
- Add update permission endpoint.
- Add revoke permission endpoint.
- Add permission resolver.
- Add folder inheritance resolver.
- Add Shared with me route.
- Add share panel.
- Add shared users list.
- Add editor permission behavior.
- Add permission tests.

### Milestone 16: Public Links

- Add `public_links` table.
- Add token generation.
- Add token hashing.
- Add create public link endpoint.
- Add update public link endpoint.
- Add disable public link endpoint.
- Add public link resolve endpoint.
- Add optional password check.
- Add optional expiration check.
- Add optional download count check.
- Add public file view route.
- Add public folder browse route.
- Add public link audit logging.
- Add Public links owner route.

### Milestone 17: Downloads And Zip

- Add file download presign or proxy decision endpoint.
- Add secure file download endpoint.
- Add folder traversal for zip.
- Add streaming zip implementation.
- Add zip max size guard.
- Add zip max file count guard.
- Add public folder zip download.
- Add download audit events.
- Add download tests.

### Milestone 18: Search And Recent

- Add filename search endpoint.
- Add trigram or indexed search migration.
- Add search scope filters.
- Add permission-aware search resolver.
- Add Recent data model or query.
- Add recent activity tracking.
- Add search UI.
- Add Recent route.
- Add search tests.

### Milestone 19: Trash

- Add Trash route.
- Add trash listing endpoint.
- Add restore from trash endpoint.
- Add permanent delete endpoint.
- Add trash retention setting.
- Add purge trash job.
- Add S3 object cleanup after permanent delete.
- Add trash quota behavior tests.

### Milestone 20: Profiles And Preferences

- Add profile read endpoint.
- Add profile update endpoint.
- Add username change endpoint.
- Add username cooldown enforcement.
- Add username history reservation.
- Add admin username override endpoint.
- Add avatar upload session scope.
- Add avatar completion endpoint.
- Add avatar thumbnail job.
- Add preferences update endpoint.
- Add profile settings UI.
- Add username tests.

### Milestone 21: Invites And Email

- Add `invites` table.
- Add invite create endpoint.
- Add invite accept flow.
- Add invite revoke endpoint.
- Add SMTP config test endpoint.
- Add email queue.
- Add password reset email job.
- Add verification email job.
- Add invite email job.
- Add dev email logging mode.
- Add admin invite UI.

### Milestone 22: Admin Users

- Add admin users list endpoint.
- Add suspend user endpoint.
- Add restore user endpoint.
- Add promote admin endpoint.
- Add demote admin endpoint.
- Add owner transfer eligibility checks.
- Add owner transfer confirmation flow.
- Add owner transfer execution endpoint.
- Add owner transfer audit events.
- Add per-user quota override UI.
- Add aggregate storage usage UI.
- Ensure admin user views do not expose private filenames.
- Add admin audit events.

### Milestone 23: Admin Diagnostics

- Add API health endpoint.
- Add readiness endpoint.
- Add DB status check.
- Add Redis status check.
- Add S3 status check.
- Add queue depth endpoint.
- Add recent failed jobs endpoint.
- Add app version display.
- Add diagnostics UI.
- Add optional Prometheus metrics endpoint.

### Milestone 24: Thumbnails And Preview Basics

- Add thumbnail object key convention.
- Add image thumbnail worker.
- Add thumbnail status field if needed.
- Add thumbnail display in grid view.
- Add MIME icon mapping.
- Add safe text preview endpoint with size limit.
- Add PDF/video/audio placeholder behavior.

### Milestone 25: Hardening

- Add auth route rate limits.
- Add upload session rate limits.
- Add public link rate limits.
- Add password reset rate limits.
- Add security headers.
- Add CORS policy.
- Add MIME validation.
- Add post-upload size verification.
- Add public-link token hash tests.
- Add permission regression tests.
- Add audit coverage tests.

### Milestone 26: Accessibility And UX Pass

- Audit keyboard navigation.
- Audit focus states.
- Audit dialogs.
- Audit menus.
- Audit file table screen reader labels.
- Audit upload queue announcements.
- Audit color contrast.
- Audit responsive layout.
- Audit text overflow.
- Add reduced-motion handling.

### Milestone 27: Self-Hosting Docs

- Document Docker Compose setup.
- Document GHCR image usage.
- Document required S3 settings.
- Document Railway S3 setup.
- Document AWS S3 setup.
- Document Redis/Postgres requirements.
- Document first-run onboarding.
- Document backup strategy.
- Document upgrade/migration flow.
- Document environment variables.
- Document admin recovery basics.

### Milestone 28: Release Candidate

- Run full CI locally.
- Run Docker Compose smoke test.
- Run first-run onboarding smoke test.
- Run upload smoke test.
- Run multipart upload smoke test.
- Run sharing smoke test.
- Run public link smoke test.
- Run quota smoke test.
- Run owner transfer smoke test.
- Run admin diagnostics smoke test.
- Tag v1.0.0-rc.1.

## Open Questions To Revisit Before Implementation

- Final GHCR image names and tags.
- Exact Railway S3 setup screenshots or CLI snippets for the docs.
