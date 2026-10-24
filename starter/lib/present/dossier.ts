// The operator's view of one delivery, opened from the chart: who and what, a
// journey strip, and one progress timeline. Ahead: planned steps and deadlines,
// soonest first. Behind: what happened, newest first. Every line carries how
// strong its evidence is, in the dossier's words: a quote is not a booking, a
// booking is not a gate scan, a message is a claim, a phone position here is
// simulated. A waiting decision is one item at "now", not a card that leads.

import { fleetCar } from "@/lib/sim/fleet"
import { callsFor, serviceDossier, strengthIndex } from "./call-service"
import { slotLabel, slotValue, type CallRecord } from "./call-types"
import { deriveKeyDates, milestones } from "./attention"
import { type Bundle, num, rows, str } from "./bundle"
import { labelIn } from "./labels"
import { buildRecordView } from "./record"
import { fmtDateTime, isBefore, minutesBetween, relativeTo } from "./time"
import type { DossierItem, DossierView, StripPoint, Strength } from "./dossier-types"
import type { Tone } from "./types"

export type { DossierItem, DossierView, StripPoint, Strength }
export { STRENGTH_LABEL } from "./dossier-types"

const SOURCE_TONE: Record<string, Tone> = { danger: "danger", warn: "warn", accent: "accent", ok: "ok", neutral: "neutral" }

function when(iso: string | null, zone?: string | null): string {
  return iso ? fmtDateTime(iso, zone ?? null) : "time not recorded"
}

