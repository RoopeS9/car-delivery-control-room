// One view of an order's current state (PLAN.md 4.1): the dataset records with
// our executed effects layered on top, each value carrying where it came from
// and its history. The agent, case page, queue, board and map read an order
// through here. The dataset is never edited.
//
// The rule that matters most: an operator's approval is not the customer's
// agreement. A proposed promise change stays pending until the customer's
// answer is recorded with its evidence; only CUSTOMER_AGREED moves the promise.

import { and, desc, eq, gt, inArray } from "drizzle-orm"
import { relatedRecords } from "@/lib/schema"
import { crDb } from "./db"
import { listEffects, type EffectRow } from "./queries"
import { crEvents, crTelemetry } from "./schema"
import type { Assumption, AssumptionCheck, BookingSelection, ObdData, SourceRef } from "./types"

type Raw = Record<string, unknown>
const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null)

export type EffectivePromise = {
  start_utc: string
  end_utc: string
  zone: string | null
  /** In words: "set by the customer", "agreed by the customer on a call logged by the shift lead". */
  basis: string
  source: SourceRef
  /** Proposed changes still waiting for the customer's answer. They do not change the promise. */
  pending: { effect_id: string; text: string; start_utc: string | null; end_utc: string | null; proposed_at: string; basis: string }[]
  history: { at: string; text: string; state: string; basis: string }[]
}

export type EffectiveEta = { text: string; estimate_utc: string | null; basis: string; source: SourceRef; is_estimate: true }

export type EffectiveBooking = {
  kind: string; reference: string | null; provider: string | null; status: string; basis: string; source: SourceRef
  /** Approved quote, unchanged through booking and reconciliation. Null for original dataset records. */
  selection: BookingSelection | null
  replacesReservationId: string | null
}

export type EffectiveOrder = {
  orderId: string
  promise: EffectivePromise | null
  eta: EffectiveEta | null
  bookings: EffectiveBooking[]
  /** Everything else we executed, newest last, each with who authorised it. */
  effects: EffectRow[]
}

const SOURCE_WORDS: Record<string, string> = {
  CUSTOMER: "set by the customer", OPS: "selected by operations", SYSTEM: "system estimate, not agreed", SITE: "from the site",
}

function effectRef(effect: EffectRow, label: string): SourceRef {
  return { kind: "cr_effects", id: effect.id, label, at: effect.at.toISOString() }
}

export async function effectiveOrder(orderId: string): Promise<EffectiveOrder> {
  const [related, effects] = await Promise.all([
    crDb().select().from(relatedRecords)
      .where(and(eq(relatedRecords.orderId, orderId), inArray(relatedRecords.collection, ["time_windows", "travel_reservations", "tracking_observations"]))),
    listEffects({ orderId }),
  ])
  return buildEffectiveOrder(orderId, related, effects)
}

