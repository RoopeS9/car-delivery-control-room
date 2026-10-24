import { NextResponse } from "next/server"
import { carReadings } from "@/lib/sim/status"

export const runtime = "nodejs"

/** Latest simulated OBD and phone GPS readings for one moving order (reference or id). */
export async function GET(_request: Request, context: { params: Promise<{ order: string }> }) {
  const { order } = await context.params
  const readings = await carReadings(order)
  if (!readings) return NextResponse.json({ error: "This order has no car on the road." }, { status: 404 })
  return NextResponse.json(readings)
}
