// The home chart: every order as a node on the map, styled like a traffic
// viewer. Moving cars are drawn where their simulated phone last reported, with
// heading and a short trail; orders that are not moving sit at their city as a
// berth, which is a place in the records, not a position. Attention comes from
// the same queue the old home page used, so the chart and /queue agree.

import type { FleetCar } from "@/lib/sim/fleet"
import { bearing, cityPoint, terminalPoint, type LatLng } from "@/lib/sim/geo"
import { deriveKeyDates, milestones } from "./attention"
import type { Bundle } from "./bundle"
import { rows, str } from "./bundle"
import { laneLabel } from "./labels"
import { buildQueue } from "./queue"
import { minutesBetween, relativeTo } from "./time"
import type { QueueRow, Tone } from "./types"

/** A phone that has not reported for this long is drawn hollow, with "last seen". */
export const CHART_STALE_MINUTES = 30

/** The tone scale: red needs a person, amber watching (deadline near, silent gap, waiting, conflict), teal agent working, grey fine. */
export type ChartAttention = "decide" | "watch" | "agent" | "fine"

/** What kind of place a location mark is. */
export type PlaceKind = "dealer" | "yard" | "private"

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
  /** Watching: why, in a few words. */
  watchReason: string | null
  /** Pickup and delivery place names, and the promise in the delivery's zone ("Mon 10:00 to 16:00"). */
  fromName: string
  toName: string
  promiseText: string | null
  /** Cars only. `moving`: on the road, or should be by now (drawn as a chevron). `waiting`: waiting for something (a circle). */
  motion: "moving" | "waiting" | null
  /** For a waiting car, what it waits for; for a car that should be moving, why it is drawn at the pickup. */
  motionNote: string | null
  /** Berths: what kind of place the order waits at. */
  placeKind: PlaceKind | null
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

export type ChartPort = { id: string; kind: "terminal"; name: string; lat: number; lng: number; count: number }

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

const RANK: Record<ChartAttention, number> = { decide: 0, watch: 1, agent: 2, fine: 3 }

function card(row: QueueRow, source: string): ChartCard {
  return {
    orderId: row.orderId, reference: row.reference, vehicle: row.vehicle, headline: row.headline, ask: row.ask,
    tone: row.tone, since: row.since, sinceLabel: row.sinceLabel, source,
  }
}

const PERSON_SOURCES = new Set(["Work item", "Incident", "Support inbox", "Earlier agent proposal"])

/** A queue row that is a decision waiting for a person, as opposed to a signal worth watching. */
/** What the person is needed for: the agent's headline, else the operator item among the records' reasons. */
function personHeadline(row: QueueRow): string {
  if (row.origin === "agent") return row.headline
  return row.reasons.find((reason) => PERSON_SOURCES.has(reason.source))?.text ?? row.headline
}

export function needsPerson(row: QueueRow): boolean {
  if (row.origin === "agent") return true
  return row.reasons.some((reason) => PERSON_SOURCES.has(reason.source))
}

/** "Mon 10:00" in a zone. */
function weekdayClock(iso: string, zone: string | null): string {
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: zone ?? "UTC" }).format(new Date(iso)).replace(",", "")
}

function clockIn(iso: string, zone: string | null): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: zone ?? "UTC" }).format(new Date(iso))
}

/** Same UTC calendar day. */
function sameDay(a: string, b: string): boolean {
  return a.slice(0, 10) === b.slice(0, 10)
}

