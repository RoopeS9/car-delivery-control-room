// The autopilot: the checks the Road agent makes on its own as the simulation runs, by phone through the call
// service, without anyone pressing a button. Every call it places leaves two lines on the order (and on the open
// case, if there is one): "Calling Leo (position check): no position from the phone since 09:12", and when the
// call ends, what was said in one sentence with the outcome. What a call finds that needs a decision goes to the
// agent as a follow-up turn, which brings a card the usual way.
//
// What is checked, and when (simulated clock):
// - position check: a moving car whose phone has gone quiet (no fix for 20 min, or the demo's "quiet from");
// - ferry check-in: the check-in cutoff is within 90 min and the driver has not reported checking in;
// - pickup readiness: the pickup slot starts within 3 h and the site's access is not verified;
// - driver start: the driver is assigned, the pickup slot starts within 3 h and nothing has started.
//
// A manual scenario on an order (the demo screen) takes precedence: the checks not tied to where the car is
// (pickup readiness, driver start) stand down on that order; the location checks still run, since they follow the
// car. An order the agent or a person is already working on is left alone, a driver a person is playing in the
// room is not phoned, a phone the demo keeps quiet on purpose is its scenario's to handle, and the demo's scenario
// orders are the presenter's. The whole thing is rate limited: one call at a time, a pause between calls, a cap per hour.

import { eq, and, max as sqlMax } from "drizzle-orm"
import { AGENT_ID } from "@/lib/agent/config"
import { isResetting } from "@/lib/cr/activity"
import { simNow } from "@/lib/cr/clock"
import { crDb } from "@/lib/cr/db"
import { crTelemetry } from "@/lib/cr/schema"
import { lifecycleOf } from "@/lib/cr/lifecycle"
import { appendEvent, getEvent, listCases, listEvents } from "@/lib/cr/queries"
import { OPEN_CASE_STATUSES, type SourceRef } from "@/lib/cr/types"
import { db } from "@/lib/db"
import { callJob, orderActions } from "@/lib/present/call-service"
import type { CallRecord } from "@/lib/present/call-types"
import { orders, relatedRecords } from "@/lib/schema"
import { loadFleet, type FleetCar } from "./fleet"
import { SCENARIOS } from "./scenarios"
import { simDriverStatus } from "./sim-driver"
import { activeFaults } from "./sync"

export type CheckPurpose = "POSITION_CHECK" | "FERRY_CHECKIN" | "PICKUP_READINESS" | "DRIVER_START_CHECK"

/** A check that is due: which order, what to ask, and why now, in words. */
export type DueCheck = { orderId: string; reference: string; purpose: CheckPurpose; reason: string; locationTied: boolean; who: string }

export type AutopilotState = {
  enabled: boolean
  /** The call service answers and a model key is set: calls can be placed. */
  available: boolean
  inFlight: { reference: string; purpose: CheckPurpose; who: string; startedAt: string } | null
  calls: number
  lastCallAt: string | null
  /** What would be called next, in order, with why; the first one goes when the pause allows. */
  due: DueCheck[]
  /** Why nothing is being called right now, when something is due. */
  holdReason: string | null
}

const MINUTE = 60_000
/** A phone with no fix for this long on a moving car is worth a call. */
const QUIET_MINUTES = 20
const FERRY_WINDOW_MINUTES = 90
const PICKUP_WINDOW_HOURS = 3
/** Not the same question to the same order again within this much simulated time. */
const REPEAT_HOURS = 3
/** Real time between two autopilot calls, so a demo is not a wall of calls. */
const PAUSE_SECONDS = Number(process.env.AUTOPILOT_PAUSE_SECONDS ?? 120)
const MAX_PER_HOUR = Number(process.env.AUTOPILOT_MAX_CALLS_PER_HOUR ?? 10)
const BASE = process.env.CALL_SERVICE_URL ?? "http://127.0.0.1:8799"

type State = { enabled: boolean; inFlight: AutopilotState["inFlight"]; calls: number; lastCallAt: number | null; placed: number[]; stepping: boolean; serviceUp: boolean | null }
const holder = globalThis as unknown as { __autopilot?: State }
function state(): State {
  holder.__autopilot ??= { enabled: process.env.AUTOPILOT !== "off", inFlight: null, calls: 0, lastCallAt: null, placed: [], stepping: false, serviceUp: null }
  return holder.__autopilot
}

