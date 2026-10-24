import { and, eq, inArray } from "drizzle-orm"
import { db } from "@/lib/db"
import { orderItems, orders, vehicles } from "@/lib/schema"

/** Orders a delivery run can walk: not yet delivered or cancelled. The dossier service plans the steps from their records. */
export async function runnableOrders(): Promise<{ reference: string; id: string; title: string; phase: string }[]> {
  const rows = await db.select({ id: orders.id, reference: orders.reference, lane: orders.displayLane, make: vehicles.make, model: vehicles.model })
    .from(orders)
    .leftJoin(orderItems, and(eq(orderItems.orderId, orders.id), eq(orderItems.role, "PRIMARY")))
    .leftJoin(vehicles, eq(vehicles.id, orderItems.vehicleId))
    .where(inArray(orders.displayLane, ["ready", "market", "booked", "moving"]))
  const lane: Record<string, string> = { ready: "readiness", market: "on the market", booked: "driver booked", moving: "on the road" }
  const preferred = ["CD-420442", "CD-420399", "CD-420584", "CD-420603", "CD-420941"]
  return rows
    .map((row) => ({ reference: row.reference, id: row.id, title: row.make ? `${row.make} ${row.model}` : "Vehicle", phase: lane[row.lane] ?? row.lane }))
    .sort((a, b) => (preferred.indexOf(a.reference) + 1 || 99) - (preferred.indexOf(b.reference) + 1 || 99) || a.reference.localeCompare(b.reference))
}
