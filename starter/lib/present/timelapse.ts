// The storyline of the map timelapse for the demo video (video/TIMELAPSE-BRIEF.md): a made-up, deterministic busy day.
// Pure: the same orders, seed and duration always give the same events. Nothing here reads a database or calls a model,
// and nothing here is a measurement; the page that plays it says "simulated" and carries the caption in `TIMELAPSE_CAPTION`.
// Times are film seconds from the start of the run. The last event has cleared and faded before the calm final frame.

export const TIMELAPSE_CAPTION = "Illustrative timelapse of simulated events."
export const DEFAULT_SEED = 21102026
export const DEFAULT_DURATION = 15
/** The calm final frame holds this long, in film seconds, with every event cleared. */
export const CALM_HOLD = 1.5
/** A cleared mark fades for this long after its end time. */
export const FADE = 0.8
/** The simulated day the film runs through. */
export const DAY_START = "2026-10-21T09:00:00Z"
export const DAY_END = "2026-10-21T21:00:00Z"

export type TimelapseOrder = {
  orderId: string
  reference: string
  vehicle: string
  driver: string | null
  /** An open item the dataset itself shows for this order, in the queue's plain wording; null if none. */
  problem: string | null
}

export type Outcome = "agent" | "person"
export type Scenario = "A" | "C" | "F" | "G"

export type TimelapseEvent = {
  id: string
  orderId: string
  reference: string
  vehicle: string
  driver: string | null
  /** Plain wording for what went wrong. */
  what: string
  /** One of the four demo scenarios the rest of the video shows, else null. */
  scenario: Scenario | null
  /** The problem appears as a red pulse. */
  start: number
  /** The agent starts working (teal) and stops here. */
  agentFrom: number
  agentUntil: number
  outcome: Outcome
  /** `agent`: cleared by the agent at this time. `person`: needs a person from `agentUntil` to this time, then cleared by a person. */
  end: number
}

/** The named demo scenarios, by the order they play on (starter/lib/sim/scenarios.ts). */
export const NAMED: { scenario: Scenario; reference: string; outcome: Outcome; what: string }[] = [
  { scenario: "A", reference: "CD-420584", outcome: "person", what: "Warning light and the engine is misfiring" },
  { scenario: "C", reference: "CD-420145", outcome: "agent", what: "Driver asks where to leave the keys" },
  { scenario: "F", reference: "CD-420537", outcome: "person", what: "Driver is not answering" },
  { scenario: "G", reference: "CD-420439", outcome: "person", what: "A light that is usually not critical" },
]

/** Wording for open items other orders do not already carry, in the same plain words the queue uses. */
const FILLER = ["Warning light on", "Phone has gone quiet", "Missed ferry connection", "Late for the pickup", "Driver asks about the delivery address", "Car stopped on the road"]

const TOTAL = 24
const PERSON_TOTAL = 8