export function setAutopilot(enabled: boolean): void { state().enabled = enabled }

/** A demo reset: counters back to zero; a call still on the line is forgotten (its outcome is dropped, see finishCall). */
export function resetAutopilot(): void {
  const current = state()
  current.inFlight = null; current.calls = 0; current.lastCallAt = null; current.placed = []
}

export const PURPOSE_WORDS: Record<CheckPurpose | string, string> = {
  POSITION_CHECK: "position check", FERRY_CHECKIN: "ferry check-in", PICKUP_READINESS: "pickup readiness", DRIVER_START_CHECK: "start check",
  RECEIVER_CONFIRMATION: "handover check", DRIVER_INBOUND: "the driver called",
}
const PURPOSE_AIM: Record<string, string> = {
  POSITION_CHECK: "to check where the car is", FERRY_CHECKIN: "about the ferry check-in", PICKUP_READINESS: "about pickup readiness",
  DRIVER_START_CHECK: "before the start", RECEIVER_CONFIRMATION: "about the handover",
}
const OUTCOME_WORDS: Record<string, string> = {
  COMPLETED: "", PARTIAL: "the call ended early", NO_ANSWER: "no answer", VOICEMAIL: "voicemail", IVR_DEAD_END: "stuck in a phone menu",
  WRONG_PARTY: "the wrong person answered", REFUSED: "they declined to answer", DROPPED: "the line dropped", ESCALATED: "handed to an operator during the call",
}

const clock = (at: Date) => at.toISOString().slice(11, 16)

// ---------------------------------------------------------------- what is due

async function openCaseOrders(): Promise<Set<string>> {
  return new Set((await listCases({ statuses: [...OPEN_CASE_STATUSES] })).map((row) => row.orderId))
}

/** Orders called by the autopilot in the last REPEAT_HOURS of simulated time, as "orderId|purpose". */
async function recentlyCalled(now: Date): Promise<Set<string>> {
  const since = new Date(now.getTime() - REPEAT_HOURS * 60 * MINUTE)
  const keys = new Set<string>()
  for (const event of await listEvents({ since })) {
    if (event.data.autopilot === true && typeof event.data.call_purpose === "string") keys.add(`${event.orderId}|${event.data.call_purpose}`)
  }
  return keys
}

/** When each order's phone last reported, from the simulated samples (the sync writes one a minute for a live car). */
async function latestPhoneFix(): Promise<Map<string, Date>> {
  const rows = await crDb().select({ orderId: crTelemetry.orderId, at: sqlMax(crTelemetry.at) }).from(crTelemetry)
    .where(eq(crTelemetry.source, "PHONE_GPS")).groupBy(crTelemetry.orderId)
  return new Map(rows.filter((row) => row.at).map((row) => [row.orderId, new Date(row.at as unknown as string | Date)]))
}

/** The checks tied to where the car is: a quiet phone on a moving car, a ferry cutoff coming up. */
async function locationChecks(cars: FleetCar[], now: Date): Promise<DueCheck[]> {
  const due: DueCheck[] = []
  const fixes = await latestPhoneFix()
  for (const car of cars) {
    if (car.stoppedNote) continue
    // A phone the demo keeps quiet on purpose belongs to its scenario (F): the agent phones that driver from the
    // case's own follow-up, not from here, so a presenter is not pre-empted.
    if (car.quietFrom) continue
    // Quiet: the records say the app went stale, or no simulated fix for a while. A car with no app on this trip
    // at all is not a phone gone quiet.
    const fix = fixes.get(car.orderId) ?? null
    const quietSince = car.phone === "NONE" ? null
      : car.phone === "STALE" && car.lastObservation ? car.lastObservation.at
      : fix && now.getTime() - fix.getTime() >= QUIET_MINUTES * MINUTE ? fix : null
    if (quietSince) {
      due.push({ orderId: car.orderId, reference: car.reference, purpose: "POSITION_CHECK", locationTied: true, who: car.driverName,
        reason: `no position from the driver's phone since ${clock(quietSince)} UTC` })
    }
    const cutoff = car.ferry?.checkInCutoffAt
    if (cutoff && cutoff.getTime() > now.getTime() && cutoff.getTime() - now.getTime() <= FERRY_WINDOW_MINUTES * MINUTE) {
      const lifecycle = await lifecycleOf(car.orderId)
      if (!lifecycle.CHECKED_IN) {
        due.push({ orderId: car.orderId, reference: car.reference, purpose: "FERRY_CHECKIN", locationTied: true, who: car.driverName,
          reason: `the ferry check-in closes at ${clock(cutoff)} UTC and no check-in is reported` })
      }
    }
  }
  return due
}

