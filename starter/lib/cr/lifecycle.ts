// The delivery's own steps as the driver reports them in the app: at the pickup, collected, checked in at the
// ferry terminal, at the delivery address, handed over. Each is a `milestone` event in our own table; the dataset is
// never changed. Readers overlay them on the snapshot (the order's status, the driver's assignment and the
// dataset-shaped operational events every projection already understands), and a demo reset removes them.

import { and, asc, eq, inArray } from "drizzle-orm"
import { crDb } from "./db"
import { crEvents } from "./schema"
import type { EventRow } from "./queries"

export const MILESTONES = ["ARRIVED_PICKUP", "COLLECTED", "CHECKED_IN", "ARRIVED_DELIVERY", "DELIVERED"] as const
export type Milestone = (typeof MILESTONES)[number]

/** What each step is called where people read it. */
export const MILESTONE_WORDS: Record<Milestone, string> = {
  ARRIVED_PICKUP: "Arrived at the pickup",
  COLLECTED: "Car and keys collected",
  CHECKED_IN: "Checked in for the ferry",
  ARRIVED_DELIVERY: "Arrived at the delivery address",
  DELIVERED: "Handed over",
}

export type MilestoneData = {
  milestone: Milestone
  assignment_id: string
  /** Keys counted at collection or handover. */
  keys?: number | null
  /** Who took the car at the delivery end, as the driver typed it. */
  receiver_name?: string | null
  photo_ids?: string[]
  note?: string | null
  simulated: true
}

export type Lifecycle = Partial<Record<Milestone, { at: string; driverId: string; data: MilestoneData; eventId: string }>>

export async function milestoneEvents(orderIds?: string[]): Promise<EventRow[]> {
  if (orderIds && !orderIds.length) return []
  return crDb().select().from(crEvents)
    .where(and(eq(crEvents.kind, "milestone"), orderIds ? inArray(crEvents.orderId, orderIds) : undefined))
    .orderBy(asc(crEvents.at))
}

export function lifecycleByOrder(rows: EventRow[]): Map<string, Lifecycle> {
  const map = new Map<string, Lifecycle>()
  for (const row of rows) {
    const data = row.data as unknown as MilestoneData
    if (!data?.milestone) continue
    const entry = map.get(row.orderId) ?? {}
    // The first report of a step counts; a repeated tap changes nothing.
    if (!entry[data.milestone]) entry[data.milestone] = { at: row.at.toISOString(), driverId: row.actorId ?? "", data, eventId: row.id }
    map.set(row.orderId, entry)
  }
  return map
}

export async function lifecycleOf(orderId: string): Promise<Lifecycle> {
  return lifecycleByOrder(await milestoneEvents([orderId])).get(orderId) ?? {}
}

/** The next step the driver can report, in order; a ferry step only when the trip has a ferry. */
export function nextMilestone(lifecycle: Lifecycle, hasFerry: boolean): Milestone | null {
  const order: Milestone[] = hasFerry ? [...MILESTONES] : MILESTONES.filter((step) => step !== "CHECKED_IN")
  // The step after the last one reported: an arrival the driver went straight past stays skipped.
  const last = Math.max(-1, ...order.map((step, index) => (lifecycle[step] ? index : -1)))
  return order[last + 1] ?? null
}

/** The order status once the driver's reports are laid over the snapshot. */
export function overlayStatus(status: string, lifecycle: Lifecycle | undefined): string {
  if (!lifecycle) return status
  if (lifecycle.DELIVERED) return "DELIVERED"
  if (lifecycle.COLLECTED && (status === "WAITING_FOR_PICKUP" || status === "NEW")) return "IN_TRANSIT"
  return status
}

/** The board lane that goes with an overlaid status. */
export function overlayLane(lane: string, status: string, lifecycle: Lifecycle | undefined): string {
  const overlaid = overlayStatus(status, lifecycle)
  if (overlaid === status) return lane
  return overlaid === "DELIVERED" ? "delivered" : overlaid === "IN_TRANSIT" ? "moving" : lane
}

