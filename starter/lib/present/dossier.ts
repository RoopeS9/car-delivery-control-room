// The operator's view of one delivery, opened from the map. Above the fold:
// one sentence of state, the one thing that needs a person (or nothing), the
// journey strip, at most three things worth watching, and the last three
// things a person did or said. Everything else folds into the full history,
// and every record stays behind the full dossier. Lines carry at most one
// evidence word: a quote is not a booking, a booking is not a gate scan, a
// message is a claim, a phone position here is simulated.

import { and, desc, eq, sql } from "drizzle-orm"
import { crDb } from "@/lib/cr/db"
import { crTelemetry } from "@/lib/cr/schema"
import type { ObdData } from "@/lib/cr/types"
import { fleetCar } from "@/lib/sim/fleet"
import { polylineKm, type LatLng } from "@/lib/sim/geo"
import { telemetryStrip } from "./cases"
import { callsFor, serviceDossier, strengthIndex } from "./call-service"
import { readToolArgument, slotLabel, slotValue, type CallRecord } from "./call-types"
import { deriveKeyDates, latestTracking, milestones } from "./attention"
import { type Bundle, rows, str } from "./bundle"
import { label, labelIn } from "./labels"
import { buildRecordView } from "./record"
import { attentionTone, needsPersonItem } from "./tone-rule"
import { isBefore, minutesBetween } from "./time"
import type { DossierItem, DossierView, StripPoint, Strength, WatchItem } from "./dossier-types"
import type { Tone } from "./types"

export type { DossierItem, DossierView, StripPoint, Strength }
export { STRENGTH_LABEL } from "./dossier-types"

const SOURCE_TONE: Record<string, Tone> = { danger: "danger", warn: "warn", accent: "accent", ok: "ok", neutral: "neutral" }

/** Bookkeeping events that say the system moved, not that anything happened to the car: hidden from the operator view. */
const LIFECYCLE = new Set([
  "order.status_changed", "order.created", "plan.created", "plan.activated", "plan.completed", "plan.replaced", "plan.cancelled",
  "offer.published", "offer.accepted", "offer.withdrawn", "proof.submitted", "proof.require", "proof.review", "assignment.booked",
  "assignment.started", "assignment.completed", "expense.auto_recorded", "exposure.shown", "exposure.notified", "exposure.viewed",
  "exposure.accepted", "order.item_added", "bundle.member_linked", "travel.booked", "availability.confirmed", "order.readiness_assessed",
])
/** Steps of a review chain, told once on the watching line they belong to. */
const CHAIN = /^(alert|work_item|work|incident)\./
/** Events where a person did something to the car or the handover. */
const HANDOVER = new Set(["vehicle.picked_up", "vehicle.delivered", "pickup.attempted", "site_visit.arrived", "travel.arrival_reported", "delivery.delay_reported", "vehicle.custody_reported", "pickup.vehicle_not_found"])

/** "Tue 13:10" in the order's zone. */
function weekdayClock(zone: string | null) {
  const format = new Intl.DateTimeFormat("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: zone ?? "UTC" })
  const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: zone ?? "UTC" })
  const day = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: zone ?? "UTC" })
  return {
    at: (iso: string | null | undefined) => iso ? format.format(new Date(iso)).replace(",", "") : "time not recorded",
    clock: (iso: string | null | undefined) => iso ? clock.format(new Date(iso)) : "",
    day: (iso: string | null | undefined) => iso ? day.format(new Date(iso)) : "",
  }
}

function duration(minutes: number): string {
  if (minutes < 60) return `${Math.max(1, Math.round(minutes / 5) * 5 || 1)} min`
  const hours = Math.floor(minutes / 60)
  const rest = Math.round((minutes % 60) / 10) * 10
  return rest ? `${hours} h ${rest} min` : `${hours} h`
}

