import { createMiddleware } from "hono/factory"

import { childLogger } from "@shelf/logger"

export interface ApiVariables {
  requestId: string
  logger: ReturnType<typeof childLogger>
}

export const requestContext = createMiddleware<{ Variables: ApiVariables }>(
  async (c, next) => {
    const requestId = c.req.header("x-request-id") ?? crypto.randomUUID()
    c.set("requestId", requestId)
    c.set("logger", childLogger({ requestId, path: c.req.path, method: c.req.method }))
    c.header("x-request-id", requestId)
    await next()
  }
)

