import { Hono } from "hono"
import { cors } from "hono/cors"
import { secureHeaders } from "hono/secure-headers"

import { loadEnv } from "@shelf/config"
import { logger } from "@shelf/logger"

import { requestContext, type ApiVariables } from "./context"
import { fail, HttpError } from "./http"
import { healthRoutes } from "./routes/health"
import { v1Routes } from "./routes/v1"

const env = loadEnv()

const app = new Hono<{ Variables: ApiVariables }>()

app.use("*", requestContext)
app.use("*", secureHeaders())
app.use(
  "*",
  cors({
    origin: env.PUBLIC_APP_URL,
    credentials: true,
  })
)

app.route("/", healthRoutes)
app.route("/api/v1", v1Routes)

app.notFound((c) => fail(c, 404, "Route not found"))

app.onError((error, c) => {
  if (error instanceof HttpError) {
    return fail(c, error.status, error.message, error.details)
  }

  if (error instanceof Response) {
    return error
  }

  c.var.logger?.error("Unhandled API error", {
    error: error instanceof Error ? error.message : String(error),
  })
  return fail(c, 500, "Internal server error")
})

logger.info("Starting Shelf API", { port: env.API_PORT })

export default {
  port: env.API_PORT,
  fetch: app.fetch,
  maxRequestBodySize: 1024 * 1024 * 200,
}
