import { NextResponse } from "next/server"
import { simDriverStep } from "@/lib/sim/sim-driver"
import { syncTelemetry } from "@/lib/sim/sync"

export const runtime = "nodejs"

/**
 * Writes the simulated GPS and OBD samples that fell due since the last tick,
 * and lets the simulated driver (video only, off by default) answer. Safe to call often.
 */
export async function POST(request: Request) {
  const result = await syncTelemetry()
  await simDriverStep(new URL(request.url).origin)
  return NextResponse.json(result)
}