/** The checks ahead of a pickup: is the site ready, is the driver starting. From the records, for orders not yet on the road. */
async function pickupChecks(now: Date): Promise<DueCheck[]> {
  const horizon = new Date(now.getTime() + PICKUP_WINDOW_HOURS * 60 * MINUTE)
  const slots = await db.select({ orderId: relatedRecords.orderId, details: relatedRecords.details }).from(relatedRecords)
    .where(eq(relatedRecords.collection, "time_windows"))
  const due: DueCheck[] = []
  for (const slot of slots) {
    const d = slot.details as Record<string, unknown>
    if (d.purpose !== "SELECTED_PICKUP_SLOT" || !d.is_selected || !slot.orderId) continue
    const start = new Date(String(d.start_at))
    if (Number.isNaN(start.getTime()) || start.getTime() < now.getTime() - 60 * MINUTE || start.getTime() > horizon.getTime()) continue
    const [order] = await db.select({ reference: orders.reference, status: orders.status, pickupSiteId: orders.pickupSiteId }).from(orders).where(eq(orders.id, slot.orderId))
    if (!order || !["NEW", "WAITING_FOR_PICKUP"].includes(order.status)) continue
    const [endpoint] = await db.select({ details: relatedRecords.details }).from(relatedRecords)
      .where(and(eq(relatedRecords.collection, "order_endpoint_details"), eq(relatedRecords.orderId, slot.orderId)))
    const access = (endpoint?.details as Record<string, unknown> | undefined)
    const pickupSide = access?.boundary === "PICKUP" || !access
    if (pickupSide && access?.access_status === "NEEDS_VERIFICATION") {
      due.push({ orderId: slot.orderId, reference: order.reference, purpose: "PICKUP_READINESS", locationTied: false, who: "the pickup desk",
        reason: `the pickup slot starts at ${clock(start)} UTC and the site's access is not verified` })
    }
    const assignments = await db.select({ details: relatedRecords.details }).from(relatedRecords)
      .where(and(eq(relatedRecords.collection, "work_assignments"), eq(relatedRecords.orderId, slot.orderId)))
    if (assignments.some((row) => (row.details as Record<string, unknown>).status === "ASSIGNED")) {
      due.push({ orderId: slot.orderId, reference: order.reference, purpose: "DRIVER_START_CHECK", locationTied: false, who: "the driver",
        reason: `the pickup slot starts at ${clock(start)} UTC and the driver has not started` })
    }
  }
  return due
}

const RANK: Record<CheckPurpose, number> = { FERRY_CHECKIN: 0, POSITION_CHECK: 1, PICKUP_READINESS: 2, DRIVER_START_CHECK: 3 }

/**
 * Everything due right now, most pressing first, after the rules: a manual scenario on an order stands the
 * non-location checks down, an open case leaves the order to whoever has it, a human-played driver is not phoned,
 * and the same question is not asked again within REPEAT_HOURS.
 */
export async function dueChecks(now = simNow()): Promise<DueCheck[]> {
  const [cars, faults, busy, recent] = await Promise.all([loadFleet(), activeFaults(), openCaseOrders(), recentlyCalled(now)])
  // The demo's own scenario orders are the presenter's: their stories (a silent driver, a routine question) start
  // from the demo screen and would read wrong with the agent phoning first.
  const staged = new Set(cars.filter((car) => SCENARIOS.some((scenario) => scenario.orderRef === car.reference)).map((car) => car.orderId))
  const humans = new Set(simDriverStatus().humans)
  const driverOf = new Map(cars.map((car) => [car.orderId, car.driverId]))
  const all = [...await locationChecks(cars, now), ...await pickupChecks(now)]
  return all
    .filter((check) => !busy.has(check.orderId) && !staged.has(check.orderId))
    .filter((check) => check.locationTied || !faults.has(check.orderId))
    .filter((check) => !(["POSITION_CHECK", "FERRY_CHECKIN", "DRIVER_START_CHECK"].includes(check.purpose) && humans.has(driverOf.get(check.orderId) ?? "")))
    .filter((check) => !recent.has(`${check.orderId}|${check.purpose}`))
    .sort((a, b) => RANK[a.purpose] - RANK[b.purpose])
}

