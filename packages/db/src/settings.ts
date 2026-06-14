import { eq } from "drizzle-orm"

import { openSecret } from "@shelf/config"

import { db } from "./index"
import { appSettings } from "./schema"

export interface DbS3Settings {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  forcePathStyle: boolean
  publicBaseUrl?: string
}

export async function readAppSetting<T>(key: string, fallback: T): Promise<T> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, key))
  return (row?.value as T | undefined) ?? fallback
}

export async function loadS3SettingsFromDb(): Promise<DbS3Settings> {
  const settings = await db.select().from(appSettings)
  const values = new Map(settings.map((setting) => [setting.key, setting]))

  const endpoint = values.get("storage.endpoint")?.value
  const region = values.get("storage.region")?.value
  const bucket = values.get("storage.bucket")?.value
  const accessKeyId = values.get("storage.accessKeyId")
  const secretAccessKey = values.get("storage.secretAccessKey")
  const forcePathStyle = values.get("storage.forcePathStyle")?.value
  const publicBaseUrl = values.get("storage.publicBaseUrl")?.value

  if (
    typeof endpoint !== "string" ||
    typeof region !== "string" ||
    typeof bucket !== "string" ||
    typeof accessKeyId?.value !== "string" ||
    typeof secretAccessKey?.value !== "string" ||
    typeof forcePathStyle !== "boolean"
  ) {
    throw new Error("S3 settings are incomplete")
  }

  return {
    endpoint,
    region,
    bucket,
    accessKeyId: accessKeyId.encrypted
      ? await openSecret(accessKeyId.value)
      : accessKeyId.value,
    secretAccessKey: secretAccessKey.encrypted
      ? await openSecret(secretAccessKey.value)
      : secretAccessKey.value,
    forcePathStyle,
    publicBaseUrl:
      typeof publicBaseUrl === "string" && publicBaseUrl.length > 0
        ? publicBaseUrl
        : undefined,
  }
}
