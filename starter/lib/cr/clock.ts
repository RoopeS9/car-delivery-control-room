// The simulated clock. The dataset is a snapshot at 2026-10-21 09:00 UTC, so
// our new events continue from there: SIM_NOW plus the real time elapsed since
// this process started (or since the last reset). Every "x min ago" uses this.

const DEFAULT_SIM_NOW = "2026-10-21T09:00:00Z"

const holder = globalThis as unknown as { __crClockAnchor?: { real: number; sim: number } }

function anchor() {
  if (!holder.__crClockAnchor) {
    const sim = Date.parse(process.env.SIM_NOW ?? DEFAULT_SIM_NOW)
    holder.__crClockAnchor = { real: Date.now(), sim: Number.isFinite(sim) ? sim : Date.parse(DEFAULT_SIM_NOW) }
  }
  return holder.__crClockAnchor
}

export function simNow(): Date {
  const { real, sim } = anchor()
  return new Date(sim + (Date.now() - real))
}

export function simNowIso(): string {
  return simNow().toISOString()
}

/** Restart the clock at SIM_NOW (or at `to`). Used by the demo reset. */
export function resetSimClock(to?: string): void {
  holder.__crClockAnchor = undefined
  if (to) holder.__crClockAnchor = { real: Date.now(), sim: Date.parse(to) }
}
