// Drops every `cr_` table so `npm run db:push` can recreate them from
// lib/cr/schema.ts without interactive rename questions. Only our own demo
// state is lost; the starter's dataset tables are not touched.
//
// Run from starter/: npm run cr:reset-schema && npm run db:push

import "dotenv/config"
import { sql } from "drizzle-orm"
import { closeCrDb, crDb } from "../db"

async function main() {
  const rows = (await crDb().execute(sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'cr\\_%'`)) as unknown as { tablename: string }[]
  for (const { tablename } of rows) await crDb().execute(sql.raw(`DROP TABLE IF EXISTS "${tablename}" CASCADE`))
  console.log(rows.length ? `Dropped ${rows.map((row) => row.tablename).join(", ")}. Now run: npm run db:push` : "No cr_ tables to drop.")
  await closeCrDb()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
