import { sql } from "drizzle-orm"
import { crDb } from "./db"
import { advanceSimClock, simNow } from "./clock"

/** Move the simulated clock to just past the newest stored event or telemetry row. Returns the minutes moved, 0 if none. */
export async function catchUpSimClock(): Promise<number> {
  const rows = await crDb().execute(sql`SELECT greatest((SELECT max(at) FROM cr_events), (SELECT max(at) FROM cr_telemetry)) AS latest`)
  const latest = (rows as unknown as { latest: string | Date | null }[])[0]?.latest
  if (!latest) return 0
  const gapMs = new Date(latest).getTime() - simNow().getTime()
  if (gapMs <= 0) return 0
  const minutes = Math.ceil(gapMs / 60000) + 1
  advanceSimClock(minutes)
  return minutes
}