/** A work assignment as the driver's reports leave it: started at collection, completed at handover. */
export function overlayAssignment<T extends Record<string, unknown>>(row: T, lifecycle: Lifecycle | undefined): T {
  if (!lifecycle) return row
  const collected = lifecycle.COLLECTED
  const delivered = lifecycle.DELIVERED
  if (!collected || (collected.data.assignment_id && collected.data.assignment_id !== row.id)) return row
  if (row.status === "CANCELLED") return row
  return {
    ...row,
    status: delivered ? "COMPLETED" : "IN_PROGRESS",
    started_at: row.started_at ?? collected.at,
    completed_at: delivered ? delivered.at : row.completed_at ?? null,
  }
}

/**
 * The booked ferry once the driver reported checking in at the terminal. In this prototype that report stands in
 * for the terminal's gate scan, and says so: `check_in_source` names the simulated scan.
 */
export function overlayReservation<T extends Record<string, unknown>>(row: T, lifecycle: Lifecycle | undefined): T {
  const checkedIn = lifecycle?.CHECKED_IN
  if (!checkedIn || row.kind !== "FERRY" || row.status !== "BOOKED" || row.check_in_confirmation === "CONFIRMED_BY_GATE_SCAN") return row
  if (row.assignment_id && row.assignment_id !== checkedIn.data.assignment_id) return row
  return { ...row, check_in_confirmation: "CONFIRMED_BY_GATE_SCAN", check_in_confirmed_at: checkedIn.at, check_in_source: "terminal gate scan (simulated, reported in the driver app)" }
}

/**
 * A dataset assignment step as the driver's reports leave it: the pickup step completed at the collection, the
 * delivery step at the handover, with the synthetic operational event as its evidence (as the dataset links its own).
 */
export function overlayStep<T extends Record<string, unknown>>(row: T, lifecycle: Lifecycle | undefined): T {
  if (!lifecycle || row.status === "COMPLETED" || row.status === "CANCELLED") return row
  const pickup = row.kind === "VEHICLE_PICKUP"
  const report = pickup ? lifecycle.COLLECTED : row.kind === "VEHICLE_DELIVERY" ? lifecycle.DELIVERED : undefined
  if (!report || (row.assignment_id && row.assignment_id !== report.data.assignment_id)) return row
  return {
    ...row, status: "COMPLETED", completed_at: report.at, evidence_id: `${report.eventId}-${pickup ? "pickup" : "delivery"}`, evidence_type: "operational_event",
    note: `${pickup ? "Collection" : "Handover"} reported in the driver app (simulated).`,
  }
}

/** The proof kind photos taken at a step become, in the dataset's words. */
const PROOF_KIND: Partial<Record<Milestone, string>> = { COLLECTED: "PICKUP_PHOTOS", DELIVERED: "DELIVERY_PHOTOS" }

type ProofRecord = { id: string; details: Record<string, unknown> }

/**
 * Photos taken at the collection or the handover, as the dataset's own proofs: a proof of that kind still required
 * at that point is submitted by them; otherwise a new submitted proof is added. Review stays with a person.
 */
export function overlayProofs<T extends ProofRecord>(rows: T[], lifecycle: Lifecycle | undefined, points: PointRow[], make: (id: string, details: Record<string, unknown>) => T): T[] {
  if (!lifecycle) return rows
  let out = rows
  for (const step of ["COLLECTED", "DELIVERED"] as const) {
    const report = lifecycle[step]
    const files = report?.data.photo_ids?.length ?? 0
    if (!report || !files) continue
    const kind = PROOF_KIND[step]!
    const point = points.find((row) => row.role === (step === "COLLECTED" ? "PICKUP" : "DELIVERY") || row.order_boundary === (step === "COLLECTED" ? "PICKUP" : "DELIVERY"))
    const submitted = { status: "SUBMITTED", file_count: files, submitted_at: report.at, source: "driver_app", simulated: true, road_desk: true }
    const open = out.find((row) => row.details.kind === kind && row.details.status === "REQUIRED" && (!point || row.details.point_id === point.id))
    out = open
      ? out.map((row) => (row === open ? { ...row, details: { ...row.details, ...submitted } } : row))
      : [...out, make(`${report.eventId}-proof`, { id: `${report.eventId}-proof`, kind, point_id: point?.id ?? null, required: false, reviewed_at: null, ...submitted })]
  }
  return out
}