/** Small seeded generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const round = (n: number) => Math.round(n * 100) / 100

export function buildTimelapse(orders: TimelapseOrder[], seed: number = DEFAULT_SEED, duration: number = DEFAULT_DURATION): TimelapseEvent[] {
  const random = rng(seed)
  // Fisher-Yates, so the order never depends on how an engine sorts with an inconsistent comparator.
  const shuffle = <T,>(list: T[]) => {
    for (let i = list.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1))
      ;[list[i], list[j]] = [list[j], list[i]]
    }
  }
  const pick = (low: number, high: number) => low + random() * (high - low)
  const scale = Math.max(0.3, duration / DEFAULT_DURATION)
  /** The last moment an event may end, so it has faded before the calm frame. */
  const limit = duration - CALM_HOLD - FADE

  const byRef = new Map(orders.map((order) => [order.reference, order]))
  const named = NAMED.flatMap((entry) => {
    const order = byRef.get(entry.reference)
    return order ? [{ ...entry, order }] : []
  })
  const taken = new Set(named.map((entry) => entry.order.orderId))
  const others = orders.filter((order) => !taken.has(order.orderId))
  // Seeded shuffle, then orders with a real open item first so the day uses the dataset's own problems.
  shuffle(others)
  others.sort((a, b) => Number(!!b.problem) - Number(!!a.problem))
  const fillers = others.slice(0, Math.max(0, TOTAL - named.length))

  const personNamed = named.filter((entry) => entry.outcome === "person")
  const personFillers = Math.max(0, Math.min(fillers.length, PERSON_TOTAL - personNamed.length))
  const events: Omit<TimelapseEvent, "id">[] = []
  const make = (order: TimelapseOrder, what: string, scenario: Scenario | null, outcome: Outcome, start: number, work: number, wait: number) => {
    const agentFrom = start + 0.4 * scale
    const agentUntil = agentFrom + work
    events.push({ orderId: order.orderId, reference: order.reference, vehicle: order.vehicle, driver: order.driver, what, scenario, start: round(start), agentFrom: round(agentFrom), agentUntil: round(agentUntil), outcome, end: round(outcome === "agent" ? agentUntil : agentUntil + wait) })
  }

  // People: seven overlap around the middle (the peak), F comes late and clears just before the calm frame.
  const middle = limit * 0.5
  const clusterNamed = personNamed.filter((entry) => entry.scenario !== "F")
  const finale = personNamed.find((entry) => entry.scenario === "F")
  const cluster: { order: TimelapseOrder; what: string; scenario: Scenario | null }[] = []
  let fillerIndex = 0
  const nextFiller = (): TimelapseOrder | null => fillers[fillerIndex++] ?? null
  const wording = (order: TimelapseOrder) => order.problem ?? FILLER[Math.floor(random() * FILLER.length)]
  for (const entry of clusterNamed) cluster.push({ order: entry.order, what: entry.what, scenario: entry.scenario })
  while (cluster.length < Math.min(7, PERSON_TOTAL - (finale ? 1 : 0))) {
    const order = nextFiller()
    if (!order) break
    cluster.push({ order, what: wording(order), scenario: null })
  }
  // Interleave so the named scenarios are not all first.
  shuffle(cluster)
  cluster.forEach((entry, index) => {
    const wait = pick(2.6, 3.8) * scale
    const work = pick(1, 2.2) * scale
    const personFrom = middle - 1.5 * scale + index * 0.34 * scale
    make(entry.order, entry.what, entry.scenario, "person", personFrom - work - 0.4 * scale, work, wait)
  })
  if (finale) {
    const work = 2 * scale
    const wait = 3 * scale
    make(finale.order, finale.what, "F", "person", limit - wait - work - 0.4 * scale, work, wait)
  }

  // The agent handles the rest, spread over the whole day; C sits early.
  const agentOrders: { order: TimelapseOrder; what: string; scenario: Scenario | null }[] = []
  const keys = named.find((entry) => entry.scenario === "C")
  if (keys) agentOrders.push({ order: keys.order, what: keys.what, scenario: "C" })
  const wanted = TOTAL - events.length - agentOrders.length
  for (let i = 0; i < wanted; i += 1) {
    const order = nextFiller()
    if (!order) break
    agentOrders.push({ order, what: wording(order), scenario: null })
  }
  agentOrders.forEach((entry, index) => {
    const work = pick(1, 3) * scale
    const slots = agentOrders.length
    const span = limit - 0.5 - work - 0.4 * scale
    const evenly = 0.4 + (span - 0.4) * ((index + 0.5) / slots)
    const start = entry.scenario === "C" ? limit * 0.2 : Math.max(0.3, Math.min(span, evenly + pick(-0.3, 0.3) * scale))
    make(entry.order, entry.what, entry.scenario, "agent", start, work, 0)
  })

  events.sort((a, b) => a.start - b.start || a.reference.localeCompare(b.reference))
  return events.map((event, index) => ({ id: `ev-${String(index + 1).padStart(2, "0")}`, ...event }))
}

export type EventPhase = "none" | "pulse" | "agent" | "person" | "cleared-agent" | "cleared-person"

/** Where an event is at film time `t`. Cleared events keep their tick for `FADE` seconds after they end. */
export function phaseAt(event: TimelapseEvent, t: number): EventPhase {
  if (t < event.start) return "none"
  if (t < event.agentFrom) return "pulse"
  if (t < event.agentUntil) return "agent"
  if (event.outcome === "person" && t < event.end) return "person"
  if (t < event.end + FADE) return event.outcome === "agent" ? "cleared-agent" : "cleared-person"
  return "none"
}

export type Tally = { needAPerson: number; agentHandled: number; personDecided: number }

/** The counters at film time `t`. Only events actually cleared by then are counted. */
export function tallyAt(events: TimelapseEvent[], t: number): Tally {
  let needAPerson = 0
  let agentHandled = 0
  let personDecided = 0
  for (const event of events) {
    if (event.outcome === "person" && t >= event.agentUntil && t < event.end) needAPerson += 1
    if (t >= event.end) {
      if (event.outcome === "agent") agentHandled += 1
      else personDecided += 1
    }
  }
  return { needAPerson, agentHandled, personDecided }
}

/** Film time to simulated time: the day runs from the start to the calm frame, then holds at the evening. */
export function simTimeAt(t: number, duration: number): Date {
  const from = Date.parse(DAY_START)
  const to = Date.parse(DAY_END)
  const run = Math.max(0.001, duration - CALM_HOLD)
  return new Date(from + (to - from) * Math.max(0, Math.min(1, t / run)))
}
