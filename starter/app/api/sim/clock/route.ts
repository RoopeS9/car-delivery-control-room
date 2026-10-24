import { NextResponse } from "next/server"
import { resetSimClock, simNow } from "@/lib/cr/clock"
import { syncTelemetry } from "@/lib/sim/sync"

export const runtime = "nodejs"

/**
 * Jump the sim clock forward ({ minutes: 5 | 15 | 60 }) so follow-ups and reply
 * deadlines come due without waiting. Telemetry catches up, then the agent's
 * case timers run once (stream A's /api/cases/tick).
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { minutes?: unknown } | null
  const minutes = Number(body?.minutes)
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 120) {
    return NextResponse.json({ error: "minutes must be between 1 and 120." }, { status: 400 })
  }
  const from = simNow()
  resetSimClock(new Date(from.getTime() + minutes * 60_000).toISOString())
  const telemetry = await syncTelemetry()
  const caseTimers = await fetch(new URL("/api/cases/tick", request.url), { method: "POST" })
    .then((response) => response.ok ? "ran" : "not available")
    .catch(() => "not available")
  return NextResponse.json({ from: from.toISOString(), now: simNow().toISOString(), telemetry, caseTimers })
}