export async function buildDossier(bundle: Bundle): Promise<DossierView> {
  const view = buildRecordView(bundle)
  const now = bundle.cr.now
  const header = view.header
  const { pickedUpAt, deliveredAt } = milestones(bundle)
  const { keyDates } = deriveKeyDates(bundle)
  // The robo-call service runs beside the app; without it the dossier still renders.
  const [car, robo, typed] = await Promise.all([
    fleetCar(bundle.order.id).catch(() => null), callsFor(bundle.order.reference), serviceDossier(bundle.order.reference),
  ])
  const active = view.assignments.find((row) => row.status === "IN_PROGRESS") ?? view.assignments.find((row) => row.status !== "CANCELLED" && row.status !== "COMPLETED") ?? null
  const driver = car?.driverName ?? active?.driver.name ?? null
  const ahead: DossierItem[] = []
  const behind: DossierItem[] = []
  const push = (item: DossierItem) => (item.at && !isBefore(item.at, now) ? ahead : behind).push(item)

  // ---- journey steps and their windows
  const steps = view.journey.groups[0]?.steps ?? []
  for (const step of steps) {
    // Done steps are told by the event log line, with who recorded them; the
    // delivery window is told by the promise below.
    if (step.recorded || step.role === "DELIVERY") continue
    const slot = step.windows.find((window) => window.selected && window.purpose === "SELECTED_PICKUP_SLOT") ?? step.windows[0] ?? null
    if (!slot) continue
    const where = `${step.place.name}, ${step.place.city}`
    const passed = isBefore(slot.end ?? slot.start, now)
    const range = slot.end ? `${when(slot.start, slot.zone)} to ${when(slot.end, slot.zone)}` : when(slot.start, slot.zone)
    const item: DossierItem = {
      id: `step-${step.id}`, at: passed ? slot.end ?? slot.start : slot.start, kind: "step",
      title: passed ? `${step.roleLabel} window passed at ${where}` : `${step.roleLabel} at ${where}`,
      detail: [`${slot.label} ${range}`, slot.sourceLabel, passed ? "nothing recorded at this point" : null].filter(Boolean).join(" · "),
      strength: passed ? "missed" : "planned", source: slot.sourceLabel, tone: passed ? "warn" : "neutral",
    }
    ;(passed ? behind : ahead).push(item)
  }

  // ---- ferry and travel: booked, check-in by gate scan, departure, arrival
  const gate = rows(bundle, "ferry_terminal_events").map((row) => row.details)
  const terminals = new Map(rows(bundle, "ferry_terminals").map((row) => [row.id, str(row.details.name)]))
  const ferryStrip: StripPoint[] = []
  for (const reservation of view.reservations) {
    if (reservation.status === "CANCELLED" || reservation.replacedBy) continue
    const raw = rows(bundle, "travel_reservations").find((row) => row.id === reservation.id)?.details ?? {}
    const route = reservation.route ?? reservation.kindLabel
    if (reservation.bookedAt) behind.push({
      id: `res-${reservation.id}`, at: reservation.bookedAt, kind: reservation.kind === "FERRY" ? "ferry" : "travel",
      title: `${reservation.kindLabel} booked: ${route}`,
      detail: [reservation.reference ? `booking ${reservation.reference}` : null, reservation.departureAt ? `departs ${when(reservation.departureAt)}` : null, reservation.amendment].filter(Boolean).join(" · ") || null,
      strength: "booked", source: "Driver travel booking", tone: reservation.tone, ref: { collection: "travel_reservations", id: reservation.id },
    })
    if (reservation.kind !== "FERRY") continue
    const scans = gate.filter((row) => row.reservation_id === reservation.id).sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)))
    const terminal = terminals.get(str(raw.origin_terminal_id) ?? "") ?? str(raw.origin_terminal) ?? "the terminal"
    for (const scan of scans) {
      const accepted = scan.kind === "CHECK_IN_ACCEPTED"
      behind.push({
        id: `gate-${str(scan.id)}`, at: str(scan.occurred_at), kind: "ferry",
        title: accepted ? "Check-in confirmed by gate scan" : `Gate refused check-in`,
        detail: [str(scan.reason), str(scan.receipt_reference) ? `receipt ${str(scan.receipt_reference)}` : null, "boarding is not recorded by the gate"].filter(Boolean).join(" · "),
        strength: "verified", source: `Gate reader, ${terminal}`, tone: accepted ? "ok" : "danger", ref: { collection: "ferry_terminal_events", id: str(scan.id) ?? "" },
      })
    }
    const checkedIn = scans.some((scan) => scan.kind === "CHECK_IN_ACCEPTED")
    const cutoff = reservation.checkInCutoffAt
    if (cutoff) {
      if (!isBefore(cutoff, now)) ahead.push({
        id: `cutoff-${reservation.id}`, at: cutoff, kind: "deadline", title: `Ferry check-in closes at ${terminal}`,
        detail: `${route}${reservation.reference ? ` · ${reservation.reference}` : ""} · ${checkedIn ? "checked in by gate scan" : "no gate scan yet"}`,
        strength: "booked", source: "Carrier booking", tone: checkedIn ? "ok" : (minutesBetween(now, cutoff) ?? 999) < 180 ? "warn" : "neutral",
      })
      else if (!checkedIn) behind.push({
        id: `cutoff-${reservation.id}`, at: cutoff, kind: "deadline", title: "Ferry check-in cutoff passed with no gate scan",
        detail: reservation.status === "MISSED_CHECK_IN" ? "The booking is recorded as missed check-in." : "Check-in is not confirmed. A booking is not a gate scan.",
        strength: reservation.status === "MISSED_CHECK_IN" ? "recorded" : "unverified", source: "Carrier booking and gate records", tone: "warn",
      })
    }
    if (reservation.departureAt && !deliveredAt) {
      const departed = isBefore(reservation.departureAt, now)
      push({
        id: `dep-${reservation.id}`, at: reservation.departureAt, kind: "ferry",
        title: departed ? `Ferry departure time passed: ${route}` : `Ferry departs: ${route}`,
        detail: departed ? "Boarding is not recorded. Where the car is now comes only from the simulated phone." : reservation.arrivalAt ? `arrives ${when(reservation.arrivalAt)}` : null,
        strength: departed ? "unverified" : "booked", source: "Carrier booking", tone: "neutral",
      })
    }
    const sailing = reservation.departureAt && reservation.arrivalAt && isBefore(reservation.departureAt, now) && isBefore(now, reservation.arrivalAt)
    ferryStrip.push({
      label: "Ferry", place: route,
      state: checkedIn ? (sailing ? "now" : "done") : reservation.status === "MISSED_CHECK_IN" ? "missed" : cutoff && isBefore(cutoff, now) ? "unverified" : "planned",
      note: checkedIn ? "check-in by gate scan" : reservation.status === "MISSED_CHECK_IN" ? "missed check-in" : cutoff && isBefore(cutoff, now) ? "booked, no gate scan" : `booked, cutoff ${when(cutoff)}`,
    })
  }
  for (const option of view.options) {
    behind.push({
      id: `opt-${option.id}`, at: option.checkedAt, kind: "quote",
      title: `${option.kindLabel} quote${option.route ? `: ${option.route}` : ""}${option.quote ? `, ${option.quote}` : ""}`,
      detail: [option.statusLabel, option.provider, option.departureAt ? `departs ${when(option.departureAt)}` : null, "a quote, not a booking"].filter(Boolean).join(" · "),
      strength: "quote", source: option.provider ?? "Travel search", tone: "neutral", ref: { collection: "travel_options", id: option.id },
    })
  }

  // ---- the promise and the ETA
  const promiseDate = keyDates.find((date) => date.key === "promise")
  const etaDate = keyDates.find((date) => date.key === "eta")
  const promise = promiseDate ? {
    at: promiseDate.end ?? promiseDate.start,
    text: `${promiseDate.label} ${when(promiseDate.start, promiseDate.zone)}${promiseDate.end ? `–${fmtDateTime(promiseDate.end, promiseDate.zone).split(" ").slice(-2).join(" ")}` : ""}`,
    source: promiseDate.source === "CUSTOMER" ? "agreed with the customer" : labelIn(promiseDate.source) || "source not recorded",
    late: promiseDate.tone === "danger",
  } : null
  if (promiseDate && !deliveredAt) push({
    id: "promise", at: promiseDate.end ?? promiseDate.start, kind: "deadline",
    title: promiseDate.label === "Delivery promise" ? `Delivery promised by ${when(promiseDate.end ?? promiseDate.start, promiseDate.zone)}` : `${promiseDate.label} ${when(promiseDate.start, promiseDate.zone)}`,
    detail: promiseDate.note, strength: promiseDate.source === "CUSTOMER" ? "recorded" : "planned",
    source: promise?.source ?? "records", tone: promiseDate.tone,
  })
  const eta = etaDate ? {
    at: etaDate.start, text: `${when(etaDate.start, etaDate.zone)}`,
    strength: (etaDate.label.includes("Road Desk") ? "agent" : "claim") as Strength,
    source: etaDate.label.includes("Road Desk") ? "Road Desk estimate" : `Driver app estimate${etaDate.note ? `, ${etaDate.note.replace(/; unverified$/, "")}` : ""}`,
  } : null

  // ---- what happened: records, live case events, calls
  const callIds = new Set(view.calls.map((call) => call.id))
  for (const entry of view.timeline) {
    if (entry.kind === "voice" && callIds.size) continue
    const agentSide = entry.actorKind === "agent"
    let kind: DossierItem["kind"] = "event"
    let strength: Strength = "recorded"
    if (entry.kind === "message") { kind = "message"; strength = agentSide ? "agent" : "claim" }
    else if (entry.kind === "alert") { kind = "signal"; strength = "signal" }
    else if (entry.kind === "lookup") { kind = "agent"; strength = "agent" }
    else if (entry.kind === "telemetry" || entry.actorKind === "obd" || entry.actorKind === "phone") { kind = "telemetry"; strength = "simulated" }
    else if (entry.kind === "proposal") { kind = "agent"; strength = "agent" }
    else if (entry.kind === "decision") { kind = "decision"; strength = "decision" }
    else if (entry.kind === "safety") { kind = "agent"; strength = "agent" }
    else if (entry.kind === "note") { kind = "note"; strength = agentSide ? "agent" : "recorded" }
    else if (entry.kind === "photo") { kind = "message"; strength = "claim" }
    behind.push({
      id: `t-${entry.id}`, at: entry.at, kind, strength, tone: SOURCE_TONE[entry.tone] ?? "neutral",
      title: entry.text.length > 180 ? `${entry.text.slice(0, 177).trimEnd()}…` : entry.text,
      detail: entry.text.length > 180 ? entry.text : null,
      source: [entry.actorName, entry.channelLabel].filter(Boolean).join(", "), ref: { collection: entry.source.kind, id: entry.source.id },
    })
  }
  for (const call of view.calls) {
    const minutes = call.endedAt ? minutesBetween(call.startedAt, call.endedAt) : null
    behind.push({
      id: `call-${call.id}`, at: call.startedAt, kind: "call",
      title: `${call.directionLabel}${call.urgencyLabel ? ` · ${call.urgencyLabel.toLowerCase()}` : ""}`,
      detail: [call.urgencyQuote ? `“${call.urgencyQuote}”` : null, minutes != null ? `${Math.max(1, minutes)} min` : "still on the line", `${call.turns.length} turns`, call.readbackConfirmed ? "read back and confirmed by the driver" : null].filter(Boolean).join(" · "),
      strength: "recorded", source: `Voice call with ${call.driverName}, transcript of the recording`, tone: call.tone,
      turns: call.turns.map((turn) => ({ speaker: turn.speakerName, text: turn.text, at: turn.at })),
    })
  }

  for (const call of robo) behind.push(roboCallItem(call))

  // Where the dossier service has typed a record, its evidence word wins over
  // ours, except for the judgements made here against the clock.
  const typedStrength = strengthIndex(typed)
  for (const item of [...ahead, ...behind]) {
    if (!item.ref || ["missed", "unverified", "simulated", "agent", "decision"].includes(item.strength)) continue
    const word = typedStrength.get(`${item.ref.collection}:${item.ref.id}`)
    if (word && word !== "reference") item.strength = word
  }

  // ---- a waiting decision is one item at "now"
  let decision: DossierView["decision"] = null
  for (const kase of view.cases) {
    for (const card of kase.pending) {
      decision ??= { title: card.title, ask: card.recommendation ?? card.rationale, sinceLabel: relativeTo(card.createdAt, now)?.text ?? null, href: `/orders/${bundle.order.id}#case` }
    }
  }
  const attention = view.attention.find((item) => item.kind !== "case")
  if (!decision && attention && (attention.tone === "danger" || attention.tone === "warn")) {
    decision = { title: attention.title, ask: attention.detail, sinceLabel: attention.at ? relativeTo(attention.at, now)?.text ?? null : null, href: `/orders/${bundle.order.id}#${attention.section}` }
  }

  // ---- where it is now: the simulated phone
  const gps = bundle.cr.gps
  let position: DossierView["position"] = null
  if (gps) {
    const data = gps.data as Record<string, unknown>
    const at = gps.at.toISOString()
    const age = minutesBetween(at, now) ?? 0
    const stale = age > 30 || car?.phone === "STALE"
    position = {
      label: typeof data.place_label === "string" ? data.place_label : "Position reported",
      ageLabel: relativeTo(at, now)?.text ?? null, stale, speedKmh: stale ? null : num(data.speed_kmh),
    }
  }

  // ---- journey strip
  const pickup = steps.find((step) => step.role === "PICKUP")
  const delivery = [...steps].reverse().find((step) => step.role === "DELIVERY")
  const moving = bundle.order.lane === "moving"
  const strip: StripPoint[] = [
    { label: "Pickup", place: pickup?.place.city ?? header.from.city, state: pickedUpAt ? "done" : "planned", note: pickedUpAt ? `picked up ${when(pickedUpAt)}` : keyDates.find((date) => date.key === "pickup_slot")?.note ?? null },
    ...steps.filter((step) => step.role === "TRANSFER").map((step) => ({ label: "Yard", place: step.place.city, state: (step.recorded ? "done" : "planned") as StripPoint["state"], note: step.recorded?.label ?? null })),
    ...ferryStrip,
    { label: "Delivery", place: delivery?.place.city ?? header.to.city, state: deliveredAt ? "done" : "planned", note: deliveredAt ? `delivered ${when(deliveredAt)}` : promise ? promise.text.replace(/^Delivery promise /, "promised ") : null },
  ]
  if (moving && !strip.some((point) => point.state === "now")) {
    const nextIndex = strip.findIndex((point) => point.state !== "done")
    strip.splice(Math.max(1, nextIndex), 0, { label: "Now", place: position ? position.label.replace(/^On the road /, "") : "no position", state: "now", note: position ? `simulated phone, ${position.stale ? `last seen ${position.ageLabel}` : position.ageLabel}` : null })
  }

  ahead.sort((a, b) => String(a.at).localeCompare(String(b.at)))
  behind.sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")))
  const primary = bundle.items.find((item) => item.role === "PRIMARY") ?? bundle.items[0] ?? null
  return {
    orderId: bundle.order.id, reference: bundle.order.reference,
    vehicle: header.vehicle?.title ?? "Vehicle not linked", make: primary?.vehicle.make ?? null,
    plate: header.vehicle?.plate ?? null, year: header.vehicle?.year ?? null,
    customer: bundle.customer.name, customerNote: header.customer.tierLabel,
    driver, from: header.from.city, to: header.to.city, laneLabel: header.laneLabel,
    headline: view.story.headline, intro: view.story.intro, tone: view.story.tone, simNow: now,
    position, eta, promise, decision, strip, ahead, behind,
  }
}


