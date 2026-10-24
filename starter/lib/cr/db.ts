// Database client for our tables and the starter's. Unlike `lib/db.ts` it does
// not import "server-only", so scripts and tests (`tsx`) can use it too. The
// client is kept on globalThis so dev reloads do not open new pools.

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import * as starterSchema from "@/lib/schema"
import * as crSchema from "./schema"

const schema = { ...starterSchema, ...crSchema }
export type CrDb = PostgresJsDatabase<typeof schema>

const holder = globalThis as unknown as { __crDb?: CrDb; __crSql?: postgres.Sql }

export function crDb(): CrDb {
  if (holder.__crDb) return holder.__crDb
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is required. See starter/README.md.")
  holder.__crSql = postgres(url, { max: 5 })
  holder.__crDb = drizzle(holder.__crSql, { schema })
  return holder.__crDb
}

/** Close the pool. Scripts and tests call this so the process can exit. */
export async function closeCrDb(): Promise<void> {
  await holder.__crSql?.end({ timeout: 5 })
  holder.__crSql = undefined
  holder.__crDb = undefined
}