/** Pure projection shared by single-order and batched fleet reads. Original rows are never changed. */
export function buildEffectiveOrder(orderId: string, related: { collection: string; details: Raw }[], effects: EffectRow[]): EffectiveOrder {
  const rows = (collection: string) => related.filter((row) => row.collection === collection).map((row) => row.details)

  // Promise: the dataset's selected window, unless the customer agreed to a change.
  const window = rows("time_windows").find((row) => row.purpose === "CUSTOMER_DELIVERY_PROMISE" && row.is_selected === true)
  const promiseEffects = effects.filter((effect) => effect.kind === "PROMISE_CHANGE")
  const answered = new Set(promiseEffects.map((effect) => effect.supersedesId).filter(Boolean))
  const agreed = promiseEffects.filter((effect) => effect.state === "CUSTOMER_AGREED").at(-1)
  let promise: EffectivePromise | null = null
  if (window || agreed) {
    const base = {
      start_utc: str(window?.start_at) ?? "", end_utc: str(window?.end_at) ?? "", zone: str(window?.timezone),
      basis: window ? SOURCE_WORDS[String(window.source)] ?? "source not recorded" : "not recorded",
      source: { kind: "time_windows", id: String(window?.id ?? ""), label: `Delivery promise, ${window ? SOURCE_WORDS[String(window.source)] ?? "source not recorded" : "not recorded"}` } as SourceRef,
    }
    if (agreed) {
      base.start_utc = str(agreed.value.start_utc) ?? base.start_utc
      base.end_utc = str(agreed.value.end_utc) ?? base.end_utc
      base.basis = agreed.authority.basis
      base.source = effectRef(agreed, "Promise change agreed by the customer")
    }
    promise = {
      ...base,
      pending: promiseEffects.filter((effect) => effect.state === "PROPOSED_TO_CUSTOMER" && !answered.has(effect.id)).map((effect) => ({
        effect_id: effect.id, text: String(effect.value.text ?? ""), start_utc: str(effect.value.start_utc), end_utc: str(effect.value.end_utc),
        proposed_at: effect.at.toISOString(), basis: effect.authority.basis,
      })),
      history: promiseEffects.map((effect) => ({ at: effect.at.toISOString(), text: String(effect.value.text ?? ""), state: effect.state, basis: effect.authority.basis })),
    }
  }

  // ETA: our latest internal estimate, else the driver app's estimate. Always an estimate.
  const etaEffect = effects.filter((effect) => effect.kind === "ETA_ESTIMATE").at(-1)
  const lastTrack = rows("tracking_observations").sort((a, b) => String(a.observed_at).localeCompare(String(b.observed_at))).at(-1)
  const eta: EffectiveEta | null = etaEffect
    ? { text: String(etaEffect.value.text ?? ""), estimate_utc: str(etaEffect.value.estimate_utc), basis: etaEffect.authority.basis, source: effectRef(etaEffect, "Road Desk ETA estimate"), is_estimate: true }
    : lastTrack && str(lastTrack.estimated_delivery_at)
      ? { text: `Driver app estimate ${lastTrack.estimated_delivery_at}`, estimate_utc: str(lastTrack.estimated_delivery_at), basis: "driver app, coarse", source: { kind: "tracking_observations", id: String(lastTrack.id), label: "Driver app progress", at: str(lastTrack.observed_at) }, is_estimate: true }
      : null

  // Reconciliation replaces an uncertain booking with its confirmed record,
  // or records that nothing was booked. Preserve both events in effects,
  // while exposing only the current result in bookings.
  const supersededBookings = new Set(effects.filter((effect) => effect.kind === "BOOKING").map((effect) => effect.supersedesId).filter(Boolean))
  const bookingOutcomes = new Map<string, boolean>()
  for (const effect of effects) {
    if (effect.kind === "OUTCOME_LOGGED" && effect.proposalId && typeof effect.value.booking_exists === "boolean") {
      bookingOutcomes.set(effect.proposalId, effect.value.booking_exists)
    }
  }

  const currentBookingEffects = effects.filter((effect) => effect.kind === "BOOKING" && !supersededBookings.has(effect.id)
    && !(effect.proposalId && bookingOutcomes.get(effect.proposalId) === false))
  const selectionOf = (effect: EffectRow): BookingSelection | null =>
    effect.value.booking_selection && typeof effect.value.booking_selection === "object" ? effect.value.booking_selection as BookingSelection : null
  // An attempted replacement does not cancel an existing reservation. Only a
  // confirmed booking (including a reconciled confirmation) replaces it here.
  const replacedReservations = new Set(currentBookingEffects.filter((effect) => effect.state === "RECORDED")
    .map((effect) => selectionOf(effect)?.replaces_reservation_id).filter(Boolean))

  // Bookings: the dataset's reservations plus our current (simulated) bookings. A quote is never here.
  const bookings: EffectiveBooking[] = [
    ...rows("travel_reservations").filter((row) => !replacedReservations.has(String(row.id))).map((row) => ({
      kind: String(row.kind ?? "TRAVEL").toLowerCase(), reference: str(row.booking_reference), provider: str(row.provider),
      status: String(row.status ?? "unknown").toLowerCase(), basis: "booking record",
      source: { kind: "travel_reservations", id: String(row.id), label: `Booking ${str(row.booking_reference) ?? ""}`.trim(), at: str(row.booked_at) } as SourceRef,
      selection: null, replacesReservationId: null,
    })),
    ...currentBookingEffects.filter((effect) => !replacedReservations.has(effect.id)).map((effect) => ({
      kind: String(effect.value.kind ?? "booking"), reference: str(effect.value.reference), provider: str(effect.value.provider),
      status: effect.state === "UNCONFIRMED" ? "not confirmed by the provider" : "booked (simulated)", basis: effect.authority.basis,
      source: effectRef(effect, `Road Desk booking ${str(effect.value.reference) ?? ""}`.trim()),
      selection: selectionOf(effect), replacesReservationId: selectionOf(effect)?.replaces_reservation_id ?? null,
    })),
  ]

  return { orderId, promise, eta, bookings, effects }
}

