// Runs once when the server starts. The simulated clock restarts at SIM_NOW on every process start, while the
// stored events and telemetry may already be hours past that (a rebuild mid-demo, a sandbox restart). A clock
// behind its own records makes every "new message since" check wrong, so the clock is moved up to the newest
// record first. The deploy script does the same from outside; this covers every other start.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || !process.env.DATABASE_URL) return
  try {
    const { catchUpSimClock } = await import("@/lib/cr/clock-catchup")
    const moved = await catchUpSimClock()
    if (moved) console.log(`Road Desk: simulated clock moved up ${moved} min to the newest stored record`)
  } catch (error) {
    console.error("Road Desk: clock catch-up skipped", error instanceof Error ? error.message : error)
  }
}
