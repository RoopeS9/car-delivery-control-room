import { NextResponse } from "next/server"
import { sql } from "drizzle-orm"
import { crDb } from "@/lib/cr/db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Replay for the chart's time scrubber: each order's last stored phone fix at
 * or before `at`, and the span of stored fixes. Only what the simulated phones
 * reported; nothing is interpolated.
 */
export async function GET(request: Request) {
  const at = new URL(request.url).searchParams.get("at")
  const db = crDb()
  const span = (await db.execute(sql`SELECT min(at) AS first, max(at) AS last FROM cr_telemetry WHERE source = 'PHONE_GPS'`)) as unknown as { first: string | null; last: string | null }[]
  const first = span[0]?.first ? new Date(span[0].first).toISOString() : null
  const last = span[0]?.last ? new Date(span[0].last).toISOString() : null
  if (!at || Number.isNaN(Date.parse(at))) return NextResponse.json({ first, last, fixes: [] })
  const rows = (await db.execute(sql`
    SELECT DISTINCT ON (order_id) order_id, at, data FROM cr_telemetry
    WHERE source = 'PHONE_GPS' AND at <= ${new Date(at).toISOString()}
    ORDER BY order_id, at DESC`)) as unknown as { order_id: string; at: string | Date; data: Record<string, unknown> }[]
  const fixes = rows.flatMap((row) => typeof row.data.lat === "number" && typeof row.data.lng === "number"
    ? [{ orderId: row.order_id, at: new Date(row.at).toISOString(), lat: row.data.lat, lng: row.data.lng, heading: typeof row.data.heading === "number" ? row.data.heading : null }]
    : [])
  return NextResponse.json({ first, last, fixes })
}
