import { NextResponse } from "next/server"
import { syncTelemetry } from "@/lib/sim/sync"

export const runtime = "nodejs"

/** Writes the simulated GPS and OBD samples that fell due since the last tick. Safe to call often. */
export async function POST() {
  return NextResponse.json(await syncTelemetry())
}