// ---------------------------------------------------------------- assumptions

const MAIN_TABLES = new Set(["orders", "alerts", "messages", "conversations", "operational_events"])

async function recordField(table: string, id: string, field: string): Promise<unknown> {
  if (MAIN_TABLES.has(table)) {
    const { orders, alerts, messages, conversations, operationalEvents } = await import("@/lib/schema")
    const source = { orders, alerts, messages, conversations, operational_events: operationalEvents }[table as "orders"]
    const [row] = await crDb().select({ details: source.details }).from(source).where(eq(source.id, id)).limit(1)
    return row ? (row.details as Raw)[field] : undefined
  }
  const [row] = await crDb().select({ details: relatedRecords.details }).from(relatedRecords)
    .where(and(eq(relatedRecords.collection, table), eq(relatedRecords.id, id))).limit(1)
  return row ? row.details[field] : undefined
}

/** Check each assumption against the current effective state. */
/** A record value as the card shows it: "MISSED_CHECK_IN" reads "missed check in". */
function inWords(value: unknown): string {
  if (value === null || value === "") return "empty"
  const text = String(value)
  return /^[A-Z][A-Z0-9_]*$/.test(text) ? text.toLowerCase().replace(/_/g, " ") : text
}

export async function checkAssumptions(caseId: string, orderId: string, assumptions: Assumption[]): Promise<AssumptionCheck[]> {
  const checks: AssumptionCheck[] = []
  for (const assumption of assumptions) {
    if (assumption.kind === "record") {
      const actual = await recordField(assumption.table, assumption.id, assumption.field)
      // A field the record does not carry (the agent named a label it saw, not a column) cannot have changed: the
      // check is skipped and says so. Only a value that is there and differs outdates the card.
      if (actual === undefined) { checks.push({ assumption, holds: true, now: "not checkable: no such field on the record" }); continue }
      checks.push({ assumption, holds: String(actual ?? null) === String(assumption.expected ?? null), now: inWords(actual) })
    } else if (assumption.kind === "no_new_message") {
      const after = new Date(assumption.after)
      const [latest] = Number.isNaN(after.getTime()) ? [] : await crDb().select().from(crEvents)
        .where(and(eq(crEvents.caseId, caseId), eq(crEvents.actorType, assumption.from), gt(crEvents.at, after)))
        .orderBy(desc(crEvents.at)).limit(1)
      checks.push({ assumption, holds: !latest, now: latest ? `new ${assumption.from} message at ${latest.at.toISOString().slice(11, 16)} UTC: "${latest.body.slice(0, 120)}"` : "nothing new" })
    } else {
      const [latest] = await crDb().select().from(crTelemetry)
        .where(and(eq(crTelemetry.orderId, orderId), eq(crTelemetry.source, "OBD"))).orderBy(desc(crTelemetry.at)).limit(1)
      // No dongle sample at all (the fault came in by message or by the API) is not "no codes": nothing to compare.
      if (!latest) { checks.push({ assumption, holds: true, now: "not checkable: no dongle data" }); continue }
      const codes = [...((latest.data as ObdData).dtcs ?? [])].sort()
      const expected = [...assumption.codes].map((code) => code.toUpperCase()).sort()
      checks.push({ assumption, holds: codes.join(",") === expected.join(","), now: codes.length ? `car reports ${codes.join(", ")}` : "car reports no trouble codes" })
    }
  }
  return checks
}
