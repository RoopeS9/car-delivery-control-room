import assert from "node:assert/strict"
import { test } from "node:test"
import type { CaseRow } from "@/lib/cr/queries"
import { buildEffectiveOrder } from "@/lib/cr/effective"
import { Directory } from "./actors"
import { type Bundle, emptyCr } from "./bundle"
import { callTranscriptViews, sourceChip } from "./cases"
import { buildQueue } from "./queue"
import { chosenWindows, currentEta, latestTracking } from "./attention"
import { buildBoardCard } from "./board"
import { buildMap } from "./map"

const NOW = "2026-10-21T09:00:00Z"

function bundle(): Bundle {
  return {
    snapshotAt: NOW,
    order: { id: "order-1", reference: "CD-420584", lane: "intake", status: "NEW", routeKind: "DOMESTIC", createdAt: NOW, updatedAt: NOW,
      details: {}, pickupAddressId: "pickup", deliveryAddressId: "delivery", pickupSiteId: null, deliverySiteId: null },
    customer: { id: "customer-1", name: "Fictional dealer", tier: null, country: "FI" },
    items: [], alerts: [], conversations: [], messages: [], events: [], related: {}, places: new Map(), sites: new Map(), inboxThreads: [], bundleOrderRefs: {},
    dir: new Directory({ drivers: [{ id: "driver-1", displayName: "Leo Quellford", homeCity: null, homeCountry: null }], operators: [], agents: [], customers: [], sites: [], endpointDetails: [], snapshots: new Map() }),
    cr: emptyCr(NOW),
  }
}

function waitingCase(linkedRecords: CaseRow["linkedRecords"] = []): CaseRow {
  return {
    id: "case-1", orderId: "order-1", kind: "DRIVER_QUESTION", status: "WAITING_EXTERNAL", urgency: "NORMAL", title: "Driver asks about keys",
    summary: "Waiting for the driver", owner: "agent", openedAt: new Date(NOW), updatedAt: new Date(NOW), resolvedAt: null,
    nextCheckAt: new Date("2026-10-21T09:30:00Z"), waitingOn: "the driver", nextAction: "Read the reply", linkedRecords,
  } as CaseRow
}

test("an unrelated urgent record remains in Needs your decision beside a waiting agent case", () => {
  const data = bundle()
  data.cr.cases.push(waitingCase())
  data.alerts.push({ id: "alert-1", status: "OPEN", severity: "critical", signal: "DOCUMENTS_MISSING", summary: "Release papers are missing", triggeredAt: NOW, details: {} })
  const queue = buildQueue([data], NOW, NOW)
  assert.equal(queue.decide.length, 1)
  assert.equal(queue.waiting.length, 0)
  assert.equal(queue.decide[0].origin, "records")
  assert.equal(queue.decide[0].ask, "Release papers are missing")
})

test("a record already taken over by the waiting case does not create another decision", () => {
  const data = bundle()
  data.cr.cases.push(waitingCase([{ kind: "alerts", id: "alert-1", label: "Warning alert", at: NOW }]))
  data.alerts.push({ id: "alert-1", status: "OPEN", severity: "critical", signal: "VEHICLE_WARNING", summary: "Warning under investigation", triggeredAt: NOW, details: {} })
  const queue = buildQueue([data], NOW, NOW)
  assert.equal(queue.decide.length, 0)
  assert.equal(queue.waiting.length, 1)
})

test("call evidence uses the recorded transcript and preserves differing live words", () => {
  const data = bundle()
  data.cr.calls.push({ id: "call-1", caseId: null, driverId: "driver-1", startedAt: new Date(NOW), endedAt: null, direction: "DRIVER_INITIATED", urgency: "URGENT", urgencyTurnId: "turn-1", readbackConfirmed: false, state: { urgencyQuote: "I am stopped safely." } } as Bundle["cr"]["calls"][number])
  data.cr.callTurns.push({ id: "turn-1", callId: "call-1", seq: 1, speaker: "driver", startedAt: new Date(NOW), textFinal: "I am stopped safely.", textLive: "I am not stopped safely.", audioKey: "voice/calls/call-1/turn-1.webm", interrupted: false, flags: {} } as Bundle["cr"]["callTurns"][number])
  const view = callTranscriptViews(data)[0]
  assert.equal(view.caseId, null, "call is visible before analyst linkage")
  assert.equal(view.urgencyQuote, "I am stopped safely.")
  assert.equal(view.turns[0].text, "I am stopped safely.")
  assert.equal(view.turns[0].liveText, "I am not stopped safely.")
  assert.equal(view.turns[0].audioUrl, "/api/voice/calls/call-1/audio/turn-1")
  assert.equal(sourceChip({ kind: "cr_call_turns", id: "turn-1", label: "Driver's words", at: NOW }).href, "#call-turn-turn-1")
})

