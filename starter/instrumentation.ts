// Runs once when the server starts. The simulated clock lives in memory and starts at SIM_NOW, so before any request
// is served it moves up to the newest stored sample or event; otherwise a decision made right after a restart would
// be stamped before the events it answers.

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return
  try {
    const { catchUpClock } = await import("./lib/sim/sync")
    await catchUpClock()
  } catch (error) {
    // No database yet (a first start before db:push): the first telemetry sync tries again.
    console.warn("Road Desk: the simulated clock could not catch up at start", error instanceof Error ? error.message : error)
  }
}