// ---------------------------------------------------------------- placing a call

/** What a call found, in one sentence from its recorded claims. A claim is what the person said, never a verification. */
export function summarizeCall(record: CallRecord): { summary: string; urgent: string[] } {
  const parts: string[] = []
  const urgent: string[] = []
  const entry = (name: string) => record.slots.find((item) => item.value.slot === name)
  const slot = (name: string) => entry(name)?.value.value
  // A claim is extracted from what the person said; for anything urgent the agent reads their words, not the label.
  const quoted = (name: string, finding: string) => { const quote = entry(name)?.quote?.trim(); return quote ? `${finding} (they said: "${quote}")` : finding }
  const NOTHING = /^(none|no|nothing|n\/a|no issue|nothing to report|-)$/i
  const text = (name: string) => { const value = slot(name); return typeof value === "string" && value.trim() && !NOTHING.test(value.trim()) ? value.trim() : null }
  const bool = (name: string) => { const value = slot(name); return typeof value === "boolean" ? value : null }
  const started = Date.parse(record.startedAt)
  if (text("CURRENT_LOCATION")) { const where = text("CURRENT_LOCATION")!; parts.push(/^(on|at|in|near|just|by|about|between|still)\b/i.test(where) ? where : `near ${where}`) }
  if (text("ETA")) {
    const eta = new Date(text("ETA")!)
    // An ETA before the call is the extractor's mistake, not the driver's.
    if (Number.isNaN(eta.getTime())) parts.push(`ETA ${text("ETA")}`); else if (eta.getTime() > started) parts.push(`ETA ${clock(eta)} UTC`)
  }
  if (bool("DRIVER_SAFE") === true) parts.push("the driver is fine"); else if (bool("DRIVER_SAFE") === false) { parts.push("the driver may not be safe"); urgent.push(quoted("DRIVER_SAFE", "the driver may not be safe")) }
  if (bool("INJURIES") === true) { parts.push("someone is hurt"); urgent.push(quoted("INJURIES", "someone is hurt")) }
  const light = slot("WARNING_LIGHT")
  if (light === "NONE") parts.push("no warning light")
  else if (typeof light === "string") { parts.push(`warning light ${light.toLowerCase().replace("_", " ")}`); if (light !== "AMBER_STEADY") urgent.push(`a ${light.toLowerCase().replace("_", " ")} warning light`) }
  if (text("ISSUE_REPORTED")) { parts.push(`reported: ${text("ISSUE_REPORTED")}`); urgent.push(quoted("ISSUE_REPORTED", `the driver reports: ${text("ISSUE_REPORTED")}`)) }
  if (text("SYMPTOMS")) parts.push(text("SYMPTOMS")!)
  if (bool("CAR_MOVES") === false) { parts.push("the car will not move"); urgent.push(quoted("CAR_MOVES", "the car will not move")) }
  if (bool("FERRY_CHECKED_IN") === true) parts.push("checked in for the ferry"); else if (bool("FERRY_CHECKED_IN") === false) { parts.push("not checked in yet"); urgent.push("not checked in for the ferry yet") }
  if (bool("CONNECTION_AT_RISK") === true) { parts.push("the connection is at risk"); urgent.push("the connection is at risk") }
  if (bool("VEHICLE_PRESENT") === true) parts.push("the car is at the site"); else if (bool("VEHICLE_PRESENT") === false) { parts.push("the car is not at the site"); urgent.push("the car is not at the pickup site") }
  if (bool("KEYS_AT_SITE") === true) parts.push("keys are there"); else if (bool("KEYS_AT_SITE") === false) { parts.push("no keys at the site"); urgent.push("the keys are not at the site") }
  if (text("RELEASE_CONTACT_NAME")) parts.push(`${text("RELEASE_CONTACT_NAME")} releases the car`)
  if (bool("RELEASE_DOCUMENT_PRESENT") === false) { parts.push("no signed release"); urgent.push("the signed release is missing") }
  if (bool("COMMERCIAL_HOLD") === true) { parts.push("a commercial hold is on the car"); urgent.push("the site reports a commercial hold") }
  if (bool("OPEN_DURING_SLOT") === false) { parts.push("not open during the slot"); urgent.push("the site is not open during the slot") }
  if (text("ACCESS_INSTRUCTION")) parts.push(`access: ${text("ACCESS_INSTRUCTION")}`)
  if (bool("DRIVER_TRAVEL_BOOKED") === false) { parts.push("travel to the pickup not booked"); urgent.push("the driver's travel to the pickup is not booked") }
  if (bool("DRIVER_FIT_TO_DRIVE") === false) { parts.push("the driver is not fit to drive"); urgent.push("the driver says they are not fit to drive") }
  if (text("DRIVER_START_LOCATION")) parts.push(`starting from ${text("DRIVER_START_LOCATION")}`)
  const outcome = OUTCOME_WORDS[record.outcome] ?? record.outcome.toLowerCase().replace(/_/g, " ")
  if (["NO_ANSWER", "VOICEMAIL", "WRONG_PARTY", "REFUSED", "DROPPED", "ESCALATED", "IVR_DEAD_END"].includes(record.outcome)) urgent.push(outcome)
  const body = parts.length ? parts.join(", ") : outcome || "nothing to report"
  return { summary: outcome && parts.length ? `${body}; ${outcome}` : body, urgent }
}

