// The derived layer: what the rules say about a dossier as of its time. Deadlines at risk, silent gaps, conflicts
// between facts, and the checks (robo-calls) that are due. Pure: the same dossier always derives the same items.
// Nothing here is evidence; every item cites the dossier items it rests on, and the reasoning model sees these as
// derivations, rendered apart from the facts.
//
// A derived item has an identity (kind + subject) so two builds can be compared: diffDerived tells what opened,
// changed or closed, and that difference is the only thing that wakes the reasoning model.
import { z } from "zod"
import type { Dossier } from "./dossier"
import { items } from "./brief"
import { CallPurpose, Callee } from "./live"
import { IsoDateTime, Text } from "./primitives"

/** The knobs, in one place, so an operator can read them. Hours unless named otherwise. */
export const THRESHOLDS = {
  /** A pickup readiness call is due this long before the selected pickup slot. */
  readinessBeforeSlotH: 48,
  /** The driver's start check is due this long before the slot (the day before). */
  startCheckBeforeSlotH: 30,
  /** A moving car whose phone has been silent this long gets a position check. */
  positionGapMin: 60,
  /** A ferry check-in call is due this long before the check-in cutoff when no gate scan confirms it. */
  ferryBeforeCutoffH: 6,
  /** A delivery promise is at risk when the latest ETA lands this long before its end, or later. */
  promiseMarginMin: 30,
  /** A PARTIAL call is tried again after this long. */
  retryAfterH: 2,
} as const

export const DerivedItem = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("DUE_CHECK"), id: Text, subject: Text, purpose: CallPurpose, callee: Callee,
    dueAt: IsoDateTime, state: z.enum(["DUE", "OVERDUE", "RETRY", "DONE", "BLOCKED"]), why: Text, basis: z.array(Text),
  }).strict(),
  z.object({ kind: z.literal("DEADLINE_AT_RISK"), id: Text, subject: Text, deadlineAt: IsoDateTime, expectedAt: IsoDateTime.nullable(), line: Text, basis: z.array(Text) }).strict(),
  z.object({ kind: z.literal("SILENT_GAP"), id: Text, subject: Text, since: IsoDateTime, minutes: z.number().int(), line: Text, basis: z.array(Text) }).strict(),
  z.object({ kind: z.literal("CONFLICT"), id: Text, subject: Text, line: Text, said: Text, record: Text, basis: z.array(Text) }).strict(),
])
export type DerivedItem = z.infer<typeof DerivedItem>

export const DerivedDiff = z.object({
  opened: z.array(DerivedItem), changed: z.array(z.object({ before: DerivedItem, after: DerivedItem }).strict()), closed: z.array(DerivedItem),
}).strict()
export type DerivedDiff = z.infer<typeof DerivedDiff>

const H = 3600e3, MIN = 60e3
const ref = (collection: string, id: string) => `${collection}:${id}`

/** Everything the rules read from a dossier, found once. */
function facts(d: Dossier) {
  const order = items(d, "orders")[0]!
  const t = Date.parse(d.asOf)
  const slot = items(d, "time_windows").find((i) => i.record.purpose === "SELECTED_PICKUP_SLOT" && i.record.is_selected) ?? null
  const promise = items(d, "time_windows").find((i) => i.record.purpose === "CUSTOMER_DELIVERY_PROMISE" && i.record.is_selected) ?? null
  const assignment = items(d, "work_assignments").find((i) => i.record.status === "IN_PROGRESS" || i.record.status === "ASSIGNED") ?? null
  const driver = assignment ? items(d, "drivers").find((i) => i.record.id === assignment.record.driver_id) ?? null : null
  const site = items(d, "sites").find((i) => i.record.id === order.record.pickup_site_id) ?? null
  const detail = items(d, "order_endpoint_details").find((i) => i.record.boundary === "PICKUP") ?? null
  const ferry = items(d, "travel_reservations").find((i) => i.record.kind === "FERRY" && i.record.status === "BOOKED") ?? null
  const gateScan = ferry ? items(d, "ferry_terminal_events").find((i) => i.record.reservation_id === ferry.record.id && i.record.kind === "CHECK_IN_ACCEPTED") ?? null : null
  const tracking = items(d, "tracking_observations").sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))[0] ?? null
  const gps = d.live.telemetry.filter((s) => s.kind === "GPS").sort((a, b) => b.at.localeCompare(a.at))[0] ?? null
  const calls = (purpose: CallPurpose) => d.live.calls.filter((c) => c.brief.purpose === purpose).sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  return { order, t, slot, promise, assignment, driver, site, detail, ferry, gateScan, tracking, gps, calls, phase: d.phase.phase }
}