export function buildChart(input: { bundles: Bundle[]; fleet: FleetCar[]; samples: GpsSample[]; snapshotAt: string | null; now: string }): ChartView {
  const { bundles, fleet, samples, snapshotAt, now } = input
  const queue = buildQueue(bundles, snapshotAt, now)
  const attentionOf = new Map<string, { attention: ChartAttention; row: QueueRow }>()
  // Red means a decision is actually waiting for a person: one of the agent's cards or hand-overs, or an operator item
  // in the records (a work item, an incident, a support thread). An open alert or a conversation is a signal: amber.
  for (const row of queue.decide) attentionOf.set(row.orderId, { attention: needsPerson(row) ? "decide" : "watch", row })
  for (const row of queue.agentWorking) if (!attentionOf.has(row.orderId)) attentionOf.set(row.orderId, { attention: "agent", row })
  for (const row of queue.watch) if (!attentionOf.has(row.orderId)) attentionOf.set(row.orderId, { attention: "watch", row })
  for (const row of queue.waiting) if (!attentionOf.has(row.orderId)) attentionOf.set(row.orderId, { attention: "watch", row })

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
    const { deliveredAt } = milestones(bundle)
    const { keyDates } = deriveKeyDates(bundle)
    // Watching, derived from the records only: a date at risk, a silent phone, an unconfirmed ferry check-in near its cutoff, a conflict, or a wait.
    const track = samplesByOrder.get(bundle.order.id) ?? []
    const lastFix = track.at(-1)
    const phoneQuiet = lane === "moving" && ((!!lastFix && (minutesBetween(lastFix.at, now) ?? 0) > CHART_STALE_MINUTES) || car?.phone === "STALE")
    const riskyDate = keyDates.find((date) => (date.key === "promise" || date.key === "pickup_slot" || date.key === "eta") && (date.tone === "danger" || date.tone === "warn"))
    const cutoffNear = !deliveredAt && rows(bundle, "travel_reservations").some((row) => {
      const cutoff = str(row.details.check_in_cutoff_at)
      const minutes = cutoff ? minutesBetween(now, cutoff) : null
      return row.details.kind === "FERRY" && row.details.status === "BOOKED" && row.details.check_in_confirmation !== "CONFIRMED_BY_GATE_SCAN" && minutes != null && minutes >= 0 && minutes < 6 * 60
    })
    const conflict = rows(bundle, "endpoint_claims").some((row) => !str(row.details.resolved_at) && str(row.details.status) !== "RESOLVED")
    const signalRow = found && !needsPerson(found.row) && found.attention === "watch" ? found.row : null
    const watchReason = signalRow && found?.row.origin === "records" && (queue.decide.includes(found.row) || queue.watch.includes(found.row)) ? found.row.headline.replace(/^Open alert: /, "") : riskyDate ? `${riskyDate.label}: ${riskyDate.note ?? "at risk"}` : cutoffNear ? "Ferry check-in closes soon, no gate scan yet" : phoneQuiet ? "Phone quiet" : conflict ? "Two records disagree" : found?.attention === "watch" ? found.row.statusLabel : null
    const attention: ChartAttention = found && found.attention !== "watch" ? found.attention : watchReason ? "watch" : "fine"
    const tone: Tone = attention === "decide" ? (found?.row.tone ?? "danger") : attention === "watch" ? "warn" : attention === "agent" ? "accent" : "neutral"
    const promise = keyDates.find((date) => date.key === "promise")
    const promiseText = promise ? `${weekdayClock(promise.start, promise.zone)}${promise.end ? ` to ${clockIn(promise.end, promise.zone)}` : ""}` : null
    const pickupSite = from?.managedSiteId ? bundle.sites.get(from.managedSiteId) : null
    const deliverySite = to?.managedSiteId ? bundle.sites.get(to.managedSiteId) : null

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
      headline: found ? (attention === "decide" ? personHeadline(found.row) : found.attention === "watch" && watchReason ? watchReason : found.row.headline) : attention === "watch" ? watchReason : null, ask: found?.row.ask ?? null,
      watchReason, fromName: from?.name ?? from?.city ?? "Pickup", toName: to?.name ?? to?.city ?? "Delivery", promiseText,
    }
    const last = lastFix
    if (lane === "moving" && last) {
      const minutes = minutesBetween(last.at, now) ?? 0
      const rel = relativeTo(last.at, now)
      const stale = minutes > CHART_STALE_MINUTES || car?.phone === "STALE"
      const where = last.placeLabel ?? ""
      const waitNote = /^At /.test(where) ? "Parked at the terminal before check-in" : /^Near the delivery/.test(where) ? "At the delivery, waiting for the receiver"
        : /^Stopped|^Pulling into|service area/i.test(where) || car?.stoppedNote ? (car?.stoppedNote ? "Stopped with a fault" : "Stopped")
        : /^Last app position/.test(where) ? null : (last.speedKmh ?? 0) <= 0 ? "Stopped" : null
      nodes.push({
        ...base, kind: "vessel", lat: last.lat, lng: last.lng, berth: null, berthNote: null,
        motion: waitNote ? "waiting" : "moving", motionNote: waitNote,
        placeKind: null, heading: last.heading, speedKmh: stale ? null : last.speedKmh, at: last.at,
        ageLabel: rel ? (rel.text === "now" ? "just now" : rel.text) : null, stale,
        placeLabel: last.placeLabel, trail: track.slice(-12).map((sample) => [sample.lat, sample.lng] as LatLng),
        sig: [attention, found?.row.headline ?? "", found?.row.statusLabel ?? "", watchReason ?? "", stale ? "stale" : "live"].join("|"),
      })
      continue
    }
    if (lane === "moving") counts.noPosition += 1
    // A booked car whose leg has started or whose slot has passed with no pickup should be moving now: a car mark at the
    // pickup, pointed along the route ahead. One with a site visit recorded waits at the desk instead.
    const slot = keyDates.find((date) => date.key === "pickup_slot")
    const started = rows(bundle, "work_assignments").some((row) => row.details.status === "IN_PROGRESS")
    const shouldMove = lane === "booked" && !deliveredAt && (started || (!!slot && slot.start <= now))
    const fromPoint = from ? cityPoint(from.city, from.country) : null
    const toPoint = to ? cityPoint(to.city, to.country) : null
    if (shouldMove && fromPoint) {
      const atDesk = rows(bundle, "site_visits").some((row) => !str(row.details.left_at))
      nodes.push({
        ...base, kind: "vessel", lat: fromPoint[0], lng: fromPoint[1], berth: null, placeKind: null,
        berthNote: null, motion: atDesk ? "waiting" : "moving",
        motionNote: atDesk ? "At the pickup desk, waiting for the car or keys" : started ? "The leg has started; no phone position yet, drawn at the pickup" : "The pickup slot has started; no pickup recorded, drawn at the pickup",
        heading: toPoint ? bearing(fromPoint, toPoint) : null, speedKmh: null, at: null, ageLabel: null, stale: false,
        placeLabel: `Pickup city ${from?.city ?? ""}, from the records; not a phone position`, trail: [],
        sig: [attention, found?.row.headline ?? "", found?.row.statusLabel ?? "", watchReason ?? "", "should-move"].join("|"),
      })
      continue
    }
    // Not moving, or moving with no phone report: a berth at the city the records name.
    const place = lane === "delivered" ? to : from
    if (!place) continue
    const point = cityPoint(place.city, place.country)
    if (!point) continue
    const berthNote = lane === "delivered" ? `Delivered in ${place.city}` : lane === "moving" ? `Moving, but the driver app has not reported a position. Shown at the pickup city.` : `At the pickup city, ${place.city}. A place in the records, not a position.`
    const site = lane === "delivered" ? deliverySite : pickupSite
    const placeKind: PlaceKind = !site ? "private" : site.kind === "TRANSFER_YARD" || site.kind === "INDEPENDENT_STORAGE" ? "yard" : "dealer"
    nodes.push({
      ...base, kind: "berth", lat: point[0], lng: point[1], berth: `${place.city}|${place.country}`, berthNote, placeKind, motion: null, motionNote: null,
      heading: null, speedKmh: null, at: null, ageLabel: null, stale: false, placeLabel: null, trail: [],
      sig: [attention, found?.row.headline ?? "", found?.row.statusLabel ?? "", watchReason ?? "", lane].join("|"),
    })
  }
  nodes.sort((a, b) => RANK[b.attention] - RANK[a.attention] || a.reference.localeCompare(b.reference))

  // Ports: the four ferry terminals. Dealers, yards and private addresses are the orders' own location marks.
  const ports: ChartPort[] = []
  for (const id of ["terminal-west-baltic", "terminal-south-baltic", "terminal-east-nordic", "terminal-south-finland"]) {
    const terminal = terminalPoint(id)
    if (terminal) ports.push({ id, kind: "terminal", name: terminal.name, lat: terminal.point[0], lng: terminal.point[1], count: 1 })
  }


  return {
    simNow: now, snapshotAt, nodes, routes, ports, counts,
    needs: queue.decide.filter(needsPerson).map((row) => ({ ...card(row, row.origin === "agent" ? "Road agent" : "From the records"), headline: personHeadline(row) })),
    handled: queue.handled.map((row) => card(row, "Road agent")),
    quiet: { agentWorking: queue.agentWorking.length, waiting: queue.waiting.length, routine: queue.routine.length },
  }
}
