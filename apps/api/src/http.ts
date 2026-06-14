import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { ZodError } from "zod"

export class HttpError extends Error {
  constructor(
    public readonly status: ContentfulStatusCode,
    message: string,
    public readonly details?: unknown
  ) {
    super(message)
    this.name = "HttpError"
  }
}

export function ok<T>(c: Context, data: T, status: ContentfulStatusCode = 200) {
  return c.json({ data }, status)
}

export function created<T>(c: Context, data: T) {
  return ok(c, data, 201)
}

export function fail(
  c: Context,
  status: ContentfulStatusCode,
  message: string,
  details?: unknown
) {
  return c.json({ error: { message, details } }, status)
}

export async function parseJson<T>(
  c: Context,
  parser: { parse: (value: unknown) => T }
) {
  try {
    return parser.parse(await c.req.json())
  } catch (error) {
    if (error instanceof ZodError) {
      throw new HttpError(422, "Invalid request body", error.issues)
    }
    throw error
  }
}