type Placed = { jobId: string; startEventId: string }

/** The open case on the order for this driver's road work, if any: call lines join it so the agent reads them. */
async function caseFor(orderId: string): Promise<string | null> {
  const open = await listCases({ orderId, statuses: [...OPEN_CASE_STATUSES] })
  return open[0]?.id ?? null
}

/**
 * Place one call through the call service and record it. Resolves when the call has been started; the outcome is
 * recorded in the background when the service finishes (a model-played call takes 30 to 90 s).
 */
export async function placeAgentCall(check: Pick<DueCheck, "orderId" | "reference" | "purpose" | "reason" | "who">, options: { caseId?: string | null; origin?: string } = {}): Promise<Placed | { error: string }> {
  const actions = await orderActions(check.reference)
  const allowed = actions?.actions.find((action) => action.purpose === check.purpose)
  if (actions && allowed && !allowed.agentMay) return { error: allowed.reason ?? "the agent may not place this call" }
  const caseId = options.caseId === undefined ? await caseFor(check.orderId) : options.caseId
  let jobId: string
  try {
    const response = await fetch(`${BASE}/calls/sim`, {
      method: "POST", headers: { "content-type": "application/json" }, cache: "no-store", signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({ ref: check.reference, purpose: check.purpose, twist: "cooperative", at: simNow().toISOString() }),
    })
    const text = await response.text()
    if (!response.ok) return { error: text.slice(0, 200) || `the call service answered ${response.status}` }
    jobId = (JSON.parse(text) as { jobId: string }).jobId
  } catch {
    return { error: "the call service is not reachable" }
  }
  const who = allowed?.who ?? check.who
  const start = await appendEvent({
    caseId, orderId: check.orderId, actorType: "agent", actorId: AGENT_ID, kind: "note", channel: "internal",
    body: `Calling ${who} (${PURPOSE_WORDS[check.purpose]}): ${check.reason}.`,
    data: { autopilot: true, call_purpose: check.purpose, call_job: jobId },
  })
  const current = state()
  current.inFlight = { reference: check.reference, purpose: check.purpose, who, startedAt: new Date().toISOString() }
  current.calls += 1
  current.lastCallAt = Date.now()
  current.placed.push(Date.now())
  void finishCall(jobId, check, who, caseId, start.id, options.origin).catch((error) => console.error("[autopilot] call outcome not recorded", error)).finally(() => { if (state().inFlight?.startedAt === current.inFlight?.startedAt) state().inFlight = null })
  return { jobId, startEventId: start.id }
}

