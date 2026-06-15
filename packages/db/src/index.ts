import { loadEnv } from "@shelf/config"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"

import * as schema from "./schema"

let pool: Pool | undefined

export function getPool() {
  pool ??= new Pool({ connectionString: loadEnv().DATABASE_URL })
  return pool
}

export const db = drizzle({ client: getPool(), schema })

export async function dbHealthCheck() {
  const result = await getPool().query("select 1 as ok")
  return result.rows[0]?.ok === 1
}

export async function withTransaction<T>(
  callback: (
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0]
  ) => Promise<T>
) {
  return db.transaction(callback)
}

export * from "./schema"
export * from "./settings"
