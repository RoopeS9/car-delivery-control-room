import assert from "node:assert/strict"
import { test } from "node:test"
import { buildEffectiveOrder } from "@/lib/cr/effective"
import type { EffectRow, ProposalRow } from "@/lib/cr/queries"
import type { BookingSelection } from "@/lib/cr/types"
import { bookingSchedule, currentFerrySchedule, historicalFerrySchedules } from "./bookings"
import { emptyCr, type Bundle } from "./bundle"
import { decisionCardView } from "./cases"

const NOW = "2026-10-21T09:00:00Z"
const reservation = {
  id: "reservation-original", kind: "FERRY", status: "BOOKED", booking_reference: "ORIGINAL-584",
  origin_terminal: "West Baltic Vehicle Terminal", destination_terminal: "South Finland Vehicle Terminal",
  departure_at: "2026-10-21T17:30:00Z", expected_arrival_at: "2026-10-22T23:30:00Z",
  check_in_cutoff_at: "2026-10-21T15:30:00Z", check_in_confirmation: "UNCONFIRMED", booked_at: NOW,
}
const selected: BookingSelection = {
  quote_id: "ferry-next", quote_source: { kind: "cr_events", id: "lookup-1", label: "Ferry options, simulated", at: NOW },
  quoted_at: NOW, kind: "ferry", provider: "Fictional Coast Lines", from: reservation.origin_terminal, to: reservation.destination_terminal,
  departure_at: "2026-10-22T07:00:00Z", arrival_at: "2026-10-23T12:00:00Z", check_in_cutoff_at: "2026-10-22T05:00:00Z",
  price_amount: 449, currency: "EUR", replaces_reservation_id: reservation.id,
}
const effect = (id: string, state: "RECORDED" | "UNCONFIRMED", selection = selected): EffectRow => ({
  id, orderId: "order-584", caseId: "case-1", proposalId: `proposal-${id}`, kind: "BOOKING", state,
  value: { kind: "ferry", reference: `SIMULATED-${id}`, provider: selection.provider, booking_selection: selection },
  supersedesId: null, at: new Date(NOW), target: {}, evidenceRefs: [],
  authority: { by: "ops-shift", by_type: "operator", basis: "Approved the selected quote", at: NOW },
}) as EffectRow
const effective = (effects: EffectRow[]) => buildEffectiveOrder("order-584", [{ collection: "travel_reservations", details: reservation }], effects)

test("a confirmed replacement supplies the driver's exact new sailing, cutoff and cost", () => {
  const current = effective([effect("new", "RECORDED")])
  const ferry = currentFerrySchedule(current, [reservation])
  assert.equal(ferry?.reference, "SIMULATED-new")
  assert.equal(ferry?.departureAt, selected.departure_at)
  assert.equal(ferry?.arrivalAt, selected.arrival_at)
  assert.equal(ferry?.checkInCutoffAt, selected.check_in_cutoff_at)
  assert.equal(ferry?.priceAmount, 449)
  assert.equal(ferry?.simulated, true)
  assert.equal(ferry?.checkInConfirmed, false, "a replacement booking does not inherit check-in evidence")
  assert.equal(historicalFerrySchedules(current, [reservation])[0].reference, "ORIGINAL-584")
  assert.equal(reservation.check_in_cutoff_at, "2026-10-21T15:30:00Z", "history is not rewritten")
})

test("an unknown booking outcome keeps the original sailing current", () => {
  const current = effective([effect("uncertain", "UNCONFIRMED")])
  assert.equal(currentFerrySchedule(current, [reservation])?.reference, "ORIGINAL-584")
  assert.equal(currentFerrySchedule(current, [reservation])?.checkInCutoffAt, reservation.check_in_cutoff_at)
  assert.deepEqual(historicalFerrySchedules(current, [reservation]), [])
  const attempt = current.bookings.find((booking) => booking.source.kind === "cr_effects")
  assert.ok(attempt)
  assert.equal(bookingSchedule(attempt, [reservation]).confirmed, false)
})

test("a second confirmed replacement preserves both earlier ferry bookings as history", () => {
  const second = { ...selected, quote_id: "ferry-later", departure_at: "2026-10-23T07:00:00Z", replaces_reservation_id: "first" }
  const current = effective([effect("first", "RECORDED"), effect("second", "RECORDED", second)])
  assert.equal(currentFerrySchedule(current, [reservation])?.reference, "SIMULATED-second")
  assert.deepEqual(historicalFerrySchedules(current, [reservation]).map((booking) => booking.reference), ["ORIGINAL-584", "SIMULATED-first"])
})

test("the operator's approval card exposes the exact selected quote and replaced reservation", () => {
  const data = { cr: emptyCr(NOW), related: { travel_reservations: [{ id: reservation.id, details: reservation }] } } as unknown as Bundle
  const proposal = {
    id: "proposal-1", caseId: "case-1", actionType: "BOOK_TRAVEL", title: "Book the next ferry", rationale: "The original check-in will be missed",
    status: "PENDING", handover: null, changes: [], options: [], evidenceRefs: [], bookingSelection: selected,
    nextStepIfApproved: "Book the selected sailing", nextStepIfRejected: "Ask for another option", createdAt: new Date(NOW), createdBy: "road-agent", revision: 1,
  } as unknown as ProposalRow
  const card = decisionCardView(data, proposal)
  assert.equal(card.booking?.provider, selected.provider)
  assert.equal(card.booking?.departureAt, selected.departure_at)
  assert.equal(card.booking?.checkInCutoffAt, selected.check_in_cutoff_at)
  assert.equal(card.booking?.priceAmount, selected.price_amount)
  assert.equal(card.booking?.currency, "EUR")
  assert.equal(card.booking?.replaces, "ORIGINAL-584")
  assert.equal(card.booking?.source.label, selected.quote_source.label)
})
