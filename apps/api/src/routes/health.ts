import { Hono } from "hono"
import Redis from "ioredis"

import { loadEnv } from "@shelf/config"
import { dbHealthCheck, loadS3SettingsFromDb } from "@shelf/db"
import { testS3Connection } from "@shelf/storage"

import type { ApiVariables } from "../context"
import { ok } from "../http"

export const healthRoutes = new Hono<{ Variables: ApiVariables }>()

healthRoutes.get("/healthz", (c) =>
  ok(c, {
    status: "ok",
    version: "0.0.1",
    time: new Date().toISOString(),
  })
)

healthRoutes.get("/readyz", async (c) => {
  const env = loadEnv()
  const redis = new Redis(env.REDIS_URL, { lazyConnect: true })
  const checks = {
    database: false,
    redis: false,
    s3: false,
  }

  checks.database = await dbHealthCheck().catch(() => false)
  checks.redis = await redis
    .connect()
    .then(() => redis.ping())
    .then((pong) => pong === "PONG")
    .catch(() => false)
    .finally(() => redis.disconnect())
  checks.s3 = await Promise.resolve()
    .then(async () => testS3Connection(await loadS3SettingsFromDb()))
    .catch(() => false)

  const ready = Object.values(checks).every(Boolean)
  return c.json({ data: { ready, checks } }, ready ? 200 : 503)
})

healthRoutes.get("/metrics", (c) =>
  c.text(`# HELP shelf_up Shelf API availability\n# TYPE shelf_up gauge\nshelf_up 1\n`)
)