/** Poll the service until the call is done, then write what it found on the order, and hand anything urgent to the agent. */
async function finishCall(jobId: string, check: Pick<DueCheck, "orderId" | "reference" | "purpose">, who: string, caseId: string | null, startEventId: string, origin?: string): Promise<void> {
  const deadline = Date.now() + 4 * MINUTE
  let job = await callJob(jobId)
  while (job && job.status === "running" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5000))
    job = await callJob(jobId)
  }
  const aim = PURPOSE_AIM[check.purpose] ?? PURPOSE_WORDS[check.purpose]
  // A demo reset meanwhile wiped the "Calling…" line: the outcome has no story to join and is dropped.
  if (!(await getEvent(startEventId))) return
  if (!job || job.status !== "done" || !job.call) {
    await appendEvent({
      caseId, orderId: check.orderId, actorType: "agent", actorId: AGENT_ID, kind: "note", channel: "internal",
      body: `The call to ${who} ${aim} did not go through${job?.error ? ` (${job.error.slice(0, 120)})` : ""}.`,
      data: { autopilot: true, call_purpose: check.purpose, call_job: jobId, call_failed: true },
    })
    return
  }
  const { summary, urgent } = summarizeCall(job.call)
  const source: SourceRef = { kind: "road_calls", id: job.call.id, label: `Call with ${who}, ${clock(new Date(job.call.startedAt))} UTC`, at: job.call.startedAt }
  const event = await appendEvent({
    caseId, orderId: check.orderId, actorType: "agent", actorId: AGENT_ID, kind: "voice_turn", channel: "driver_voice",
    body: `Called ${who} ${aim}: ${summary}.`,
    data: { autopilot: true, call_purpose: check.purpose, call_job: jobId, road_call_id: job.call.id, call_outcome: job.call.outcome, urgent },
    sourceRefs: [source],
  })
  if (urgent.length && origin) {
    // Something a person may have to decide: the agent reads the call and continues the case (a card if needed).
    try {
      const response = await fetch(new URL("/api/agent/call-outcome", origin), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderRef: check.reference, purpose: check.purpose, who, summary, urgent, eventId: event.id, callId: job.call.id }),
      })
      if (!response.ok) console.warn(`[autopilot] call outcome handler answered ${response.status}`)
    } catch (error) {
      console.warn("[autopilot] call outcome handler unreachable", error instanceof Error ? error.message : error)
    }
  }
}

// ---------------------------------------------------------------- the step

async function serviceUp(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE}/purposes`, { cache: "no-store", signal: AbortSignal.timeout(1500) })
    return response.ok
  } catch { return false }
}

/** One scheduler step: look at what is due and place at most one call. Cheap when nothing is due. */
export async function autopilotStep(origin: string): Promise<AutopilotState> {
  const current = state()
  if (current.stepping || isResetting()) return autopilotStatus([])
  current.stepping = true
  try {
    const due = current.enabled ? await dueChecks() : []
    const status = await autopilotStatus(due)
    if (!current.enabled || !due.length || status.holdReason) return status
    const next = due[0]
    const placed = await placeAgentCall(next, { origin })
    if ("error" in placed) {
      // Not callable right now (the service says why): note it once on the order, so the demo shows the rule.
      await appendEvent({
        caseId: await caseFor(next.orderId), orderId: next.orderId, actorType: "system", actorId: "road-desk", kind: "note", channel: "internal",
        body: `Autopilot: a ${PURPOSE_WORDS[next.purpose]} call to ${next.who} is due (${next.reason}) but was not placed: ${placed.error}.`,
        data: { autopilot: true, call_purpose: next.purpose, call_skipped: true },
      })
    }
    return autopilotStatus(due.slice(1))
  } finally {
    current.stepping = false
  }
}

export async function autopilotStatus(due?: DueCheck[]): Promise<AutopilotState> {
  const current = state()
  const list = due ?? (current.enabled ? await dueChecks() : [])
  const hourAgo = Date.now() - 60 * MINUTE
  current.placed = current.placed.filter((at) => at > hourAgo)
  const available = !!process.env.OPENROUTER_API_KEY && (await serviceUp())
  const holdReason = !current.enabled ? null
    : !process.env.OPENROUTER_API_KEY ? "no model key: calls are model-played"
    : !available ? "the call service is not running"
    : current.inFlight ? `a call to ${current.inFlight.who} is in progress`
    : current.lastCallAt && Date.now() - current.lastCallAt < PAUSE_SECONDS * 1000 ? `pausing ${Math.ceil((PAUSE_SECONDS * 1000 - (Date.now() - current.lastCallAt)) / 1000)} s between calls`
    : current.placed.length >= MAX_PER_HOUR ? `${MAX_PER_HOUR} calls in the last hour, the cap` : null
  return {
    enabled: current.enabled, available, inFlight: current.inFlight, calls: current.calls,
    lastCallAt: current.lastCallAt ? new Date(current.lastCallAt).toISOString() : null, due: list, holdReason: list.length ? holdReason : null,
  }
}
