type LogLevel = "debug" | "info" | "warn" | "error"

const secretKeyPattern =
  /(secret|password|token|key|authorization|cookie|credential)/i

export type LogFields = Record<string, unknown>

function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redact)
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        secretKeyPattern.test(key) ? "[redacted]" : redact(child),
      ])
    )
  }

  return value
}

function write(level: LogLevel, message: string, fields: LogFields = {}) {
  const redactedFields = redact(fields) as LogFields
  const line = {
    level,
    message,
    time: new Date().toISOString(),
    ...redactedFields,
  }
  const serialized = JSON.stringify(line)

  if (level === "error") {
    console.error(serialized)
    return
  }

  if (level === "warn") {
    console.warn(serialized)
    return
  }

  console.log(serialized)
}

export const logger = {
  debug: (message: string, fields?: LogFields) =>
    write("debug", message, fields),
  info: (message: string, fields?: LogFields) => write("info", message, fields),
  warn: (message: string, fields?: LogFields) => write("warn", message, fields),
  error: (message: string, fields?: LogFields) =>
    write("error", message, fields),
}

export function requestIdFromHeaders(headers: Headers) {
  return headers.get("x-request-id") ?? crypto.randomUUID()
}

export function childLogger(defaultFields: LogFields) {
  return {
    debug: (message: string, fields?: LogFields) =>
      logger.debug(message, { ...defaultFields, ...fields }),
    info: (message: string, fields?: LogFields) =>
      logger.info(message, { ...defaultFields, ...fields }),
    warn: (message: string, fields?: LogFields) =>
      logger.warn(message, { ...defaultFields, ...fields }),
    error: (message: string, fields?: LogFields) =>
      logger.error(message, { ...defaultFields, ...fields }),
  }
}
