// Demo scenarios, started from /demo. Each one changes only our own `cr_`
// tables; the dataset is never touched. Messages from drivers and sites go
// through the real channel routes after the scenario responds, exactly as a
// phone or a browser would send them. `reset` puts the demo back to the
// start: no cases, no events, a fresh sim clock at the snapshot time.

import { and, eq, sql } from "drizzle-orm"
import { beginRuntimeReset, RuntimeBusyError, withRuntimeWork } from "@/lib/cr/activity"
import { advanceSimClock, resetSimClock, simNow } from "@/lib/cr/clock"
import { crDb } from "@/lib/cr/db"
import { appendEvent, insertTelemetry, listCases } from "@/lib/cr/queries"
import { lifecycleOf, MILESTONE_WORDS, nextMilestone, type Milestone } from "@/lib/cr/lifecycle"
import { OPEN_CASE_STATUSES } from "@/lib/cr/types"
import type { DriverMessageRequest, SiteMessageRequest, SourceRef, TelemetryTriggerRequest } from "@/lib/cr/types"
import { orders, relatedRecords } from "@/lib/schema"
import { fleetCar, loadFleet, type FleetCar } from "./fleet"
import { baseMotion, faultMotion, freezeFrame, type MisfirePlan, type OverheatPlan } from "./motion"
import { roughWhere } from "./places"
import { clearDemoData } from "./routine"
import { resetSimDriver } from "./sim-driver"
import { activeFaults, markClockCaughtUp, syncTelemetry } from "./sync"
import { resetAutopilot } from "./autopilot"

export type ScenarioName = "warning-light-584" | "catch-up-322" | "driver-keys-145" | "site-eta-442" | "driver-silent-537" | "sensor-light-439" | "pickup-to-handover-442" | "reset"

export type ScenarioInfo = {
  name: ScenarioName
  title: string
  orderRef: string | null
  description: string
  /** Where the presenter looks while it runs. */
  links: { label: string; href: string }[]
}

export const SCENARIOS: ScenarioInfo[] = [
  {
    name: "warning-light-584",
    title: "A. Fresh warning light",
    orderRef: "CD-420584",
    description: "The Bentley on its way from Cologne to the Hamburg ferry gets a flashing check-engine light and loses power. " +
      "The driver pulls into a service area. The OBD dongle sends misfire codes P0300 and P0302 with a freeze frame, and the agent contacts the driver first.",
    links: [{ label: "Leo Quellford's driver app", href: "/driver?driver=drv-042" }],
  },
  {
    name: "catch-up-322",
    title: "B. Catch up on an open case",
    orderRef: "CD-420322",
    description: "The Bentley has been stopped at a service area since 08:04 with a red warning (already in the records). " +
      "The driver writes again. The agent reads the history; when the driver connects the dongle, it sends stored codes and the phone shares where the car is.",
    links: [{ label: "Kasper Kovelund's driver app", href: "/driver?driver=drv-319" }],
  },
  {
    name: "driver-keys-145",
    title: "C. Routine question, no person needed",
    orderRef: "CD-420145",
    description: "Kasper Carvell, 40 minutes from Helsinki with the Porsche, asks where to leave the car and the keys. The agent answers from the order and site records.",
    links: [{ label: "Kasper Carvell's driver app", href: "/driver?driver=drv-130" }],
  },
  {
    name: "site-eta-442",
    title: "D. Pickup desk asks about the driver",
    orderRef: "CD-420442",
    description: "Uma Aldermere at the Orvendin Cars Stockholm desk (not the customer) asks if the driver is still coming tomorrow morning. " +
      "The agent answers only about this order and says what it does not know.",
    links: [{ label: "Site chat as Uma Aldermere", href: "/site?contact=ep-xf3ba5412ec8d619e" }],
  },
  {
    name: "driver-silent-537",
    title: "F. The driver goes silent",
    orderRef: "CD-420537",
    description: "The Bentley from Cologne to Copenhagen: the app last reported at 08:02. Now the OBD dongle shows the coolant climbing, sets P0217, " +
      "and stops reporting while the car still moves. The agent messages the driver; nobody answers. Jump the clock to pass the reply deadline.",
    links: [{ label: "William Mervalen's driver app (do not answer)", href: "/driver?driver=drv-250" }],
  },
  {
    name: "sensor-light-439",
    title: "G. A light that is usually not critical",
    orderRef: "CD-420439",
    description: "The Ferrari on its way to Lahti reports P0135 (oxygen sensor heater) with a steady check-engine light, and the driver asks what it means. " +
      "A monitor-level code: on chat the agent may explain it and ask a few diagnostic questions, but an operator still confirms whether the driver continues.",
    links: [{ label: "Karin Calverick's driver app", href: "/driver?driver=drv-231" }],
  },
  {
    name: "pickup-to-handover-442",
    title: "H. From pickup to handover",
    orderRef: "CD-420442",
    description: "The next morning in Stockholm: the clock moves to the start of Kasper Darevik's pickup slot at Orvendin Cars. " +
      "In his phone he reports each step: at the pickup, car and keys collected, checked in for the ferry, at the delivery address in Tampere, handed over. " +
      "Run it again after a step to move the clock to the next one's time in the records (the ferry check-in, then the delivery window). " +
      "The map, the order and the board follow each step; the handover brings operations the customer's delivery confirmation to approve.",
    links: [{ label: "Kasper Darevik's driver app", href: "/driver?driver=drv-165&job=CD-420442" }],
  },
  {
    name: "reset",
    title: "Reset the demo",
    orderRef: null,
    description: "Remove every case, message, decision and telemetry sample we added (optionally keeping the agent's seeded routine cases), and restart the sim clock at 09:00 UTC on 21 Oct.",
    links: [],
  },
]

