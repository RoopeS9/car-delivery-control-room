// Database side of the home chart: the board bundles, the simulated fleet and
// the recent phone positions, handed to the pure builder in chart.ts.

import { sql } from "drizzle-orm"
import { crDb } from "@/lib/cr/db"
import { loadFleet } from "@/lib/sim/fleet"
import { syncTelemetry } from "@/lib/sim/sync"
import { buildChart, type ChartView, type GpsSample } from "./chart"
import { loadBoardBundles } from "./load"

/** The last few phone positions per order, newest twelve each. Empty if the cr_ tables are missing. */
async function recentPositions(): Promise<GpsSample[]> {
  try {
    const result = await crDb().execute(sql`
      SELECT order_id, at, data FROM (
        SELECT order_id, at, data, row_number() OVER (PARTITION BY order_id ORDER BY at DESC) AS n
        FROM cr_telemetry WHERE source = 'PHONE_GPS'
      ) recent WHERE n <= 12`)
    return (result as unknown as { order_id: string; at: string | Date; data: Record<string, unknown> }[]).flatMap((row) => {
      const data = row.data
      if (typeof data.lat !== "number" || typeof data.lng !== "number") return []
      return [{
        orderId: row.order_id, at: new Date(row.at).toISOString(), lat: data.lat, lng: data.lng,
        heading: typeof data.heading === "number" ? data.heading : null,
        speedKmh: typeof data.speed_kmh === "number" ? Math.round(data.speed_kmh) : null,
        placeLabel: typeof data.place_label === "string" ? data.place_label : null,
      }]
    })
  } catch (error) {
    console.warn("Simulated positions could not be read.", error instanceof Error ? error.message : error)
    return []
  }
}

export async function loadChart(): Promise<ChartView> {
  try {
    await syncTelemetry()
  } catch (error) {
    console.warn("Simulated telemetry could not be brought up to date.", error instanceof Error ? error.message : error)
  }
  const [{ snapshotAt, simNow, bundles }, fleet, samples] = await Promise.all([loadBoardBundles(), loadFleet().catch(() => []), recentPositions()])
  return buildChart({ bundles, fleet, samples, snapshotAt, now: simNow })
}
