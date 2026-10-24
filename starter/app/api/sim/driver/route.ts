import { NextResponse } from "next/server"
import { markHumanDriver, setSimDriver, simDriverAvailable, simDriverStatus } from "@/lib/sim/sim-driver"

export const runtime = "nodejs"

/** The simulated driver's toggle (video only). */
export async function GET() {
  return NextResponse.json(simDriverStatus())
}

/** `{ enabled: boolean }` turns it on or off; `{ human: driverId }` says a person is typing for that driver. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { enabled?: unknown; human?: unknown } | null
  if (typeof body?.human === "string") markHumanDriver(body.human)
  if (typeof body?.enabled === "boolean") {
    if (body.enabled && !simDriverAvailable()) return NextResponse.json({ error: "The simulated driver is switched off with SIM_DRIVER_ENABLED=false." }, { status: 409 })
    setSimDriver(body.enabled)
  }
  return NextResponse.json(simDriverStatus())
}
