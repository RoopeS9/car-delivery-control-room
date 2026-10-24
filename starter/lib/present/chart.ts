// The home chart: every order as a node on the map, styled like a traffic
// viewer. Moving cars are drawn where their simulated phone last reported, with
// heading and a short trail; orders that are not moving sit at their city as a
// berth, which is a place in the records, not a position. Attention comes from
// the same queue the old home page used, so the chart and /queue agree.

import type { FleetCar } from "@/lib/sim/fleet"
import { cityPoint, terminalPoint, type LatLng } from "@/lib/sim/geo"
import { deriveKeyDates, milestones } from "./attention"
import type { Bundle } from "./bundle"
import { rows, str } from "./bundle"
import { laneLabel } from "./labels"
import { buildQueue } from "./queue"
import { minutesBetween, relativeTo } from "./time"
import type { QueueRow, Tone } from "./types"

/** A phone that has not reported for this long is drawn hollow, with "last seen". */
export const CHART_STALE_MINUTES = 30

export type ChartAttention = "decide" | "agent" | "waiting" | "fine"

export type ChartGps = { lat: number; lng: number; heading: number | null; speedKmh: number | null; at: string; placeLabel: string | null }

export type ChartNode = {
  orderId: string
  reference: string
  vehicle: string
  make: string | null
  customer: string
  driver: string | null
  from: string
  to: string
  lane: string
  laneLabel: string
  /** `vessel`: a simulated phone position. `berth`: placed at its city from the records, not a position. */
  kind: "vessel" | "berth"
  lat: number
  lng: number
  /** City the berth sits in ("Cologne|DE"); vessels have none. */
  berth: string | null
  berthNote: string | null
  heading: number | null
  speedKmh: number | null
  /** When the phone reported (vessels only). */
  at: string | null
  ageLabel: string | null
  stale: boolean
  /** "On the road between Turku and Seinäjoki", "On the ferry to …", simulated. */
  placeLabel: string | null
  /** Recent simulated positions, oldest first. */
  trail: LatLng[]
  attention: ChartAttention
  tone: Tone
  /** One line: what is going on, from the queue row. */
  headline: string | null
  ask: string | null
  /** Changes when anything a person would notice changes, so the client can pulse the node. */
  sig: string
}

/** A route track, only sent for drawing on hover or selection. */
export type ChartRoute = { parts: { kind: "road" | "sea"; label: string; coords: LatLng[] }[]; simulated: true }

export type ChartPort = { id: string; kind: "terminal" | "dealer" | "yard"; name: string; lat: number; lng: number; count: number }

export type ChartCard = {
  orderId: string
  reference: string
  vehicle: string
  headline: string
  ask: string | null
  tone: Tone
  since: string | null
  sinceLabel: string
  source: string
}

export type ChartView = {
  simNow: string
  snapshotAt: string | null
  nodes: ChartNode[]
  routes: Record<string, ChartRoute>
  ports: ChartPort[]
  counts: { moving: number; booked: number; atPickup: number; deliveredToday: number; noPosition: number }
  /** Needs a person now, most urgent first. */
  needs: ChartCard[]
  /** Closed by the agent in the last day of simulated time. */
  handled: ChartCard[]
  /** Orders the queue keeps out of the way (routine records, agent working, waiting). */
  quiet: { agentWorking: number; waiting: number; routine: number }
}

export type GpsSample = { orderId: string; at: string; lat: number; lng: number; heading: number | null; speedKmh: number | null; placeLabel: string | null }

const RANK: Record<ChartAttention, number> = { decide: 0, agent: 1, waiting: 2, fine: 3 }

function card(row: QueueRow, source: string): ChartCard {
  return {
    orderId: row.orderId, reference: row.reference, vehicle: row.vehicle, headline: row.headline, ask: row.ask,
    tone: row.tone, since: row.since, sinceLabel: row.sinceLabel, source,
  }
}

/** Same UTC calendar day. */
function sameDay(a: string, b: string): boolean {
  return a.slice(0, 10) === b.slice(0, 10)
}

