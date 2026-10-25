// The Node.js side of instrumentation.ts: the clock catch-up and the heartbeat. Kept apart so the edge build never
// traces the database and filesystem modules these pull in.

export async function registerNode() {
  if (!process.env.DATABASE_URL) return
  try {
    const { catchUpSimClock } = await import("@/lib/cr/clock-catchup")
    // The database may still be starting (it runs in a container next to this process): try for up to three minutes.
    let moved: number | null = null
    for (let attempt = 0; attempt < 36 && moved === null; attempt++) {
      try { moved = await catchUpSimClock() } catch (error) {
        if (attempt === 35) throw error
        await new Promise((ok) => setTimeout(ok, 5000))
      }
    }
    if (moved) console.log(`Road Desk: simulated clock moved up ${moved} min to the newest stored record`)
  } catch (error) {
    console.error("Road Desk: clock catch-up skipped", error instanceof Error ? error.message : error)
  }
  startHeartbeat()
}

/**
 * The simulation keeps running with nobody looking (review R2): every HEARTBEAT_SECONDS the server writes the
 * telemetry that fell due, runs the case timers (reminders, the silent-driver escalation, the watchdog) and the
 * autopilot's checks. The operator pages' polls do the same; this covers a closed tab at 03:00. HEARTBEAT=off stops it.
 */
function startHeartbeat() {
  const holder = globalThis as unknown as { __roadDeskHeartbeat?: NodeJS.Timeout }
  if (holder.__roadDeskHeartbeat || process.env.HEARTBEAT === "off") return
  const seconds = Math.max(5, Number(process.env.HEARTBEAT_SECONDS ?? 20))
  const origin = process.env.APP_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`
  holder.__roadDeskHeartbeat = setInterval(async () => {
    try {
      const [{ syncTelemetry }, { tick }, { autopilotStep }, { simDriverStep }] = await Promise.all([
        import("@/lib/sim/sync"), import("@/lib/agent/tick"), import("@/lib/sim/autopilot"), import("@/lib/sim/sim-driver"),
      ])
      await syncTelemetry()
      await tick()
      await simDriverStep(origin)
      await autopilotStep(origin)
    } catch (error) {
      console.warn("Road Desk heartbeat:", error instanceof Error ? error.message : error)
    }
  }, seconds * 1000)
  holder.__roadDeskHeartbeat.unref()
  console.log(`Road Desk: heartbeat every ${seconds} s (telemetry, case timers, autopilot)`)
}
