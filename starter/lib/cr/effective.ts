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
import type { Assumption, AssumptionCheck, ObdData, SourceRef } from "./types"

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

export type EffectiveBooking = { kind: string; reference: string | null; provider: string | null; status: string; basis: string; source: SourceRef }

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

  // Bookings: the dataset's reservations plus our (simulated) bookings. A quote is never here.
  const bookings: EffectiveBooking[] = [
    ...rows("travel_reservations").map((row) => ({
      kind: String(row.kind ?? "TRAVEL").toLowerCase(), reference: str(row.booking_reference), provider: str(row.provider),
      status: String(row.status ?? "unknown").toLowerCase(), basis: "booking record",
      source: { kind: "travel_reservations", id: String(row.id), label: `Booking ${str(row.booking_reference) ?? ""}`.trim(), at: str(row.booked_at) } as SourceRef,
    })),
    ...effects.filter((effect) => effect.kind === "BOOKING").map((effect) => ({
      kind: String(effect.value.kind ?? "booking"), reference: str(effect.value.reference), provider: str(effect.value.provider),
      status: effect.state === "UNCONFIRMED" ? "not confirmed by the provider" : "booked (simulated)", basis: effect.authority.basis,
      source: effectRef(effect, `Road Desk booking ${str(effect.value.reference) ?? ""}`.trim()),
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
export async function checkAssumptions(caseId: string, orderId: string, assumptions: Assumption[]): Promise<AssumptionCheck[]> {
  const checks: AssumptionCheck[] = []
  for (const assumption of assumptions) {
    if (assumption.kind === "record") {
      const actual = await recordField(assumption.table, assumption.id, assumption.field)
      const holds = actual !== undefined && String(actual ?? null) === String(assumption.expected ?? null)
      checks.push({ assumption, holds, now: actual === undefined ? "record not found" : String(actual ?? "empty") })
    } else if (assumption.kind === "no_new_message") {
      const after = new Date(assumption.after)
      const [latest] = Number.isNaN(after.getTime()) ? [] : await crDb().select().from(crEvents)
        .where(and(eq(crEvents.caseId, caseId), eq(crEvents.actorType, assumption.from), gt(crEvents.at, after)))
        .orderBy(desc(crEvents.at)).limit(1)
      checks.push({ assumption, holds: !latest, now: latest ? `new ${assumption.from} message at ${latest.at.toISOString().slice(11, 16)} UTC: "${latest.body.slice(0, 120)}"` : "nothing new" })
    } else {
      const [latest] = await crDb().select().from(crTelemetry)
        .where(and(eq(crTelemetry.orderId, orderId), eq(crTelemetry.source, "OBD"))).orderBy(desc(crTelemetry.at)).limit(1)
      const codes = latest ? [...((latest.data as ObdData).dtcs ?? [])].sort() : []
      const expected = [...assumption.codes].map((code) => code.toUpperCase()).sort()
      checks.push({ assumption, holds: codes.join(",") === expected.join(","), now: codes.length ? `car reports ${codes.join(", ")}` : "car reports no trouble codes" })
    }
  }
  return checks
}
