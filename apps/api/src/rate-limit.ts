import { loadEnv } from "@shelf/config"
import { createMiddleware } from "hono/factory"
import Redis from "ioredis"

let redis: Redis | undefined

function getRedis() {
  redis ??= new Redis(loadEnv().REDIS_URL, {
    maxRetriesPerRequest: 1,
  })
  return redis
}

export function rateLimit(options: {
  name: string
  limit: number
  windowSeconds: number
}) {
  return createMiddleware(async (c, next) => {
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      c.req.header("cf-connecting-ip") ??
      "unknown"
    const bucket = Math.floor(Date.now() / (options.windowSeconds * 1000))
    const key = `shelf:rate:${options.name}:${ip}:${bucket}`
    const count = await getRedis().incr(key)

    if (count === 1) {
      await getRedis().expire(key, options.windowSeconds)
    }

    if (count > options.limit) {
      c.header("retry-after", String(options.windowSeconds))
      return c.json({ error: { message: "Rate limit exceeded" } }, 429)
    }

    await next()
  })
}
