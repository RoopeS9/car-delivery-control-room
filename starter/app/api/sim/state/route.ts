import { NextResponse } from "next/server"
import { fleetOverview } from "@/lib/sim/status"

export const runtime = "nodejs"

/** The sim clock and every moving car's simulated state, for the demo panel. */
export async function GET() {
  return NextResponse.json(await fleetOverview())
}