function sentence(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

export async function buildDossier(bundle: Bundle): Promise<DossierView> {
  const view = buildRecordView(bundle)
  const now = bundle.cr.now
  const header = view.header
  const zone = header.to.zone ?? header.from.zone ?? null
  const t = weekdayClock(zone)
  const { pickedUpAt, deliveredAt } = milestones(bundle)
  const { keyDates } = deriveKeyDates(bundle)
  // The robo-call service runs beside the app; without it the dossier still renders.
  const [car, robo, typed] = await Promise.all([
    fleetCar(bundle.order.id).catch(() => null), callsFor(bundle.order.reference), serviceDossier(bundle.order.reference),
  ])
  const active = view.assignments.find((row) => row.status === "IN_PROGRESS") ?? view.assignments.find((row) => row.status !== "CANCELLED" && row.status !== "COMPLETED") ?? null
  const driver = car?.driverName ?? active?.driver.name ?? null
  const commandOf = new Map(bundle.events.map((event) => [event.id, event.command]))
  const ahead: DossierItem[] = []
  const behind: DossierItem[] = []
  const watching: WatchItem[] = []
  const recent: DossierView["recent"] = []

  // ---- journey steps and their windows
  const steps = view.journey.groups[0]?.steps ?? []
  for (const step of steps) {
    if (step.recorded || step.role === "DELIVERY") continue
    const slot = step.windows.find((window) => window.selected && window.purpose === "SELECTED_PICKUP_SLOT") ?? step.windows[0] ?? null
    if (!slot) continue
    const passed = isBefore(slot.end ?? slot.start, now)
    const range = slot.end ? `${t.at(slot.start)} to ${t.clock(slot.end)}` : t.at(slot.start)
    ;(passed ? behind : ahead).push({
      id: `step-${step.id}`, at: passed ? slot.end ?? slot.start : slot.start, kind: "step",
      title: passed ? `${step.roleLabel} window ${range} passed at ${step.place.name}; nothing recorded there` : `${step.roleLabel} at ${step.place.name}, ${range}`,
      detail: null, strength: passed ? "missed" : "planned", source: slot.sourceLabel, tone: passed ? "warn" : "neutral",
    })
  }

  // ---- ferry and travel: booked, check-in by gate scan, departure
  const gate = rows(bundle, "ferry_terminal_events").map((row) => row.details)
  const terminals = new Map(rows(bundle, "ferry_terminals").map((row) => [row.id, str(row.details.name)]))
  const ferryStrip: StripPoint[] = []
  for (const reservation of view.reservations) {
    if (reservation.status === "CANCELLED" || reservation.replacedBy) continue
    const raw = rows(bundle, "travel_reservations").find((row) => row.id === reservation.id)?.details ?? {}
    const route = reservation.route ?? reservation.kindLabel
    if (reservation.bookedAt) behind.push({
      id: `res-${reservation.id}`, at: reservation.bookedAt, kind: reservation.kind === "FERRY" ? "ferry" : "travel",
      title: `${reservation.kindLabel} booked: ${route}${reservation.departureAt ? `, departs ${t.at(reservation.departureAt)}` : ""}`,
      detail: reservation.amendment, strength: "booked", source: "Travel booking", tone: reservation.tone, ref: { collection: "travel_reservations", id: reservation.id },
    })
    if (reservation.kind !== "FERRY") continue
    const scans = gate.filter((row) => row.reservation_id === reservation.id).sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)))
    const terminal = terminals.get(str(raw.origin_terminal_id) ?? "") ?? str(raw.origin_terminal) ?? "the terminal"
    for (const scan of scans) {
      const accepted = scan.kind === "CHECK_IN_ACCEPTED"
      behind.push({
        id: `gate-${str(scan.id)}`, at: str(scan.occurred_at), kind: "ferry",
        title: accepted ? `Check-in confirmed by gate scan at ${terminal}` : `Gate refused check-in at ${terminal}${str(scan.reason) ? `: ${str(scan.reason)}` : ""}`,
        detail: "The gate records check-in; boarding is not recorded.", strength: "verified", source: "Terminal gate", tone: accepted ? "ok" : "danger",
        ref: { collection: "ferry_terminal_events", id: str(scan.id) ?? "" },
      })
    }
    const checkedIn = scans.some((scan) => scan.kind === "CHECK_IN_ACCEPTED")
    const cutoff = reservation.checkInCutoffAt
    if (cutoff && !deliveredAt) {
      if (!isBefore(cutoff, now)) {
        ahead.push({ id: `cutoff-${reservation.id}`, at: cutoff, kind: "deadline", title: `Ferry check-in closes at ${terminal}, ${t.at(cutoff)}`, detail: null, strength: "booked", source: "Carrier booking", tone: checkedIn ? "ok" : "neutral" })
        if (!checkedIn && (minutesBetween(now, cutoff) ?? 9999) < 6 * 60) watching.push({
          id: `w-cutoff-${reservation.id}`, tone: "warn", at: cutoff,
          text: `Ferry check-in closes ${t.at(cutoff)}; no gate scan yet`,
          why: "The ferry is booked, but only the terminal's gate scan confirms check-in. Until then the car may still miss the ship.",
          sources: ["Carrier booking", "Terminal gate records (none yet)"],
        })
      } else if (!checkedIn) {
        behind.push({ id: `cutoff-${reservation.id}`, at: cutoff, kind: "deadline", title: `Ferry check-in closed ${t.at(cutoff)} with no gate scan`, detail: null, strength: reservation.status === "MISSED_CHECK_IN" ? "recorded" : "unverified", source: "Carrier booking", tone: "warn" })
        watching.push({
          id: `w-cutoff-${reservation.id}`, tone: "danger", at: cutoff,
          text: reservation.status === "MISSED_CHECK_IN" ? `Missed ferry check-in, ${t.at(cutoff)}` : `Ferry check-in closed ${t.at(cutoff)} with no gate scan`,
          why: "A booking is not a gate scan. Without one there is no evidence the car made the ship.",
          sources: ["Carrier booking", "Terminal gate records"],
        })
      }
    }
    if (reservation.departureAt && !deliveredAt && !isBefore(reservation.departureAt, now)) {
      ahead.push({ id: `dep-${reservation.id}`, at: reservation.departureAt, kind: "ferry", title: `Ferry departs, ${route}, ${t.at(reservation.departureAt)}`, detail: null, strength: "booked", source: "Carrier booking", tone: "neutral" })
    }
    const sailing = reservation.departureAt && reservation.arrivalAt && isBefore(reservation.departureAt, now) && isBefore(now, reservation.arrivalAt)
    ferryStrip.push({
      label: "Ferry", place: route,
      state: checkedIn ? (sailing ? "now" : "done") : reservation.status === "MISSED_CHECK_IN" ? "missed" : cutoff && isBefore(cutoff, now) ? "unverified" : "planned",
      note: checkedIn ? "checked in by gate scan" : reservation.status === "MISSED_CHECK_IN" ? "missed check-in" : cutoff && isBefore(cutoff, now) ? "booked, no gate scan" : `booked, check-in by ${t.at(cutoff)}`,
    })
  }
  for (const option of view.options) {
    behind.push({
      id: `opt-${option.id}`, at: option.checkedAt, kind: "quote",
      title: `${option.kindLabel} quote${option.route ? `, ${option.route}` : ""}${option.quote ? `, ${option.quote}` : ""}; a quote, not a booking`,
      detail: null, strength: "quote", source: option.provider ?? "Travel search", tone: "neutral", ref: { collection: "travel_options", id: option.id },
    })
  }

  // ---- the promise and the ETA
  const promiseDate = keyDates.find((date) => date.key === "promise")
  const etaDate = keyDates.find((date) => date.key === "eta")
  const promiseRange = promiseDate ? (promiseDate.end
    ? `${t.day(promiseDate.start) === t.day(now) ? "" : `${t.day(promiseDate.start)} `}${t.clock(promiseDate.start)} to ${t.clock(promiseDate.end)}`
    : t.at(promiseDate.start)) : null
  if (promiseDate && !deliveredAt) {
    const item: DossierItem = {
      id: "promise", at: promiseDate.end ?? promiseDate.start, kind: "deadline",
      title: `${promiseDate.label === "Delivery promise" ? "Delivery promised" : promiseDate.label}, ${t.at(promiseDate.start)}${promiseDate.end ? ` to ${t.clock(promiseDate.end)}` : ""}`,
      detail: promiseDate.note, strength: promiseDate.source === "CUSTOMER" ? "commitment" : "planned",
      source: promiseDate.source === "CUSTOMER" ? "Agreed with the customer" : labelIn(promiseDate.source) || "Records", tone: promiseDate.tone,
    }
    ;(isBefore(item.at, now) ? behind : ahead).push(item)
  }

  // ---- what happened: records, live case events, calls
  const callIds = new Set(view.calls.map((call) => call.id))
  const lineEventIds = new Set(bundle.cr.events.filter((event) => typeof (event.data as Record<string, unknown>).line_call_id === "string").map((event) => event.id))
  const roadCallEventIds = new Set(bundle.cr.events.filter((event) => typeof (event.data as Record<string, unknown>).road_call_id === "string").map((event) => event.id))
  const chainSteps: { at: string; text: string }[] = []
  for (const entry of view.timeline) {
    if (entry.kind === "voice" && callIds.size) continue
    // The autopilot's call summary: the call itself is listed below from the call service, with its claims.
    if (entry.source.kind === "cr_events" && roadCallEventIds.has(entry.source.id)) continue
    if (entry.source.kind === "cr_events" && lineEventIds.has(entry.source.id)) continue
    const command = entry.source.kind === "operational_events" ? commandOf.get(entry.source.id) ?? null : null
    if (command && LIFECYCLE.has(command)) continue
    if ((command && CHAIN.test(command)) || entry.kind === "alert") {
      chainSteps.push({ at: entry.at, text: `${sentence(entry.text, 90)} (${entry.actorName}, ${t.at(entry.at)})` })
      continue
    }
    const agentSide = entry.actorKind === "agent"
    let kind: DossierItem["kind"] = "event"
    let strength: Strength = "recorded"
    if (entry.kind === "message" || entry.kind === "photo") { kind = "message"; strength = agentSide ? "agent" : "claim" }
    else if (entry.kind === "lookup" || entry.kind === "proposal" || entry.kind === "safety") { kind = "agent"; strength = "agent" }
    else if (entry.kind === "telemetry" || entry.actorKind === "obd" || entry.actorKind === "phone") { kind = "telemetry"; strength = "simulated" }
    else if (entry.kind === "decision") { kind = "decision"; strength = "decision" }
    else if (entry.kind === "note") { kind = "note"; strength = agentSide ? "agent" : "recorded" }
    const who = entry.channelLabel && entry.kind === "message" ? `${entry.actorName}, ${entry.channelLabel.charAt(0).toLowerCase()}${entry.channelLabel.slice(1)}` : entry.actorName
    const item: DossierItem = {
      id: `t-${entry.id}`, at: entry.at, kind, strength, tone: SOURCE_TONE[entry.tone] ?? "neutral",
      title: sentence(entry.text.replace(/\. (from|occurred) .*$/, ""), 200), detail: entry.text.length > 200 ? entry.text : null,
      source: who, ref: { collection: entry.source.kind, id: entry.source.id },
    }
    behind.push(item)
    // Recent: what a person did or said (not the agent, not a sensor, not the system).
    const person = !agentSide && !["system", "obd", "phone"].includes(entry.actorKind) || entry.kind === "decision"
    const handover = command ? HANDOVER.has(command) : false
    if ((entry.kind === "message" && person) || entry.kind === "decision" || handover) {
      recent.push({ id: item.id, at: entry.at, text: entry.kind === "message" ? `${who}: “${sentence(entry.text, 110)}”` : `${entry.actorName}: ${sentence(entry.text.replace(/\. (from|occurred) .*$/, ""), 110)}` })
    }
  }
  for (const call of view.calls) {
    const item: DossierItem = {
      id: `call-${call.id}`, at: call.startedAt, kind: "call",
      title: `${call.directionLabel}${call.urgencyLabel ? `, ${call.urgencyLabel.toLowerCase()}` : ""}${call.readbackConfirmed ? "; the driver confirmed the read-back" : ""}`,
      detail: call.urgencyQuote ? `“${call.urgencyQuote}”` : null, strength: "recorded", source: `Call with ${call.driverName}`, tone: call.tone,
      turns: call.turns.map((turn) => ({ speaker: turn.speakerName, text: turn.text, at: turn.at })),
    }
    behind.push(item)
    recent.push({ id: item.id, at: call.startedAt, text: `${call.driverName} on a call: ${call.directionLabel.toLowerCase()}${call.urgencyLabel ? `, ${call.urgencyLabel.toLowerCase()}` : ""}` })
  }
  // Live calls on the Road Desk line, linked by the in-app call screen with the phone's transcript. When the call
  // service read the transcript, the line shows its claims and review; that record is not listed twice.
  const ingestedIds = new Set<string>()
  for (const event of bundle.cr.events) {
    const data = event.data as Record<string, unknown>
    if (typeof data.line_call_id !== "string") continue
    const at = event.at instanceof Date ? event.at.toISOString() : String(event.at)
    const lines = Array.isArray(data.transcript) ? data.transcript as { t: number; role: string; text: string }[] : []
    const who = typeof data.who === "string" ? data.who : "the other party"
    const seconds = typeof data.duration_s === "number" ? data.duration_s : null
    const inbound = data.purpose === "DRIVER_INBOUND"
    const line = data.caller === "voicechat" ? "VoiceChat line (retired)" : "Road Desk line"
    const title = `${inbound ? "Driver called Road Desk" : `Live call: ${labelIn(String(data.purpose ?? "call")).toLowerCase()}`} on the ${line}${seconds != null ? `, ${Math.max(1, Math.round(seconds / 60))} min` : ""}`
    const ingested = typeof data.ingested_call_id === "string" ? robo.find((call) => call.id === data.ingested_call_id) ?? null : null
    if (typeof data.ingested_call_id === "string") ingestedIds.add(data.ingested_call_id)
    const review = data.review as { verdict?: "PASS" | "PARTIAL" | "FAIL"; violations?: { kind: string; turnSeq: number; text: string }[] } | null
    const violations = (review?.violations ?? []).map((item) => ({ kind: labelIn(item.kind), turn: item.turnSeq, text: item.text }))
    const base: DossierItem = ingested ? { ...roboCallItem(ingested), id: `line-${event.id}`, at } : {
      id: `line-${event.id}`, at, kind: "call", title, detail: lines.length ? null : "The phone recorded no words.", strength: "recorded", source: "", tone: "neutral",
      turns: lines.map((line) => ({ speaker: line.role === "model" ? (inbound ? "Road Desk" : "Mira from Bahn") : inbound ? "Driver" : "Desk", text: line.text, at })),
    }
    behind.push({
      ...base, title: review?.verdict ? `${title} · review ${review.verdict.toLowerCase()}` : title,
      source: `${line}, transcript of the phone's recording`, tone: violations.length ? "danger" : base.tone,
      violations, verdict: review?.verdict ?? null,
    })
    recent.push({ id: `line-${event.id}`, at, text: violations.length ? `${title}: ${violations.length} forbidden line${violations.length === 1 ? "" : "s"}` : title })
  }

  for (const call of robo) {
    if (ingestedIds.has(call.id)) continue
    const item = roboCallItem(call)
    // The call service stamps calls with its own wall clock, which can be ahead of the simulated one.
    const ahead = Boolean(item.at && !isBefore(item.at, now))
    if (ahead) item.detail = [item.detail, "Timed by the call service's own clock, not the simulated clock."].filter(Boolean).join(" ")
    behind.push(item)
    // A delivery run from the Demo page walks the order's future; its calls say so instead of reading as done.
    recent.push({ id: item.id, at: call.startedAt, text: ahead ? `${item.title} (simulated delivery run, ahead of the clock)` : item.title })
  }

  // Where the dossier service has typed a record, its evidence word wins over ours, except for judgements made here against the clock.
  const typedStrength = strengthIndex(typed)
  for (const item of [...ahead, ...behind]) {
    if (!item.ref || ["missed", "unverified", "simulated", "agent", "decision"].includes(item.strength)) continue
    const word = typedStrength.get(`${item.ref.collection}:${item.ref.id}`)
    if (word && word !== "reference") item.strength = word
  }

  // ---- the one thing that needs a person
  let need: DossierView["need"] = null
  for (const kase of view.cases) {
    for (const card of kase.pending) need ??= { title: card.title, ask: card.recommendation ?? card.rationale, since: card.createdAt, sinceLabel: t.at(card.createdAt), href: `/orders/${bundle.order.id}#case` }
  }
  const open = view.attention.filter((item) => item.kind !== "case")
  // Only an operator item is a need (red); an open alert or a conversation is a signal and goes to Watching (amber).
  const pressing = open.find((item) => (item.tone === "danger" || item.tone === "warn") && needsPersonItem(item)) ?? open.find(needsPersonItem)
  // The path ends at the conversation: the case's call, the alert's thread, else the liveliest open thread.
  const liveThread = [...view.threads].filter((thread) => thread.status !== "CLOSED" && thread.status !== "RESOLVED").sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0] ?? view.threads[0] ?? null
  const threadAnchor = liveThread ? `#thread-${liveThread.id}` : "#timeline"
  if (need) {
    const kase = view.cases.find((item) => item.pending.some((card) => card.title === need?.title))
    const call = kase ? view.calls.find((item) => item.caseId === kase.id) : null
    need.href = `/orders/${bundle.order.id}${call ? `#call-${call.id}` : kase ? `#case-${kase.id}` : "#case"}`
  }
  if (!need && pressing) {
    const alert = pressing.kind === "alert" || pressing.kind === "owned_alert" ? view.alerts.find((item) => item.id === pressing.recordId) : null
    const anchor = pressing.kind === "conversation" || pressing.kind === "waiting" ? `#thread-${pressing.recordId}` : alert?.conversationId ? `#thread-${alert.conversationId}` : threadAnchor
    need = { title: pressing.title, ask: pressing.detail, since: pressing.at, sinceLabel: pressing.at ? t.at(pressing.at) : null, href: `/orders/${bundle.order.id}${anchor}` }
  }

  // ---- watching: deadlines at risk, conflicts, silent gaps, open reviews
  const gps = bundle.cr.gps
  const gpsAt = gps ? gps.at.toISOString() : null
  const phoneQuiet = !!gpsAt && ((minutesBetween(gpsAt, now) ?? 0) > 30 || car?.phone === "STALE")
  if (bundle.order.lane === "moving" && phoneQuiet && gpsAt) watching.push({
    id: "w-phone", tone: "warn", at: gpsAt, text: `No phone position since ${t.at(gpsAt)}`,
    why: car?.phoneNote ?? "The driver app has stopped reporting. The last position is old; it says nothing about where the car is now.",
    sources: ["Driver's phone GPS, simulated"],
  })
  if (bundle.order.lane === "moving" && !gps && car?.phone === "NONE") watching.push({
    id: "w-phone", tone: "warn", at: null, text: "No phone position on this trip", why: "The driver app has not reported a position since the trip started.", sources: ["Driver's phone GPS, simulated"],
  })
  if (promiseDate?.tone === "danger") watching.push({
    id: "w-promise", tone: "danger", at: promiseDate.end ?? promiseDate.start, text: `Delivery promise ${promiseRange} at risk`,
    why: `${promiseDate.note ?? ""}${etaDate ? ` The estimate comes from the driver app (${etaDate.note ?? "unverified"}); it is a claim, not a position.` : ""}`.trim(),
    sources: [promiseDate.source === "CUSTOMER" ? "Promise agreed with the customer" : "Delivery window in the records", ...(etaDate ? ["Driver app estimate"] : [])],
  })
  const slot = keyDates.find((date) => date.key === "pickup_slot")
  if (slot?.tone === "warn") watching.push({ id: "w-slot", tone: "warn", at: slot.start, text: `Pickup slot ${t.at(slot.start)}: ${slot.note}`, why: "The slot is the selected pickup window; nothing in the records shows the car collected.", sources: ["Pickup slot in the records"] })
  for (const item of open) {
    if (need && item.title === need.title) continue
    if (item.kind === "decision") continue
    const since = chainSteps.find((step) => step.text.toLowerCase().includes(item.title.toLowerCase().replace(/^open alert: /, "").slice(0, 20)))?.at ?? item.at
    const conflict = item.kind === "claim"
    watching.push({
      id: `w-${item.recordId}`, tone: item.tone === "danger" && ["alert", "owned_alert", "conversation", "waiting", "claim"].includes(item.kind) ? "warn" : item.tone, at: item.at,
      text: conflict ? `Records disagree: ${item.title}` : `${item.title.replace(/^(Open|Owned) alert: /, "")}${item.kind === "alert" || item.kind === "owned_alert" || item.kind === "work" ? ` under review since ${t.at(since)}` : ""}`,
      why: item.detail ?? "From the records.", sources: [label(item.kind === "owned_alert" ? "alert" : item.kind)],
    })
  }
  // The steps of review chains go into the fold of the line they belong to (or the need).
  const chainLines = chainSteps.sort((a, b) => a.at.localeCompare(b.at)).map((step) => step.text)
  const rankTone: Record<Tone, number> = { danger: 0, warn: 1, accent: 2, neutral: 3, ok: 4 }
  watching.sort((a, b) => rankTone[a.tone] - rankTone[b.tone])
  const shownWatching = watching.filter((item, index) => watching.findIndex((other) => other.text === item.text) === index).slice(0, 3)
  if (need && chainLines.length) need.chain = chainLines
  else if (shownWatching[0] && chainLines.length) shownWatching[0].sources = [...shownWatching[0].sources, ...chainLines]

  // ---- journey strip
  const pickup = steps.find((step) => step.role === "PICKUP")
  const delivery = [...steps].reverse().find((step) => step.role === "DELIVERY")
  const moving = bundle.order.lane === "moving"
  const placeLabel = gps && typeof (gps.data as Record<string, unknown>).place_label === "string" ? String((gps.data as Record<string, unknown>).place_label) : null
  const strip: StripPoint[] = [
    { label: "Pickup", place: pickup?.place.city ?? header.from.city, state: pickedUpAt ? "done" : "planned", note: pickedUpAt ? `picked up ${t.at(pickedUpAt)}` : slot ? `slot ${t.at(slot.start)}` : null },
    ...steps.filter((step) => step.role === "TRANSFER").map((step) => ({ label: "Yard", place: step.place.city, state: (step.recorded ? "done" : "planned") as StripPoint["state"], note: step.recorded?.label ?? null })),
    ...ferryStrip,
    { label: "Delivery", place: delivery?.place.city ?? header.to.city, state: deliveredAt ? "done" : "planned", note: deliveredAt ? `delivered ${t.at(deliveredAt)}` : promiseRange ? `promised ${promiseRange}` : null },
  ]
  if (moving && !strip.some((point) => point.state === "now")) {
    const nextIndex = strip.findIndex((point) => point.state !== "done")
    strip.splice(Math.max(1, nextIndex), 0, {
      label: "Now", place: placeLabel ? placeLabel.replace(/^(On the road|Last app position) /, "") : "no position", state: "now",
      note: gpsAt ? `simulated phone, ${phoneQuiet ? `last seen ${t.at(gpsAt)}` : t.clock(gpsAt)}` : null,
    })
  }

  // ---- how far along: the simulated position along the route shape, else the driver app's last progress report
  // Stages: from the sim's route parts when the car has one (a crossing is its own segment), else pickup to delivery.
  const stops: NonNullable<DossierView["progress"]>["stops"] = [{ at: 0, label: "Pickup", place: header.from.city }]
  const segments: NonNullable<DossierView["progress"]>["segments"] = []
  if (car && car.pathKm > 0) {
    for (const part of car.parts) {
      const from = part.startKm / car.pathKm
      const to = (part.startKm + part.km) / car.pathKm
      segments.push({ from, to, kind: part.kind, label: part.kind === "sea" ? `Ferry, ${car.ferry?.originName ?? ""} to ${car.ferry?.destinationName ?? ""}`.replace(/, $/, "") : part.label })
    }
    if (car.ferry) {
      const sea = car.parts.find((part) => part.kind === "sea")
      if (sea) {
        stops.push({ at: sea.startKm / car.pathKm, label: "Terminal", place: car.ferry.originName })
        stops.push({ at: (sea.startKm + sea.km) / car.pathKm, label: "Terminal", place: car.ferry.destinationName })
      }
    }
  } else segments.push({ from: 0, to: 1, kind: "road", label: `${header.from.city} to ${header.to.city}` })
  stops.push({ at: 1, label: "Delivery", place: header.to.city })
  let progress: DossierView["progress"] = null
  if (deliveredAt) progress = { fraction: 1, remainingKm: 0, basis: "delivered", stops, segments }
  else if (moving && car && gps) {
    const data = gps.data as Record<string, unknown>
    const at: LatLng | null = typeof data.lat === "number" && typeof data.lng === "number" ? [data.lat, data.lng] : null
    if (at) {
      let best = { part: 0, index: 0, distance: Infinity }
      car.parts.forEach((part, partIndex) => part.coords.forEach((point, index) => {
        const distance = (point[0] - at[0]) ** 2 + ((point[1] - at[1]) * Math.cos(at[0] * Math.PI / 180)) ** 2
        if (distance < best.distance) best = { part: partIndex, index, distance }
      }))
      const part = car.parts[best.part]
      const drawn = polylineKm(part.coords)
      const along = drawn > 0 ? polylineKm(part.coords.slice(0, best.index + 1)) / drawn : 0
      const covered = part.startKm + part.km * along
      const fraction = Math.max(0, Math.min(1, covered / car.pathKm))
      // The simulated track is drawn, not measured: the km to go are the share of the planned distance the route card
      // shows, so the bar and the card never disagree.
      const leg = (bundle.related.transport_segments ?? []).find((row) => row.id === car.segmentId)
      const planned = typeof leg?.details.distance_km === "number" ? leg.details.distance_km : 0
      progress = { fraction, remainingKm: Math.max(0, Math.round(planned > 0 ? (1 - fraction) * planned : car.pathKm - covered)), basis: "simulated phone position along the route", stops, segments }
    }
  }
  if (!progress && moving) {
    const report = latestTracking(bundle).direct
    if (report?.progress != null) progress = { fraction: Math.max(0, Math.min(1, report.progress)), remainingKm: report.remainingKm != null ? Math.round(report.remainingKm) : null, basis: "driver app progress report", stops, segments }
  } else if (!progress && pickedUpAt == null) progress = { fraction: 0, remainingKm: null, basis: "not picked up yet", stops, segments }
  if (progress && moving) {
    const now = strip.find((point) => point.state === "now")
    const words = `${Math.round(progress.fraction * 100)} % of the way${progress.remainingKm != null ? ` · ${progress.remainingKm.toLocaleString("en-GB")} km to go` : ""}`
    if (now) now.note = [words, now.note].filter(Boolean).join(" · ")
  }

  // ---- the headline: one sentence of state, in plain words
  const first = driver?.split(" ")[0] ?? "The driver"
  let headline = view.story.headline
  if (moving) {
    const where = placeLabel ?? ""
    let state = `${first} is driving it to ${header.to.city}`
    if (phoneQuiet && gpsAt) state = `${first}'s phone has been quiet since ${t.at(gpsAt)}, last seen ${where.replace(/^(On the road|Last app position|Stopped) /, "")}`
    else if (/^Pulling into/.test(where)) state = `${first} is ${where.charAt(0).toLowerCase()}${where.slice(1)}`
    else if (/^Stopped/.test(where) || car?.stoppedNote) state = `${first} has stopped ${where.replace(/^Stopped /, "")}`
    else if (/service area|parking|rest area/i.test(where) && !/^On the road/.test(where)) state = `${first} has stopped at ${where}`
    else if (/^On the ferry/.test(where)) state = `${first} is on the ferry to ${car?.ferry?.destinationName ?? header.to.city}`
    else if (/^At /.test(where)) state = `${first} is waiting ${where.charAt(0).toLowerCase()}${where.slice(1)}`
    else if (/^Near the delivery/.test(where)) state = `${first} is near the delivery address in ${header.to.city}`
    let timing = ""
    if (etaDate && promiseDate?.end && promiseRange) {
      const late = minutesBetween(promiseDate.end, etaDate.start) ?? 0
      const halted = !/^(\w+) is (driving|on the ferry|near)/.test(state)
      timing = phoneQuiet || halted ? `; the driver app's last estimate was ${t.at(etaDate.start)} against the ${promiseRange} promise`
        : late > 0 ? `, about ${duration(late)} late against the ${promiseRange} promise by the driver app's estimate`
        : `, expected ${t.at(etaDate.start)}, inside the ${promiseRange} promise`
    } else if (promiseRange) timing = `; promised ${promiseRange}`
    headline = `${state}${timing}.`
  } else if (bundle.order.lane === "booked" && driver) {
    headline = `${first} is booked to collect it in ${header.from.city}${slot ? `, slot ${t.at(slot.start)}` : ""}.`
  }

  ahead.sort((a, b) => String(a.at).localeCompare(String(b.at)))
  behind.sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")))
  recent.sort((a, b) => String(b.at).localeCompare(String(a.at)))
  // The same thing said twice (a call run again) is one line.
  const recentLines = recent.filter((item, index) => recent.findIndex((other) => other.text === item.text) === index)

  // ---- the full dossier: every record, as the dossier service typed it
  const records: DossierView["records"] = typed
    ? Object.entries(typed.classes).filter(([, items]) => items.length).map(([name, items]) => ({
      label: label(name), items: items.map((item) => ({ label: label(item.collection), at: item.at, when: item.at ? t.at(item.at) : null, strength: STRENGTH_WORD[item.strength] ?? labelIn(item.strength) })),
    }))
    : view.otherRecords.map((record) => ({ label: record.label, items: [{ label: `${record.count} record${record.count === 1 ? "" : "s"}`, at: null, when: null, strength: "" }] }))

  // ---- a fault from the car's dongle, only when there is one
  const strip_ = telemetryStrip(bundle)
  let fault: DossierView["fault"] = null
  if (strip_ && (strip_.codes.length || (strip_.mil && strip_.mil !== "OFF"))) {
    const frozen = await crDb().select({ data: crTelemetry.data }).from(crTelemetry)
      .where(and(eq(crTelemetry.orderId, bundle.order.id), eq(crTelemetry.source, "OBD"), sql`${crTelemetry.data} -> 'freeze_frame' IS NOT NULL AND ${crTelemetry.data} -> 'freeze_frame' <> 'null'::jsonb`))
      .orderBy(desc(crTelemetry.at)).limit(1).catch(() => [])
    const frame = (frozen[0]?.data as Partial<ObdData> | undefined)?.freeze_frame ?? null
    const pickupNotes = [
      ...view.proofs.filter((proof) => proof.pointId === pickup?.id || /pickup/i.test(proof.pointLabel ?? proof.kindLabel)).map((proof) => proof.note),
      ...view.documents.filter((document) => /condition|pickup|inspection/i.test(`${document.kind} ${document.kindLabel}`)).map((document) => document.note),
    ].filter((note): note is string => !!note)
    const mention = pickupNotes.find((note) => /warning|lamp|light|engine|fault|code|dashboard/i.test(note))
    fault = {
      lamp: strip_.mil === "FLASHING" ? "Check-engine light flashing" : strip_.mil === "ON" ? "Check-engine light on" : null,
      codes: strip_.codes.map((code) => ({ code: code.code, title: code.title, severity: code.severity, tone: code.tone })),
      freezeSpeed: frame && typeof frame.values.speed_kmh === "number" ? `${Math.round(frame.values.speed_kmh)} km/h when ${frame.code} was set, ${t.at(frame.at)}` : null,
      atPickup: mention ? `Reported at pickup: ${sentence(mention, 140)}` : "Not in the pickup record",
      when: strip_.at ? t.at(strip_.at) : null,
    }
  }

  const primary = bundle.items.find((item) => item.role === "PRIMARY") ?? bundle.items[0] ?? null
  return {
    orderId: bundle.order.id, reference: bundle.order.reference,
    vehicle: header.vehicle?.title ?? "Vehicle not linked", make: primary?.vehicle.make ?? null,
    customer: bundle.customer.name, driver, from: header.from.city, to: header.to.city, laneLabel: header.laneLabel, zone, simNow: now,
    headline, tone: need ? "danger" : attentionTone(view.attention, view.story.tone),
    need, fault, strip, progress, watching: shownWatching, conversationHref: need?.href ?? `/orders/${bundle.order.id}${view.calls[0] ? `#call-${view.calls[0].id}` : threadAnchor}`, recent: recentLines.slice(0, 3), ahead, behind, records, recordsFromService: !!typed,
  }
}

