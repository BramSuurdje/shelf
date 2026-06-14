import { z } from "zod"

export const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  APP_ENV: z.enum(["development", "test", "production"]).default("development"),
  PUBLIC_APP_URL: z.url().default("http://localhost:5173"),
  API_PORT: z.coerce.number().int().positive().default(8787),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  ENCRYPTION_SECRET: z.string().min(32),
  BETTER_AUTH_SECRET: z.string().min(32),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
})

export type ShelfEnv = z.infer<typeof envSchema>

type EnvInput = Record<string, string | undefined>

function defaultEnv(): EnvInput {
  return (
    (globalThis as { process?: { env?: EnvInput } }).process?.env ?? {}
  )
}

export function loadEnv(input: EnvInput = defaultEnv()): ShelfEnv {
  const parsed = envSchema.safeParse(input)

  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ")
    throw new Error(`Invalid environment: ${message}`)
  }

  return parsed.data
}

export function loadOptionalEnv(input: EnvInput = defaultEnv()) {
  return envSchema.partial().parse(input)
}

async function encryptionKey(secret: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret)
  )
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ])
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64ToBytes(value: string) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0))
}

export async function sealSecret(value: string, secret = loadEnv().ENCRYPTION_SECRET) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await encryptionKey(secret)
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(value)
  )
  return `${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(encrypted))}`
}

export async function openSecret(value: string, secret = loadEnv().ENCRYPTION_SECRET) {
  const [ivPart, encryptedPart] = value.split(".")
  if (!ivPart || !encryptedPart) throw new Error("Invalid sealed secret")
  const key = await encryptionKey(secret)
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(ivPart) },
    key,
    base64ToBytes(encryptedPart)
  )
  return new TextDecoder().decode(decrypted)
}