/** The fictional service area where the car in scenario A stops. */
const SERVICE_AREA = "Velmerheide Nord"

/** Work the route does after it has answered, so the presenter is not kept waiting. */
export type SimAction =
  | { kind: "telemetry"; request: TelemetryTriggerRequest }
  | { kind: "driver_message"; request: DriverMessageRequest }
  | { kind: "site_message"; request: SiteMessageRequest }

export type ScenarioResult = {
  ok: boolean
  name: ScenarioName
  message: string
  orderId?: string
  eventId?: string
  actions?: SimAction[]
}

export async function runScenario(name: string, origin: string, options: { keepRoutine?: boolean } = {}): Promise<ScenarioResult> {
  try {
    if (name === "reset") return await reset(options.keepRoutine ?? true)
    return await withRuntimeWork("scenario preparation", () => prepareScenario(name, origin, options))
  } catch (error) {
    if (error instanceof RuntimeBusyError) return { ok: false, name: name as ScenarioName, message: error.message }
    throw error
  }
}

async function prepareScenario(name: string, origin: string, options: { keepRoutine?: boolean }): Promise<ScenarioResult> {
  switch (name) {
    case "warning-light-584": return warningLight584()
    case "catch-up-322": return driverWrites("catch-up-322", "CD-420322",
      "Still waiting at the service area with the Bentley. Has anyone decided who is collecting the car? I need to know if I should stay.")
    case "driver-keys-145": return driverWrites("driver-keys-145", "CD-420145",
      "Hi, I'm about 40 minutes from Helsinki with the Porsche. Where do I leave the car and the keys at Kavornia?")
    case "site-eta-442": return siteWrites("site-eta-442", "CD-420442", "PICKUP",
      "Hi, this is Uma at the Orvendin Cars desk. Is your driver still coming tomorrow morning for the Bentley?")
    case "driver-silent-537": return driverSilent537(origin)
    case "sensor-light-439": return sensorLight439()
    case "pickup-to-handover-442": return pickupToHandover442()
    default: return { ok: false, name: name as ScenarioName, message: `There is no scenario called "${name}".` }
  }
}

async function reset(keepRoutine: boolean): Promise<ScenarioResult> {
  const finishReset = beginRuntimeReset()
  try {
    await clearDemoData({ keepRoutine })
    resetSimDriver()
    resetAutopilot()
    resetSimClock()
    markClockCaughtUp()
  } finally { finishReset() }
  // Polling writes are paused while records are cleared. Regenerate the
  // current clock's samples only after the reset releases its guard.
  await loadFleet({ fresh: true })
  await syncTelemetry()
  return { ok: true, name: "reset", message: `Demo reset${keepRoutine ? ", routine cases kept" : ""}. Sim clock back at ${simNow().toISOString().slice(11, 16)} UTC.` }
}

