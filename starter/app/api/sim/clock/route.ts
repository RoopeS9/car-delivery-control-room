import { NextResponse } from "next/server"
import { advanceSimClock, simNow } from "@/lib/cr/clock"
import type { TickResponse } from "@/lib/cr/types"
import { autopilotStep } from "@/lib/sim/autopilot"
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
  advanceSimClock(minutes)
  const telemetry = await syncTelemetry()
  const caseTimers = await fetch(new URL("/api/cases/tick", request.url), { method: "POST" })
    .then(async (response) => {
      if (!response.ok) return { ran: false as const }
      const tick = (await response.json()) as TickResponse
      return { ran: true as const, followedUp: tick.followed_up.length, escalated: tick.escalated.length }
    })
    .catch(() => ({ ran: false as const }))
  // A jump can bring a check due (a ferry cutoff, a quiet phone): the autopilot looks at once.
  const autopilot = await autopilotStep(new URL(request.url).origin).then((status) => ({ due: status.due.length, calling: status.inFlight?.reference ?? null })).catch(() => null)
  return NextResponse.json({ from: from.toISOString(), now: simNow().toISOString(), telemetry, caseTimers, autopilot })
}
