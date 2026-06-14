# Self-Hosting Shelf

## Required Services

Shelf requires:

- Postgres for metadata
- Redis for sessions, queues, rate limits, and short-lived coordination
- S3-compatible object storage for file bytes

The Compose template does not include S3. Bring a provider such as AWS S3, Railway S3, Cloudflare R2, MinIO, or another compatible service.

The bundled Postgres 18 service mounts its volume at `/var/lib/postgresql`.
Keep that mount point when customizing Compose; mounting only
`/var/lib/postgresql/data` is not compatible with the official Postgres 18 image layout.

## Environment

Create `.env` from `.env.example` and configure:

- `DATABASE_URL`
- `REDIS_URL`
- `ENCRYPTION_SECRET`
- `BETTER_AUTH_SECRET`
- `PUBLIC_APP_URL`

S3 is configured during first-run setup, not through `.env`. Shelf stores S3-compatible provider settings in Postgres and encrypts credentials with `ENCRYPTION_SECRET`.

## Railway S3

Use `https://storage.railway.app` as the endpoint and `auto` as the region unless Railway provides different values. Railway bucket credentials indicate whether virtual-hosted-style or path-style URLs are required. Set path-style mode explicitly during setup.

Shelf owns file versioning, stale upload cleanup, trash retention, and object lifecycle cleanup in Postgres plus the worker. Do not rely on bucket lifecycle features being available.

Direct browser uploads require bucket CORS. Add rules that allow your Shelf origin, including local development if needed:

```json
[
  {
    "AllowedOrigins": ["http://localhost:5173", "https://your-shelf.example.com"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

If browser uploads fail while server-side S3 tests pass, check the presigned URL preflight. It must return `Access-Control-Allow-Origin`, `Access-Control-Allow-Methods`, and `Access-Control-Allow-Headers` for the Shelf origin.

## AWS S3

Use the regional S3 endpoint and region for the bucket. For normal AWS buckets, leave path-style mode disabled.

AWS CLI example:

```sh
aws s3api put-bucket-cors --bucket your-bucket --cors-configuration '{
  "CORSRules": [
    {
      "AllowedOrigins": ["http://localhost:5173", "https://your-shelf.example.com"],
      "AllowedMethods": ["GET", "PUT", "HEAD"],
      "AllowedHeaders": ["*"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 3000
    }
  ]
}'
```

## Start

```sh
docker compose up -d
docker compose run --rm api bun --cwd packages/db db:migrate
```

Open `PUBLIC_APP_URL` and complete first-run setup. The first account becomes the owner.

## Upgrades

Upgrade by pulling the latest GHCR images, running database migrations, and restarting services. Back up Postgres and S3 before applying migrations.

## Recovery

If the owner account is lost, recover through Postgres by assigning `role='owner'` to a known user and clearing ban/disabled fields.