// ---------------------------------------------------------------- A

async function warningLight584(): Promise<ScenarioResult> {
  const car = await fleetCar("CD-420584")
  if (!car) return { ok: false, name: "warning-light-584", message: "CD-420584 is not moving in this dataset." }
  if ((await activeFaults()).has(car.orderId)) {
    return { ok: false, name: "warning-light-584", message: "The warning light is already on for CD-420584. Reset the demo to run it again." }
  }
  const now = simNow()
  // Bring the history up to now first, so the fault starts from a car that was driving normally.
  await syncTelemetry(now)
  const detectAfterSeconds = 6
  const startedAt = new Date(now.getTime() - detectAfterSeconds * 1000)
  const before = baseMotion(car, startedAt)
  if (before.state !== "DRIVING") {
    return { ok: false, name: "warning-light-584", message: `CD-420584 is not on the road at this sim time (${before.placeLabel}). Reset the demo first.` }
  }
  const plan = misfirePlan(car, startedAt, before.km, before.speedKmh, detectAfterSeconds)
  const frame = freezeFrame(car, plan)
  const detectedAt = new Date(frame.at)
  const [snapshot] = await insertTelemetry([{
    orderId: car.orderId, vehicleId: car.vehicleId, source: "OBD", at: detectedAt, simulated: true,
    data: { ...frame.values, engine_on: true, mil: "FLASHING", dtcs: plan.codes, freeze_frame: frame },
  }])
  const sources: SourceRef[] = [{ kind: "cr_telemetry", id: snapshot.id, label: "OBD dongle (simulated)", at: detectedAt.toISOString() }]
  const event = await appendEvent({
    caseId: null,
    orderId: car.orderId,
    at: detectedAt,
    actorType: "obd",
    actorId: `obd-${car.vehicleId}`,
    kind: "dtc",
    channel: "telemetry",
    body: `Check-engine light flashing. New trouble codes ${plan.codes.join(" and ")}. ` +
      `Freeze frame stored at ${frame.values.speed_kmh} km/h, coolant ${frame.values.coolant_c} °C.`,
    data: { codes: plan.codes, mil: "FLASHING", freeze_frame: frame, telemetry_id: snapshot.id, simulated: true, sim: plan },
    sourceRefs: sources,
  })
  await syncTelemetry()
  return {
    ok: true,
    name: "warning-light-584",
    message: `Warning light on for CD-420584. The car limps for about a minute, then stops at ${plan.stopLabel}.`,
    orderId: car.orderId,
    eventId: event.id,
    actions: [{ kind: "telemetry", request: { orderRef: car.reference, codes: plan.codes, mil: "FLASHING", note: "reduced power message on the dashboard", eventId: event.id } }],
  }
}

function misfirePlan(car: FleetCar, startedAt: Date, km: number, speed: number, detectAfterSeconds: number): MisfirePlan {
  const draft: MisfirePlan = {
    profile: "misfire",
    startedAt: startedAt.toISOString(),
    kmAtStart: km,
    speedAtStart: speed,
    limpKmh: 70,
    limpSeconds: 50,
    rampSeconds: 35,
    engineOffAfterSeconds: 90,
    stopLabel: "",
    codes: ["P0300", "P0302"],
    detectAfterSeconds,
  }
  // Name the stop after where the car actually comes to rest.
  const stopAt = new Date(startedAt.getTime() + (draft.limpSeconds + draft.rampSeconds + 1) * 1000)
  const stop = faultMotion(car, draft, stopAt)
  return { ...draft, stopLabel: `${SERVICE_AREA} service area on the motorway ${roughWhere(stop.point, car.fromCity, car.toCity)}` }
}

// ---------------------------------------------------------------- F

