// A single display contract for the driver's job card and voice interviewer.
// Confirmed replacements supply their own sailing; unresolved attempts never
// replace the original reservation's schedule.

import type { EffectiveBooking, EffectiveOrder } from "@/lib/cr/effective"
import type { BookingSelection } from "@/lib/cr/types"

type Raw = Record<string, unknown>
const text = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null

export type BookingSchedule = {
  kind: string
  reference: string | null
  provider: string | null
  origin: string | null
  destination: string | null
  timezone: string
  departureAt: string | null
  arrivalAt: string | null
  checkInCutoffAt: string | null
  checkInConfirmed: boolean
  priceAmount: number | null
  currency: string | null
  simulated: boolean
  confirmed: boolean
  sourceLabel: string
  at: string | null
}

export function bookingSchedule(booking: EffectiveBooking, reservations: Raw[]): BookingSchedule {
  const selected = booking.selection
  const recorded = booking.source.kind === "travel_reservations"
    ? reservations.find((row) => row.id === booking.source.id) : null
  return {
    kind: selected?.kind ?? booking.kind.toLowerCase(),
    reference: booking.reference,
    provider: booking.provider,
    origin: selected?.from ?? text(recorded?.origin_terminal) ?? text(recorded?.from_city),
    destination: selected?.to ?? text(recorded?.destination_terminal) ?? text(recorded?.to_city),
    timezone: "UTC",
    departureAt: selected?.departure_at ?? text(recorded?.departure_at),
    arrivalAt: selected?.arrival_at ?? text(recorded?.expected_arrival_at),
    checkInCutoffAt: selected?.check_in_cutoff_at ?? text(recorded?.check_in_cutoff_at),
    checkInConfirmed: recorded?.check_in_confirmation === "CONFIRMED" || recorded?.check_in_confirmation === "CONFIRMED_BY_GATE_SCAN",
    priceAmount: selected?.price_amount ?? null,
    currency: selected?.currency ?? null,
    simulated: booking.source.kind === "cr_effects",
    confirmed: booking.status === "booked" || booking.status === "booked (simulated)",
    sourceLabel: booking.source.label,
    at: booking.source.at ?? null,
  }
}

export function currentFerrySchedule(effective: EffectiveOrder, reservations: Raw[]): BookingSchedule | null {
  return effective.bookings.map((booking) => bookingSchedule(booking, reservations))
    .filter((booking) => booking.kind === "ferry" && booking.confirmed).at(-1) ?? null
}

/** Original reservations remain visible as history after a confirmed replacement. */
export function historicalFerrySchedules(effective: EffectiveOrder, reservations: Raw[]): BookingSchedule[] {
  const confirmedEffects = effective.effects.filter((effect) => effect.kind === "BOOKING" && effect.state === "RECORDED")
  const selectionOf = (value: Raw): BookingSelection | null => value.booking_selection && typeof value.booking_selection === "object"
    ? value.booking_selection as BookingSelection : null
  const replaced = new Set(confirmedEffects.map((effect) => selectionOf(effect.value)?.replaces_reservation_id).filter(Boolean))
  const originals = reservations.filter((row) => row.kind === "FERRY" && replaced.has(String(row.id))).map((row) => bookingSchedule({
    kind: "ferry", reference: text(row.booking_reference), provider: text(row.provider), status: "historical", basis: "Original reservation, replaced",
    selection: null, replacesReservationId: null,
    source: { kind: "travel_reservations", id: String(row.id), label: "Original ferry reservation (historical)", at: text(row.booked_at) },
  }, reservations))
  const earlier = confirmedEffects.filter((effect) => replaced.has(effect.id) && selectionOf(effect.value)?.kind === "ferry")
    .map((effect) => bookingSchedule({
      kind: "ferry", reference: text(effect.value.reference), provider: text(effect.value.provider), status: "historical", basis: effect.authority.basis,
      selection: selectionOf(effect.value), replacesReservationId: selectionOf(effect.value)?.replaces_reservation_id ?? null,
      source: { kind: "cr_effects", id: effect.id, label: "Earlier Road Desk ferry booking (historical)", at: effect.at.toISOString() },
    }, reservations))
  return [...originals, ...earlier]
}