/** A check's state from its calls: done, retry pending, or still due. */
function checkState(d: Dossier, purpose: CallPurpose, dueAt: number): { state: "DUE" | "OVERDUE" | "RETRY" | "DONE"; basis: string[] } {
  const f = facts(d)
  const last = f.calls(purpose)[0]
  if (last?.outcome === "COMPLETED") return { state: "DONE", basis: [`call:${last.id}`] }
  if (last?.outcome === "PARTIAL" && last.retryAfter && Date.parse(last.retryAfter) > f.t) return { state: "RETRY", basis: [`call:${last.id}`] }
  if (last && Date.parse(last.startedAt) + THRESHOLDS.retryAfterH * H > f.t) return { state: "RETRY", basis: [`call:${last.id}`] }
  return { state: f.t > dueAt + 4 * H ? "OVERDUE" : "DUE", basis: last ? [`call:${last.id}`] : [] }
}

export function derive(d: Dossier): DerivedItem[] {
  const f = facts(d)
  const out: DerivedItem[] = []
  const iso = (ms: number) => new Date(ms).toISOString()

  // ---- DUE_CHECK: pickup readiness, before the slot, to a desk that is not the paying customer
  if (f.slot && (f.phase === "READINESS" || f.phase === "MARKET" || f.phase === "BOOKED" || f.phase === "PICKUP_DUE")) {
    const slotAt = Date.parse(f.slot.record.start_at), dueAt = slotAt - THRESHOLDS.readinessBeforeSlotH * H
    if (f.t >= dueAt && f.t < slotAt + 2 * H) {
      const blocked = f.site && f.site.record.customer_id === f.order.record.customer_id ? "the pickup site belongs to the paying customer: a person calls" : !f.detail ? "no pickup endpoint detail to call about" : null
      const callee: Callee = { kind: "PICKUP_SITE_DESK", siteId: f.site?.record.id ?? null, endpointDetailId: f.detail?.record.id ?? "detail-none", name: f.site?.record.name ?? f.detail?.record.contact_name ?? "pickup desk" }
      const s = blocked ? { state: "BLOCKED" as const, basis: [] as string[] } : checkState(d, "PICKUP_READINESS", dueAt)
      out.push({ kind: "DUE_CHECK", id: `due:PICKUP_READINESS:${f.slot.record.id}`, subject: f.slot.record.id, purpose: "PICKUP_READINESS", callee, dueAt: iso(dueAt), state: s.state,
        why: blocked ?? `pickup slot starts ${f.slot.record.start_at}; confirm the car, keys, releaser, papers and access`, basis: [ref("time_windows", f.slot.record.id), ...(f.site ? [ref("sites", f.site.record.id)] : []), ...(f.detail ? [ref("order_endpoint_details", f.detail.record.id)] : []), ...s.basis] })
    }
  }
  // ---- DUE_CHECK: the driver's start check the day before the slot
  if (f.slot && f.driver && f.assignment && (f.phase === "BOOKED" || f.phase === "PICKUP_DUE")) {
    const slotAt = Date.parse(f.slot.record.start_at), dueAt = slotAt - THRESHOLDS.startCheckBeforeSlotH * H
    if (f.t >= dueAt && f.t < slotAt) {
      const s = checkState(d, "DRIVER_START_CHECK", dueAt)
      out.push({ kind: "DUE_CHECK", id: `due:DRIVER_START_CHECK:${f.assignment.record.id}`, subject: f.assignment.record.id, purpose: "DRIVER_START_CHECK", callee: { kind: "DRIVER", driverId: f.driver.record.id, name: f.driver.record.display_name },
        dueAt: iso(dueAt), state: s.state, why: `collection ${f.slot.record.start_at}: travel booked, start point, rest, ETA`, basis: [ref("work_assignments", f.assignment.record.id), ref("time_windows", f.slot.record.id), ...s.basis] })
    }
  }
  // ---- SILENT_GAP and DUE_CHECK: a moving car whose phone has gone quiet
  if ((f.phase === "MOVING" || f.phase === "DELIVERY_DUE") && f.driver && f.assignment) {
    const lastAt = f.gps ? Date.parse(f.gps.at) : f.tracking?.at ? Date.parse(f.tracking.at) : null
    const quietFrom = d.live.phone?.state === "QUIET" && d.live.phone.quietFrom ? Date.parse(d.live.phone.quietFrom) : null
    const since = quietFrom ?? lastAt
    if (since != null && f.t - since >= THRESHOLDS.positionGapMin * MIN) {
      const minutes = Math.round((f.t - since) / MIN)
      const basis = [...(f.gps ? [`telemetry:${f.gps.id}`] : []), ...(f.tracking ? [ref("tracking_observations", f.tracking.record.id)] : []), ...(d.live.phone ? ["phone:app"] : [])]
      out.push({ kind: "SILENT_GAP", id: `gap:position:${f.assignment.record.id}`, subject: f.assignment.record.id, since: iso(since), minutes, line: `No position from the driver's phone for ${minutes} minutes on a moving car`, basis })
      const s = checkState(d, "POSITION_CHECK", since + THRESHOLDS.positionGapMin * MIN)
      out.push({ kind: "DUE_CHECK", id: `due:POSITION_CHECK:${f.assignment.record.id}:${iso(since).slice(0, 13)}`, subject: `${f.assignment.record.id}@${iso(since).slice(0, 13)}`, purpose: "POSITION_CHECK", callee: { kind: "DRIVER", driverId: f.driver.record.id, name: f.driver.record.display_name },
        dueAt: iso(since + THRESHOLDS.positionGapMin * MIN), state: s.state, why: `no phone position for ${minutes} minutes: where is the car, what is the ETA, is anything wrong`, basis: [...basis, ...s.basis] })
    }
  }
  // ---- DUE_CHECK: ferry check-in, before the cutoff, unless a gate scan confirms it
  if (f.ferry?.record.check_in_cutoff_at && f.driver && (f.phase === "MOVING" || f.phase === "DELIVERY_DUE")) {
    const cutoff = Date.parse(f.ferry.record.check_in_cutoff_at), dueAt = cutoff - THRESHOLDS.ferryBeforeCutoffH * H
    if (f.gateScan) {
      // confirmed: nothing due
    } else if (f.t >= dueAt && f.t < cutoff + H) {
      const s = checkState(d, "FERRY_CHECKIN", dueAt)
      out.push({ kind: "DUE_CHECK", id: `due:FERRY_CHECKIN:${f.ferry.record.id}`, subject: f.ferry.record.id, purpose: "FERRY_CHECKIN", callee: { kind: "DRIVER", driverId: f.driver.record.id, name: f.driver.record.display_name },
        dueAt: iso(dueAt), state: s.state, why: `ferry check-in closes ${f.ferry.record.check_in_cutoff_at}; no gate scan confirms check-in`, basis: [ref("travel_reservations", f.ferry.record.id), ...s.basis] })
    }
    // the cutoff itself is a deadline when the latest ETA or a late position threatens it
    const etaAt = f.tracking ? Date.parse(f.tracking.record.estimated_delivery_at) : null
    if (!f.gateScan && f.t < cutoff && f.gps && cutoff - f.t < 2 * H) {
      out.push({ kind: "DEADLINE_AT_RISK", id: `deadline:ferry:${f.ferry.record.id}`, subject: f.ferry.record.id, deadlineAt: iso(cutoff), expectedAt: etaAt ? iso(etaAt) : null,
        line: `Ferry check-in closes in ${Math.round((cutoff - f.t) / MIN)} minutes and nothing confirms the car is at the gate`, basis: [ref("travel_reservations", f.ferry.record.id), `telemetry:${f.gps.id}`] })
    }
  }
  // ---- DEADLINE_AT_RISK: the delivery promise against the latest ETA
  if (f.promise && f.tracking && (f.phase === "MOVING" || f.phase === "DELIVERY_DUE")) {
    const end = Date.parse(f.promise.record.end_at), eta = Date.parse(f.tracking.record.estimated_delivery_at)
    if (eta > end - THRESHOLDS.promiseMarginMin * MIN) {
      out.push({ kind: "DEADLINE_AT_RISK", id: `deadline:promise:${f.promise.record.id}`, subject: f.promise.record.id, deadlineAt: f.promise.record.end_at, expectedAt: f.tracking.record.estimated_delivery_at,
        line: eta > end ? `The latest ETA is after the end of the delivery promise` : `The latest ETA leaves under ${THRESHOLDS.promiseMarginMin} minutes before the promise ends`, basis: [ref("time_windows", f.promise.record.id), ref("tracking_observations", f.tracking.record.id)] })
    }
  }
  // ---- DEADLINE_AT_RISK: a driver's own ETA after the pickup slot (from a start check)
  if (f.slot) {
    for (const c of f.calls("DRIVER_START_CHECK")) {
      const eta = c.slots.find((s) => s.value.slot === "ETA")
      if (eta && typeof eta.value.value === "string" && Date.parse(eta.value.value) > Date.parse(f.slot.record.start_at)) {
        out.push({ kind: "DEADLINE_AT_RISK", id: `deadline:slot:${f.slot.record.id}`, subject: f.slot.record.id, deadlineAt: f.slot.record.start_at, expectedAt: eta.value.value,
          line: `The driver said they reach the pickup after the slot starts`, basis: [ref("time_windows", f.slot.record.id), `call:${c.id}`] }); break
      }
    }
  }
  // ---- CONFLICT: what a call established against what the records say
  for (const c of f.calls("PICKUP_READINESS")) {
    for (const s of c.slots) {
      if (s.value.slot === "VEHICLE_PRESENT" && s.value.value === false) out.push({ kind: "CONFLICT", id: `conflict:vehicle:${c.id}`, subject: "vehicle at pickup", line: "The pickup desk could not confirm the car is on site, which the order assumes", said: s.quote, record: `order ${f.order.record.reference} lists the pickup at ${f.site?.record.name ?? "this site"}`, basis: [`call:${c.id}`, ref("orders", f.order.record.id)] })
      if (s.value.slot === "KEYS_AT_SITE" && s.value.value === false && f.site?.record.requires_signed_release) out.push({ kind: "CONFLICT", id: `conflict:keys:${c.id}`, subject: "keys at pickup", line: "The desk says the keys are not there; the site profile expects a desk release", said: s.quote, record: f.site.record.release_document_rule, basis: [`call:${c.id}`, ref("sites", f.site.record.id)] })
      if (s.value.slot === "RELEASE_CONTACT_NAME" && f.detail?.record.contact_name && typeof s.value.value === "string" && !s.value.value.toLowerCase().includes(f.detail.record.contact_name.split(" ")[0]!.toLowerCase())) out.push({ kind: "CONFLICT", id: `conflict:releaser:${c.id}`, subject: "who releases the car", line: `The desk named a different releaser from our record (${f.detail.record.contact_name})`, said: s.quote, record: `contact ${f.detail.record.contact_name}, ${f.detail.record.contact_role}`, basis: [`call:${c.id}`, ref("order_endpoint_details", f.detail.record.id)] })
    }
    break
  }
  for (const c of f.calls("DRIVER_START_CHECK")) {
    const travel = c.slots.find((s) => s.value.slot === "DRIVER_TRAVEL_BOOKED")
    const booked = items(d, "travel_reservations").filter((i) => i.record.status === "BOOKED" && i.record.kind !== "FERRY")
    if (travel?.value.value === false && booked.length) out.push({ kind: "CONFLICT", id: `conflict:travel:${c.id}`, subject: "driver travel", line: "The driver says no travel is booked; our records hold a booking", said: travel.quote, record: booked.map((b) => b.record.route_label).join("; "), basis: [`call:${c.id}`, ...booked.map((b) => ref("travel_reservations", b.record.id))] })
    break
  }
  return out.map((i) => DerivedItem.parse(i))
}

