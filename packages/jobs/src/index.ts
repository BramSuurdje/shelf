import { Queue, Worker } from "bullmq"

import type { ConnectionOptions } from "bullmq"

import { loadEnv } from "@shelf/config"

const env = loadEnv()

function redisConnectionOptions(maxRetriesPerRequest: number | null): ConnectionOptions {
  const redisUrl = new URL(env.REDIS_URL)
  const dbPath = redisUrl.pathname.replace("/", "")

  return {
    host: redisUrl.hostname,
    port: Number(redisUrl.port || 6379),
    username: redisUrl.username
      ? decodeURIComponent(redisUrl.username)
      : undefined,
    password: redisUrl.password
      ? decodeURIComponent(redisUrl.password)
      : undefined,
    db: dbPath ? Number(dbPath) : undefined,
    tls: redisUrl.protocol === "rediss:" ? {} : undefined,
    maxRetriesPerRequest,
  }
}

const producerConnection = redisConnectionOptions(1)

export type ShelfJobName =
  | "uploads.expireIncomplete"
  | "uploads.abortStaleMultipart"
  | "images.generateThumbnail"
  | "quotas.recalculate"
  | "trash.purgeExpired"
  | "email.passwordReset"
  | "email.verification"
  | "email.invite"
  | "jobs.recordFailure"

export const maintenanceQueue = new Queue("shelf-maintenance", {
  connection: producerConnection,
})

export function createWorker(
  processor: ConstructorParameters<typeof Worker<ShelfJobName, unknown, ShelfJobName>>[1]
) {
  return new Worker<ShelfJobName, unknown, ShelfJobName>("shelf-maintenance", processor, {
    connection: redisConnectionOptions(null),
    concurrency: env.WORKER_CONCURRENCY,
  })
}