test("effective promise and ETA agree across fleet views without rewriting snapshot evidence", () => {
  const data = bundle()
  data.order.lane = "moving"
  const original = { id: "window-1", purpose: "CUSTOMER_DELIVERY_PROMISE", is_selected: true, start_at: "2026-10-21T10:00:00Z", end_at: "2026-10-21T14:00:00Z", source: "CUSTOMER", timezone: "UTC" }
  data.related.time_windows = [{ id: original.id, details: original }]
  data.related.tracking_observations = [{ id: "track-1", details: { id: "track-1", source: "driver_app", observed_at: "2026-10-21T08:00:00Z", received_at: "2026-10-21T08:01:00Z", estimated_delivery_at: "2026-10-21T13:00:00Z", location_quality: "COARSE" } }]
  data.cr.cases.push(waitingCase())
  const effect = (id: string, kind: string, state: string, value: Record<string, unknown>, supersedesId: string | null = null) => ({ id, orderId: data.order.id, caseId: "case-1", kind, state, value, supersedesId, at: new Date(NOW), authority: { by: "ops-shift", by_type: "operator", basis: "Agreed with the dealer on the phone" } }) as Bundle["cr"]["effects"][number]
  const related = Object.entries(data.related).flatMap(([collection, rows]) => (rows ?? []).map((row) => ({ collection, details: row.details })))
  const proposed = effect("proposed", "PROMISE_CHANGE", "PROPOSED_TO_CUSTOMER", { start_utc: "2026-10-22T10:00:00Z", end_utc: "2026-10-22T14:00:00Z", text: "Tomorrow 10:00–14:00" })
  data.cr.effective = buildEffectiveOrder(data.order.id, related, [proposed])
  assert.equal(chosenWindows(data).promise?.start, original.start_at, "operator approval alone does not change the promise")

  data.cr.effects = [proposed, effect("agreed", "PROMISE_CHANGE", "CUSTOMER_AGREED", proposed.value, proposed.id), effect("eta", "ETA_ESTIMATE", "ESTIMATED", { estimate_utc: "2026-10-22T12:00:00Z", text: "Tomorrow at noon" })]
  data.cr.effective = buildEffectiveOrder(data.order.id, related, data.cr.effects)
  assert.equal(chosenWindows(data).promise?.start, "2026-10-22T10:00:00Z")
  assert.equal(currentEta(data)?.at, "2026-10-22T12:00:00Z")
  assert.equal(latestTracking(data).direct?.eta, "2026-10-21T13:00:00Z", "an updated ETA is not a new driver position report")
  assert.equal(buildBoardCard(data).decisive?.start, "2026-10-22T10:00:00Z")
  assert.match(buildQueue([data], NOW, NOW).waiting[0].more ?? "", /Promise now.*22 Oct/)
  const gps = { id: "gps-1", orderId: data.order.id, vehicleId: null, source: "PHONE_GPS", at: new Date(NOW), data: { lat: 60, lng: 25 }, simulated: true } as Parameters<typeof buildMap>[1][number]
  assert.match(buildMap([data], [gps], NOW).markers[0].timing ?? "", /ETA estimate/)
  assert.equal(data.related.time_windows[0].details.start_at, "2026-10-21T10:00:00Z")
})

test("a confirmed reconciliation replaces the uncertain booking and keeps its evidence history", () => {
  const effect = (id: string, kind: string, state: string, value: Record<string, unknown>, supersedesId: string | null = null) => ({ id, orderId: "order-1", caseId: "case-1", proposalId: "proposal-1", kind, state, value, supersedesId, at: new Date(NOW), authority: { by: "ops-shift", by_type: "operator", basis: "Checked with the ferry operator" } }) as Bundle["cr"]["effects"][number]
  const unknown = effect("unknown", "BOOKING", "UNCONFIRMED", { kind: "ferry", reference: "FICTIONAL-123" })
  const confirmed = effect("confirmed", "BOOKING", "RECORDED", { ...unknown.value, reconciled: true }, unknown.id)
  const outcome = effect("outcome", "OUTCOME_LOGGED", "RECORDED", { text: "Carrier confirms the booking", booking_exists: true })
  const current = buildEffectiveOrder("order-1", [], [unknown, confirmed, outcome])
  assert.equal(current.bookings.length, 1)
  assert.equal(current.bookings[0].source.id, "confirmed")
  assert.equal(current.bookings[0].status, "booked (simulated)")
  assert.equal(current.effects.length, 3, "the uncertain attempt and reconciliation stay in history")
})

test("a reconciliation confirming no booking removes it from current bookings without deleting history", () => {
  const effect = (id: string, kind: string, state: string, value: Record<string, unknown>) => ({ id, orderId: "order-1", caseId: "case-1", proposalId: "proposal-1", kind, state, value, supersedesId: null, at: new Date(NOW), authority: { by: "ops-shift", by_type: "operator", basis: "Checked with the ferry operator" } }) as Bundle["cr"]["effects"][number]
  const unknown = effect("unknown", "BOOKING", "UNCONFIRMED", { kind: "ferry", reference: "FICTIONAL-123" })
  const outcome = effect("outcome", "OUTCOME_LOGGED", "RECORDED", { text: "Carrier confirms no booking exists", booking_exists: false })
  assert.equal(buildEffectiveOrder("order-1", [], [unknown]).bookings[0].status, "not confirmed by the provider")
  const current = buildEffectiveOrder("order-1", [], [unknown, outcome])
  assert.equal(current.bookings.length, 0)
  assert.equal(current.effects.length, 2)
  assert.equal(current.effects[1].value.booking_exists, false)
})