/** What changed between two derivations, by item id. A DUE_CHECK whose state moved counts as changed. */
export function diffDerived(before: DerivedItem[], after: DerivedItem[]): DerivedDiff {
  const b = new Map(before.map((i) => [i.id, i])), a = new Map(after.map((i) => [i.id, i]))
  const opened = after.filter((i) => !b.has(i.id))
  const closed = before.filter((i) => !a.has(i.id))
  const changed = after.filter((i) => b.has(i.id) && JSON.stringify(b.get(i.id)) !== JSON.stringify(i)).map((i) => ({ before: b.get(i.id)!, after: i }))
  return { opened, changed, closed }
}

/** The derived items as the reasoning model reads them: apart from the facts, each line naming what it rests on. */
export function renderDerived(derived: DerivedItem[]): string {
  if (!derived.length) return "## DERIVED (what the rules say)\n- nothing is due, at risk, silent or in conflict\n"
  const out = ["## DERIVED (what the rules say, as of the dossier's time; derivations, not evidence)"]
  for (const i of derived) {
    if (i.kind === "DUE_CHECK") out.push(`- [DUE_CHECK ${i.state}] ${i.purpose} to ${i.callee.name} (${i.callee.kind}), due ${i.dueAt}: ${i.why}. basis: ${i.basis.join(", ")}`)
    else if (i.kind === "DEADLINE_AT_RISK") out.push(`- [DEADLINE_AT_RISK] ${i.line}; deadline ${i.deadlineAt}${i.expectedAt ? `, expected ${i.expectedAt}` : ""}. basis: ${i.basis.join(", ")}`)
    else if (i.kind === "SILENT_GAP") out.push(`- [SILENT_GAP] ${i.line}, since ${i.since}. basis: ${i.basis.join(", ")}`)
    else out.push(`- [CONFLICT] ${i.line}. They said: "${i.said}". Our record: ${i.record}. basis: ${i.basis.join(", ")}`)
  }
  return out.join("\n") + "\n"
}
