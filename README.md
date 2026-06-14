# Shelf

Shelf is a local-first, open-source, self-hosted web drive for individuals and small teams. V1 stores metadata in the operator's Postgres database and file bytes in the operator's S3-compatible storage.

Shelf is licensed under AGPL-3.0.

## Stack

- Bun workspaces and Turborepo
- Vite, React, Tailwind CSS, shadcn/ui, Heroicons
- TanStack Query, Zustand, React Hook Form, Zod
- Hono on Bun
- Better Auth with email/password, GitHub OAuth, Google OAuth, username, and admin plugins
- Drizzle ORM and Postgres
- Redis and BullMQ
- Generic S3-compatible object storage

## Local Development

```sh
bun install
bun dev
```

For Bun-based local development outside Docker, point `DATABASE_URL` and
`REDIS_URL` at your local or hosted services. The checked-in `.env.example`
uses Compose service hostnames for self-hosting.

The repository contains:

- `apps/web`: Vite React app
- `apps/api`: Hono API under `/api/v1`
- `apps/worker`: BullMQ maintenance workers
- `packages/db`: Drizzle schema and migrations
- `packages/auth`: Better Auth configuration
- `packages/storage`: S3-compatible storage adapter
- `packages/config`, `packages/logger`, `packages/shared`

## Quality Gates

```sh
bun typecheck
bun lint
bun test
bun build
```

## Self-Hosting

Copy `.env.example` to `.env`, fill database, Redis, Better Auth, and encryption values, then run:

```sh
docker compose up -d
docker compose run --rm api bun --cwd packages/db db:migrate
```

`compose.yml` uses published GHCR images for `web`, `api`, and `worker`. It starts Postgres and Redis only. S3 is intentionally external and configured during first-run setup: use AWS S3, Railway S3, Cloudflare R2, MinIO, or another compatible provider.

## First Run

When the user table is empty, Shelf exposes first-run setup. The first completed user becomes `owner`. After any user exists, setup is permanently disabled.

## Backups

Back up Postgres and the configured S3 bucket together. Postgres contains the source of truth for paths, versions, shares, public links, quotas, audit events, and pending upload state.
