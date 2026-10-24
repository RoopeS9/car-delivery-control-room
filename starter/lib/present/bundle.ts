// One order with everything the projections read, in a shape both the board and
// the record view can share. The routes build bundles from the database rows.

import type { Directory } from "./actors"
import type { Row } from "./types"

export type AlertRow = {
  id: string; status: string; severity: string; signal: string; summary: string; triggeredAt: string; details: Row
}
export type ConversationRow = {
  id: string; orderId: string; status: string; category: string; channel: string; updatedAt: string; details: Row
}
export type MessageRow = {
  id: string; orderId: string; conversationId: string; authorType: string; body: string; authoredAt: string; details: Row
}
export type EventRow = {
  id: string; orderId: string; command: string; targetType: string; targetId: string; recordedAt: string; details: Row
}
export type RelatedRow = { id: string; details: Row }

export type PlaceRow = {
  id: string; name: string; city: string; country: string; managedSiteId: string | null; details: Row
}
export type SiteRow = { id: string; name: string; city: string; country: string; kind: string; details: Row }

export type Bundle = {
  snapshotAt: string | null
  order: {
    id: string; reference: string; lane: string; status: string; routeKind: string
    createdAt: string; updatedAt: string; details: Row
    pickupAddressId: string; deliveryAddressId: string; pickupSiteId: string | null; deliverySiteId: string | null
  }
  customer: { id: string; name: string; tier: string | null; country: string | null }
  items: { id: string; role: string; details: Row; vehicle: { id: string; make: string; model: string; year: number | null; fuel: string | null; registration: string | null; vin: string | null } }[]
  alerts: AlertRow[]
  conversations: ConversationRow[]
  messages: MessageRow[]
  events: EventRow[]
  related: Record<string, RelatedRow[] | undefined>
  places: Map<string, PlaceRow>
  sites: Map<string, SiteRow>
  dir: Directory
  /** Support inbox threads whose candidate or linked orders include this order. */
  inboxThreads: RelatedRow[]
  bundleOrderRefs: Record<string, string>
}

export function rows(bundle: Bundle, collection: string): RelatedRow[] {
  return bundle.related[collection] ?? []
}

export function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

export function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

export function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null
}

export function obj(value: unknown): Row | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Row) : null
}

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function strings(value: unknown): string[] {
  return list(value).filter((item): item is string => typeof item === "string")
}

export function refCount(value: unknown): number {
  return list(value).length
}

/** The plan the journey is read from: the active plan, or the newest plan when none is active. */
export function journeyPlan(bundle: Bundle): { plan: RelatedRow | null; active: boolean } {
  const planId = str(bundle.order.details.active_plan_id)
  const plans = rows(bundle, "transport_plans")
  const active = planId ? plans.find((plan) => plan.id === planId) ?? null : null
  if (active) return { plan: active, active: true }
  const newest = [...plans].sort((a, b) => String(b.details.created_at ?? "").localeCompare(String(a.details.created_at ?? "")))[0] ?? null
  return { plan: newest, active: false }
}

/** Points of the journey plan, in sequence. */
export function activePoints(bundle: Bundle): RelatedRow[] {
  const { plan } = journeyPlan(bundle)
  return rows(bundle, "transport_points")
    .filter((point) => !plan || point.details.plan_id === plan.id)
    .sort((a, b) => (num(a.details.sequence) ?? 0) - (num(b.details.sequence) ?? 0))
}

export function originPickupPoint(bundle: Bundle): RelatedRow | null {
  const points = activePoints(bundle)
  return points.find((point) => point.details.role === "PICKUP" && point.details.order_boundary === "PICKUP")
    ?? points.find((point) => point.details.role === "PICKUP") ?? null
}

export function finalDeliveryPoint(bundle: Bundle): RelatedRow | null {
  const points = activePoints(bundle)
  const candidates = points.filter((point) => point.details.role === "DELIVERY" && point.details.order_boundary === "DELIVERY")
  return candidates[candidates.length - 1] ?? points.filter((point) => point.details.role === "DELIVERY").pop() ?? null
}

export function recordedAt(bundle: Bundle, command: string, pointId: string | null | undefined): EventRow | null {
  if (!pointId) return null
  return bundle.events.find((event) => event.command === command && event.targetId === pointId) ?? null
}

export function isBeforeSnapshot(value: string | null, snapshotAt: string | null): boolean {
  if (!value || !snapshotAt) return false
  const a = new Date(value).getTime()
  const b = new Date(snapshotAt).getTime()
  return !Number.isNaN(a) && !Number.isNaN(b) && a < b
}