export function buildChart(input: { bundles: Bundle[]; fleet: FleetCar[]; samples: GpsSample[]; snapshotAt: string | null; now: string }): ChartView {
  const { bundles, fleet, samples, snapshotAt, now } = input
  const queue = buildQueue(bundles, snapshotAt, now)
  const attentionOf = new Map<string, { attention: ChartAttention; row: QueueRow }>()
  for (const row of queue.decide) attentionOf.set(row.orderId, { attention: "decide", row })
  for (const row of queue.agentWorking) if (!attentionOf.has(row.orderId)) attentionOf.set(row.orderId, { attention: "agent", row })
  for (const row of queue.waiting) if (!attentionOf.has(row.orderId)) attentionOf.set(row.orderId, { attention: "waiting", row })

  const samplesByOrder = new Map<string, GpsSample[]>()
  for (const sample of samples) {
    const list = samplesByOrder.get(sample.orderId) ?? []
    list.push(sample)
    samplesByOrder.set(sample.orderId, list)
  }
  for (const list of samplesByOrder.values()) list.sort((a, b) => a.at.localeCompare(b.at))
  const carByOrder = new Map(fleet.map((car) => [car.orderId, car]))

  const nodes: ChartNode[] = []
  const routes: Record<string, ChartRoute> = {}
  const counts = { moving: 0, booked: 0, atPickup: 0, deliveredToday: 0, noPosition: 0 }

  for (const bundle of bundles) {
    const lane = bundle.order.lane
    if (lane === "cancelled") continue
    const primary = bundle.items.find((item) => item.role === "PRIMARY") ?? bundle.items[0] ?? null
    const from = bundle.places.get(bundle.order.pickupAddressId)
    const to = bundle.places.get(bundle.order.deliveryAddressId)
    const vehicle = primary ? `${primary.vehicle.make} ${primary.vehicle.model}` : "Vehicle not linked"
    const car = carByOrder.get(bundle.order.id)
    const active = rows(bundle, "work_assignments").find((row) => ["IN_PROGRESS", "ASSIGNED", "ACCEPTED"].includes(str(row.details.status) ?? ""))
    const driver = car?.driverName ?? (active ? bundle.dir.driverName(active.details.driver_id) : null)
    const found = attentionOf.get(bundle.order.id)
    const attention = found?.attention ?? "fine"
    const tone: Tone = found?.row.tone ?? "neutral"
    const { deliveredAt } = milestones(bundle)
    const { keyDates } = deriveKeyDates(bundle)

    if (lane === "moving") counts.moving += 1
    if (lane === "booked") {
      counts.booked += 1
      const slot = keyDates.find((date) => date.key === "pickup_slot")
      if (slot && slot.start <= now) counts.atPickup += 1
    }
    if (deliveredAt && sameDay(deliveredAt, now)) counts.deliveredToday += 1

    if (car) routes[bundle.order.id] = { parts: car.parts.map((part) => ({ kind: part.kind, label: part.label, coords: part.coords })), simulated: true }

    const base = {
      orderId: bundle.order.id, reference: bundle.order.reference, vehicle, make: primary?.vehicle.make ?? null,
      customer: bundle.customer.name, driver, from: from?.city ?? "Unknown", to: to?.city ?? "Unknown",
      lane, laneLabel: laneLabel(lane), attention, tone,
      headline: found?.row.headline ?? null, ask: found?.row.ask ?? null,
    }
    const track = samplesByOrder.get(bundle.order.id) ?? []
    const last = track.at(-1)
    if (lane === "moving" && last) {
      const minutes = minutesBetween(last.at, now) ?? 0
      const rel = relativeTo(last.at, now)
      const stale = minutes > CHART_STALE_MINUTES || car?.phone === "STALE"
      nodes.push({
        ...base, kind: "vessel", lat: last.lat, lng: last.lng, berth: null, berthNote: null,
        heading: last.heading, speedKmh: stale ? null : last.speedKmh, at: last.at,
        ageLabel: rel ? (rel.text === "now" ? "just now" : rel.text) : null, stale,
        placeLabel: last.placeLabel, trail: track.slice(-12).map((sample) => [sample.lat, sample.lng] as LatLng),
        sig: [attention, found?.row.headline ?? "", found?.row.statusLabel ?? "", stale ? "stale" : "live"].join("|"),
      })
      continue
    }
    if (lane === "moving") counts.noPosition += 1
    // Not moving, or moving with no phone report: a berth at the city the records name.
    const place = lane === "delivered" ? to : from
    if (!place) continue
    const point = cityPoint(place.city, place.country)
    if (!point) continue
    const berthNote = lane === "delivered" ? `Delivered in ${place.city}` : lane === "moving" ? `Moving, but the driver app has not reported a position. Shown at the pickup city.` : `At the pickup city, ${place.city}. A place in the records, not a position.`
    nodes.push({
      ...base, kind: "berth", lat: point[0], lng: point[1], berth: `${place.city}|${place.country}`, berthNote,
      heading: null, speedKmh: null, at: null, ageLabel: null, stale: false, placeLabel: null, trail: [],
      sig: [attention, found?.row.headline ?? "", found?.row.statusLabel ?? "", lane].join("|"),
    })
  }
  nodes.sort((a, b) => RANK[b.attention] - RANK[a.attention] || a.reference.localeCompare(b.reference))

  // Ports: the four ferry terminals, then dealers and yards grouped by city.
  const ports: ChartPort[] = []
  for (const id of ["terminal-west-baltic", "terminal-south-baltic", "terminal-east-nordic", "terminal-south-finland"]) {
    const terminal = terminalPoint(id)
    if (terminal) ports.push({ id, kind: "terminal", name: terminal.name, lat: terminal.point[0], lng: terminal.point[1], count: 1 })
  }
  const sites = bundles[0]?.sites ?? new Map()
  const byCity = new Map<string, ChartPort>()
  for (const site of sites.values()) {
    const point = cityPoint(site.city, site.country)
    if (!point) continue
    const kind = site.kind === "TRANSFER_YARD" || site.kind === "INDEPENDENT_STORAGE" ? "yard" : "dealer"
    const key = `${kind}:${site.city}|${site.country}`
    const known = byCity.get(key)
    if (known) known.count += 1
    else byCity.set(key, { id: key, kind, name: site.city, lat: point[0], lng: point[1], count: 1 })
  }
  ports.push(...byCity.values())

  return {
    simNow: now, snapshotAt, nodes, routes, ports, counts,
    needs: queue.decide.map((row) => card(row, row.origin === "agent" ? "Road agent" : "From the records")),
    handled: queue.handled.map((row) => card(row, "Road agent")),
    quiet: { agentWorking: queue.agentWorking.length, waiting: queue.waiting.length, routine: queue.routine.length },
  }
}
