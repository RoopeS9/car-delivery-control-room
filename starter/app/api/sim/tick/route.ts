import { NextResponse } from "next/server"
import { autopilotStep } from "@/lib/sim/autopilot"
import { simDriverStep } from "@/lib/sim/sim-driver"
import { syncTelemetry } from "@/lib/sim/sync"

export const runtime = "nodejs"

/**
 * Writes the simulated GPS and OBD samples that fell due since the last tick,
 * and lets the simulated driver (video only, off by default) answer. Safe to call often.
 */
export async function POST(request: Request) {
  const result = await syncTelemetry()
  const origin = new URL(request.url).origin
  await simDriverStep(origin)
  // The autopilot's checks run on the same beat; a call it places runs in the background.
  await autopilotStep(origin).catch((error) => console.warn("[autopilot] step failed", error instanceof Error ? error.message : error))
  return NextResponse.json(result)
}
