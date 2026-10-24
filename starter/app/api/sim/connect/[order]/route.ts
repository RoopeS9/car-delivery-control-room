import { NextResponse } from "next/server"
import { reconnectCar } from "@/lib/sim/reconnect"

export const runtime = "nodejs"

/** The driver plugs the OBD dongle back in: stored codes, freeze frame and the phone's position arrive. */
export async function POST(_request: Request, context: { params: Promise<{ order: string }> }) {
  const { order } = await context.params
  const result = await reconnectCar(order)
  return NextResponse.json(result, { status: result.ok ? 200 : 404 })
}
