// The simulated clock (PLAN.md 4.1): SIM_NOW plus real time elapsed since the
// process started. It shares its anchor on globalThis with stream A's
// `lib/cr/clock.ts` (same key), so calls and case events line up once merged.

const DEFAULT_SIM_NOW = "2026-10-21T09:00:00Z"

const holder = globalThis as unknown as { __crClockAnchor?: { real: number; sim: number } }

export function simNow(): Date {
  if (!holder.__crClockAnchor) {
    const sim = Date.parse(process.env.SIM_NOW ?? DEFAULT_SIM_NOW)
    holder.__crClockAnchor = { real: Date.now(), sim: Number.isFinite(sim) ? sim : Date.parse(DEFAULT_SIM_NOW) }
  }
  const { real, sim } = holder.__crClockAnchor
  return new Date(sim + (Date.now() - real))
}