type PointRow = Record<string, unknown>

/**
 * The driver's reports in the dataset's own event shape, so the timeline, the milestones, the journey and the board
 * read them like any recorded event. `source` says they came from this prototype's driver app, simulated.
 */
export function syntheticEvents(orderId: string, lifecycle: Lifecycle, points: PointRow[], segmentId: string | null, fromStatus: string): Record<string, unknown>[] {
  const pickupPoint = points.find((row) => row.role === "PICKUP" || row.order_boundary === "PICKUP")
  const deliveryPoint = points.find((row) => row.role === "DELIVERY" || row.order_boundary === "DELIVERY")
  const rows: Record<string, unknown>[] = []
  const add = (id: string, at: string, command: string, targetType: string, targetId: string, driverId: string, extra: Record<string, unknown> = {}) => rows.push({
    id, order_id: orderId, command, target_type: targetType, target_id: targetId, recorded_at: at, actor_type: "driver", actor_id: driverId,
    source: "driver_app", from_state: null, to_state: null, changes: {}, road_desk: true, simulated: true, ...extra,
  })
  const collected = lifecycle.COLLECTED
  if (collected) {
    const { assignment_id: assignmentId } = collected.data
    add(`${collected.eventId}-start`, collected.at, "assignment.started", "work_assignment", assignmentId, collected.driverId, { from_state: "ASSIGNED", to_state: "IN_PROGRESS" })
    if (pickupPoint) add(`${collected.eventId}-pickup`, collected.at, "vehicle.picked_up", "transport_point", String(pickupPoint.id), collected.driverId, { changes: { segment_id: segmentId, occurred_at: collected.at, keys: collected.data.keys ?? null } })
    if (collected.data.photo_ids?.length) add(`${collected.eventId}-proof-submitted`, collected.at, "proof.submitted", "proof", `${collected.eventId}-proof`, collected.driverId, { changes: { kind: "PICKUP_PHOTOS", file_count: collected.data.photo_ids.length }, to_state: "SUBMITTED" })
    if (fromStatus !== "IN_TRANSIT" && fromStatus !== "DELIVERED") add(`${collected.eventId}-status`, collected.at, "order.status_changed", "order", orderId, collected.driverId, { from_state: fromStatus, to_state: "IN_TRANSIT", actor_type: "system", source: "portal" })
  }
  const delivered = lifecycle.DELIVERED
  if (delivered) {
    if (deliveryPoint) add(`${delivered.eventId}-delivery`, delivered.at, "vehicle.delivered", "transport_point", String(deliveryPoint.id), delivered.driverId, { changes: { segment_id: segmentId, occurred_at: delivered.at, receiver_name: delivered.data.receiver_name ?? null, keys: delivered.data.keys ?? null } })
    if (delivered.data.photo_ids?.length) add(`${delivered.eventId}-proof-submitted`, delivered.at, "proof.submitted", "proof", `${delivered.eventId}-proof`, delivered.driverId, { changes: { kind: "DELIVERY_PHOTOS", file_count: delivered.data.photo_ids.length }, to_state: "SUBMITTED" })
    add(`${delivered.eventId}-complete`, delivered.at, "assignment.completed", "work_assignment", delivered.data.assignment_id, delivered.driverId, { from_state: "IN_PROGRESS", to_state: "COMPLETED" })
    add(`${delivered.eventId}-status`, delivered.at, "order.status_changed", "order", orderId, delivered.driverId, { from_state: "IN_TRANSIT", to_state: "DELIVERED", actor_type: "system", source: "portal" })
  }
  return rows
}