const STRENGTH_WORD: Record<string, string> = {
  REFERENCE: "Reference", REQUEST: "Request", PLAN: "Plan", QUOTE: "Quote", BOOKING: "Booking", COMMITMENT: "Commitment", CLAIM: "Claim",
  OBSERVATION: "Observation", VERIFIED: "Verified", REJECTED: "Rejected", DECISION: "Decision", SIGNAL: "Signal", PROPOSAL: "Proposal", RECORD: "Record",
}

const PURPOSE_WORDS: Record<string, string> = {
  PICKUP_READINESS: "pickup readiness", DRIVER_START_CHECK: "driver start check", DRIVER_INBOUND: "driver call",
}

/** One robo-call as a line: who, why, what it established (each citing its turn), what it did not, and the retry. */
function roboCallItem(call: CallRecord): DossierItem {
  const callee = call.brief?.callee.name ?? (call.brief?.callee.kind ? labelIn(call.brief.callee.kind) : "the other party")
  const inbound = call.direction === "INBOUND"
  const purpose = call.brief?.purpose ? PURPOSE_WORDS[call.brief.purpose] ?? labelIn(call.brief.purpose).toLowerCase() : null
  const said = new Set(call.slots.map((slot) => slot.value.slot))
  const missing = (call.brief?.ask ?? []).filter((slot) => !said.has(slot)).map(slotLabel)
  const escalation = call.toolCalls.find((tool) => tool.name === "ESCALATE_TO_OPERATOR")
  const triage = typeof call.triage === "object" && call.triage ? call.triage : null
  // The service records Road Desk's voice as CALLER and the other party as CALLEE, whoever dialled.
  const speaker = (turn: CallRecord["turns"][number]) => turn.speaker === "CALLER" ? "Road Desk" : callee
  const outcome = escalation ? "handed to an operator" : call.outcome === "COMPLETED" ? "all answers taken" : missing.length ? `${missing.length} answer${missing.length === 1 ? "" : "s"} still open` : labelIn(call.outcome).toLowerCase()
  return {
    id: `robo-${call.id}`, at: call.startedAt, kind: "call",
    title: `${inbound ? `${callee} called in` : `Robo-call to ${callee}`}${purpose ? ` (${purpose})` : ""}${triage?.urgency ? `, ${String(triage.urgency).toLowerCase()}` : ""}: ${outcome}`,
    detail: call.retryAfter ? `Tries again ${call.retryAfter.slice(11, 16)} UTC.` : null,
    strength: "recorded", source: call.engine === "SIMULATED_LLM" ? "Model-simulated call, transcript" : "Scripted simulated call, transcript", tone: escalation ? "danger" : call.outcome === "COMPLETED" ? "ok" : "warn",
    turns: call.turns.map((turn) => ({ speaker: speaker(turn), text: turn.text, at: turn.startedAt })),
    slots: call.slots.map((slot) => ({ label: slotLabel(slot.value.slot), value: slotValue(slot.value.value), quote: slot.quote, turn: slot.turnSeq })),
    missing, escalated: escalation ? readToolArgument(escalation.argument) : null,
  }
}