async function driverSilent537(origin: string): Promise<ScenarioResult> {
  const name = "driver-silent-537"
  const car = await fleetCar("CD-420537")
  if (!car) return { ok: false, name, message: "CD-420537 is not moving in this dataset." }
  if ((await activeFaults()).has(car.orderId)) return { ok: false, name, message: "CD-420537 is already overheating. Reset the demo to run it again." }
  const now = simNow()
  await syncTelemetry(now)
  const before = baseMotion(car, now)
  if (before.state !== "DRIVING") return { ok: false, name, message: "CD-420537 is not on the road at this sim time. Reset the demo first." }
  // The coolant starts climbing now. The sync sets P0217 when it comes due and tells the agent;
  // a minute after that the dongle stops reporting while the car still moves.
  const plan: OverheatPlan = {
    profile: "overheat", startedAt: now.toISOString(), kmAtStart: before.km, speedAtStart: before.speedKmh,
    codes: ["P0217"], detectAfterSeconds: 90, coolantStart: 97, coolantPerMinute: 13, silentAfterSeconds: 150, notifyOrigin: origin,
  }
  const event = await appendEvent({
    caseId: null, orderId: car.orderId, at: now, actorType: "obd", actorId: `obd-${car.vehicleId}`, kind: "telemetry_snapshot", channel: "telemetry",
    body: `Coolant temperature ${plan.coolantStart} °C and climbing. No warning light yet.`,
    data: { simulated: true, sim: plan },
  })
  await syncTelemetry()
  return {
    ok: true, name, orderId: car.orderId, eventId: event.id,
    message: "CD-420537: coolant climbing. In 90 s of sim time the dongle sets P0217 and the agent contacts the driver; a minute later the dongle goes quiet. " +
      "Do not answer as the driver. Jump the clock to pass the reply deadline.",
  }
}

// ---------------------------------------------------------------- G: a monitor-level code

async function sensorLight439(): Promise<ScenarioResult> {
  const name = "sensor-light-439"
  const car = await fleetCar("CD-420439")
  if (!car) return { ok: false, name, message: "CD-420439 is not moving in this dataset." }
  const now = simNow()
  await syncTelemetry(now)
  const motion = baseMotion(car, now)
  if (motion.state !== "DRIVING") return { ok: false, name, message: `CD-420439 is not on the road at this sim time (${motion.placeLabel}). Reset the demo first.` }
  // One dongle reading with the code; this car has no dongle stream, so it stays the latest reading.
  const codes = ["P0135"]
  const [snapshot] = await insertTelemetry([{
    orderId: car.orderId, vehicleId: car.vehicleId, source: "OBD", at: now, simulated: true,
    data: { speed_kmh: motion.speedKmh, engine_on: true, mil: "ON", dtcs: codes, freeze_frame: { code: codes[0], at: now.toISOString(), values: { speed_kmh: motion.speedKmh } } },
  }])
  const event = await appendEvent({
    caseId: null, orderId: car.orderId, at: now, actorType: "obd", actorId: `obd-${car.vehicleId}`, kind: "dtc", channel: "telemetry",
    body: `Check-engine light on, steady. New trouble code ${codes[0]} (oxygen sensor heater).`,
    data: { codes, mil: "ON", telemetry_id: snapshot.id, simulated: true },
    sourceRefs: [{ kind: "cr_telemetry", id: snapshot.id, label: "OBD dongle (simulated)", at: now.toISOString() }],
  })
  const text = "The orange engine light just came on and it stays on. The car seems to drive normally. What does it mean?"
  return {
    ok: true, name, orderId: car.orderId, eventId: event.id,
    message: `${car.driverName} on CD-420439: steady check-engine light, P0135. They write: "${text}"`,
    actions: [{ kind: "driver_message", request: { orderRef: car.reference, driverId: car.driverId, text, mode: "chat" } }],
  }
}

// ---------------------------------------------------------------- H: a whole delivery, step by step

