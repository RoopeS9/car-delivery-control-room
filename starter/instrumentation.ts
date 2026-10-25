// Runs once when the server starts. The simulated clock restarts at SIM_NOW on every process start, while the
// stored events and telemetry may already be hours past that (a rebuild mid-demo, a sandbox restart). A clock
// behind its own records makes every "new message since" check wrong, so the clock is moved up to the newest
// record first. The deploy script does the same from outside; this covers every other start.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || !process.env.DATABASE_URL) return
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
}