const PURPOSE_WORDS: Record<string, string> = {
  PICKUP_READINESS: "pickup readiness", DRIVER_START_CHECK: "driver start check", DRIVER_INBOUND: "driver call",
}

/** One robo-call as a timeline line: who, why, what it established (each citing its turn), what it did not, and the retry. */
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
  return {
    id: `robo-${call.id}`, at: call.startedAt, kind: "call",
    title: `${inbound ? `${callee} called in` : `Robo-call to ${callee}`}${purpose ? `, ${purpose}` : ""}: ${labelIn(call.outcome).toLowerCase()}`,
    detail: [
      triage?.urgency ? `triaged ${String(triage.urgency).toLowerCase()}${triage.situation ? `, ${labelIn(String(triage.situation)).toLowerCase()}` : ""}` : null,
      call.slots.length ? `${call.slots.length} answer${call.slots.length === 1 ? "" : "s"} taken` : null,
      missing.length ? `not established: ${missing.join(", ").toLowerCase()}` : null,
      call.retryAfter ? `tries again ${fmtDateTime(call.retryAfter)}` : null,
      escalation ? "handed to an operator" : null,
    ].filter(Boolean).join(" · ") || null,
    strength: "recorded", source: `${call.engine === "SIMULATED" ? "Simulated call" : "Call"}, transcript of record`,
    tone: escalation ? "danger" : call.outcome === "COMPLETED" ? "ok" : "warn",
    turns: call.turns.map((turn) => ({ speaker: speaker(turn), text: turn.text, at: turn.startedAt })),
    slots: call.slots.map((slot) => ({ label: slotLabel(slot.value.slot), value: slotValue(slot.value.value), quote: slot.quote, turn: slot.turnSeq })),
    missing, escalated: escalation ? String(escalation.argument ?? "") : null,
  }
}