async function pickupToHandover442(): Promise<ScenarioResult> {
  const name = "pickup-to-handover-442"
  const related = await crDb().select({ collection: relatedRecords.collection, details: relatedRecords.details }).from(relatedRecords)
    .where(and(eq(relatedRecords.orderId, "ord-00442"), sql`${relatedRecords.collection} in ('time_windows', 'travel_reservations')`))
  const when = (row: { details: Record<string, unknown> } | undefined, field: string) => (row ? Date.parse(String(row.details[field])) : NaN)
  const slot = related.find((row) => row.details.purpose === "SELECTED_PICKUP_SLOT")
  const promise = related.find((row) => row.details.purpose === "CUSTOMER_DELIVERY_PROMISE" && row.details.is_selected === true)
  const ferry = related.find((row) => row.details.kind === "FERRY" && row.details.status === "BOOKED")
  const lifecycle = await lifecycleOf("ord-00442")
  const next = nextMilestone(lifecycle, Boolean(ferry))
  if (!next) return { ok: true, name, orderId: "ord-00442", message: "The car is handed over. Reset the demo to run H again." }
  // When the next step happens in the records: the pickup slot, an hour before the ferry's check-in closes, just before
  // the delivery window opens, then inside it. Each run moves the clock there.
  const times: Record<Milestone, { at: number; why: string }> = {
    ARRIVED_PICKUP: { at: when(slot, "start_at") - 10 * 60_000, why: "just before Kasper Darevik's pickup slot at Orvendin Cars Stockholm" },
    COLLECTED: { at: when(slot, "start_at"), why: "the pickup slot opens" },
    CHECKED_IN: { at: when(ferry, "check_in_cutoff_at") - 60 * 60_000, why: "an hour before the ferry's check-in closes" },
    ARRIVED_DELIVERY: { at: when(promise, "start_at") - 10 * 60_000, why: "ten minutes before the delivery window opens in Tampere" },
    DELIVERED: { at: Math.max(Date.parse(lifecycle.ARRIVED_DELIVERY?.at ?? "") + 10 * 60_000, when(promise, "start_at") + 10 * 60_000), why: "inside the delivery window" },
  }
  const target = times[next]
  if (!Number.isFinite(target.at)) return { ok: false, name, message: `CD-420442 has no time in the records for "${MILESTONE_WORDS[next]}".` }
  const now = simNow().getTime()
  if (target.at > now) {
    // A jump of days would fire every other open case's timers on the way: those belong to another story.
    const others = (await listCases({ statuses: [...OPEN_CASE_STATUSES] })).filter((row) => row.orderId !== "ord-00442")
    if (target.at - now > 12 * 3600_000 && others.length) {
      return { ok: false, name, message: `The next step is ${Math.round((target.at - now) / 86_400_000)} days ahead and ${others.length} other ${others.length === 1 ? "case is" : "cases are"} open; their timers would fire on the way. Reset the demo first, or run H last.` }
    }
    advanceSimClock(Math.round((target.at - now) / 60_000))
  }
  await syncTelemetry()
  return {
    ok: true, name, orderId: "ord-00442",
    message: `Clock at ${simNow().toISOString().slice(0, 16).replace("T", " ")} UTC, ${target.at > now ? target.why : "already past the step's time"}. In Kasper's phone: ${MILESTONE_WORDS[next].toLowerCase()}.`,
  }
}

// ---------------------------------------------------------------- B, C: a driver writes

async function driverWrites(name: ScenarioName, reference: string, text: string): Promise<ScenarioResult> {
  const car = await fleetCar(reference)
  if (!car) return { ok: false, name, message: `${reference} has no driver on the road in this dataset.` }
  await syncTelemetry()
  return {
    ok: true, name, orderId: car.orderId,
    message: `${car.driverName} writes on ${reference}: "${text}"`,
    actions: [{ kind: "driver_message", request: { orderRef: reference, driverId: car.driverId, text, mode: "chat" } }],
  }
}

// ---------------------------------------------------------------- D: a site writes

async function siteWrites(name: ScenarioName, reference: string, boundary: "PICKUP" | "DELIVERY", text: string): Promise<ScenarioResult> {
  const db = crDb()
  const [order] = await db.select({ id: orders.id }).from(orders).where(eq(orders.reference, reference)).limit(1)
  if (!order) return { ok: false, name, message: `No order ${reference}.` }
  const endpoints = await db.select({ id: relatedRecords.id, details: relatedRecords.details }).from(relatedRecords)
    .where(and(eq(relatedRecords.collection, "order_endpoint_details"), eq(relatedRecords.orderId, order.id)))
  const endpoint = endpoints.find((row) => row.details.boundary === boundary)
  if (!endpoint) return { ok: false, name, message: `${reference} has no ${boundary.toLowerCase()} contact on record.` }
  const who = typeof endpoint.details.contact_name === "string" ? endpoint.details.contact_name : "The site desk"
  return {
    ok: true, name, orderId: order.id,
    message: `${who} writes about ${reference}: "${text}"`,
    actions: [{ kind: "site_message", request: { orderRef: reference, siteContactId: endpoint.id, text, mode: "chat" } }],
  }
}
