// What needs a person, and which date decides the order's next step. Both are
// derived from the records; neither is a stored field. A quiet result means the
// records show nothing waiting, not that the order is verified safe.

import {
  type Bundle, bool, finalDeliveryPoint, num, obj, originPickupPoint, recordedAt, rows, str, strings,
} from "./bundle"
import { label, labelIn } from "./labels"
import { fmtDateTime, isBefore, relativeTo } from "./time"
import type { AttentionItem, KeyDate, Tone, WindowView } from "./types"

const TONE_RANK: Record<Tone, number> = { danger: 0, warn: 1, accent: 2, neutral: 3, ok: 4 }

export function strongestTone(tones: Tone[]): Tone {
  return tones.reduce<Tone>((best, tone) => (TONE_RANK[tone] < TONE_RANK[best] ? tone : best), "ok")
}

export function sortAttention(items: AttentionItem[]): AttentionItem[] {
  return [...items].sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone] || String(a.at ?? "").localeCompare(String(b.at ?? "")))
}

const WINDOW_LABELS: Record<string, string> = {
  PICKUP_AVAILABILITY: "Pickup availability",
  SELECTED_PICKUP_SLOT: "Pickup slot",
  CUSTOMER_DELIVERY_PROMISE: "Delivery promise",
  REQUESTED_PICKUP_SLOT: "Requested pickup",
  REQUESTED_DELIVERY_SLOT: "Requested delivery",
  SELECTED_DELIVERY_SLOT: "Delivery slot",
}

const WINDOW_SOURCES: Record<string, string> = {
  CUSTOMER: "from the customer", OPS: "selected by Ops", SYSTEM: "system estimate", SITE: "from the site",
}

export function windowSource(source: string | null): string {
  return source ? WINDOW_SOURCES[source] ?? labelIn(source) : "source not recorded"
}

export function windowViews(bundle: Bundle): (WindowView & { pointId: string | null })[] {
  return rows(bundle, "time_windows").map((row) => {
    const purpose = str(row.details.purpose) ?? "WINDOW"
    const source = str(row.details.source)
    const selected = bool(row.details.is_selected) ?? false
    const base = WINDOW_LABELS[purpose] ?? label(purpose)
    return {
      pointId: str(row.details.point_id),
      purpose,
      label: purpose.startsWith("SELECTED_") || purpose === "CUSTOMER_DELIVERY_PROMISE" ? (selected ? base : `${base} (not selected)`) : base,
      start: str(row.details.start_at) ?? "",
      end: str(row.details.end_at),
      zone: str(row.details.timezone),
      source,
      sourceLabel: windowSource(source),
      selected,
      deadline: str(row.details.commitment_deadline_at),
      deadlineSource: str(row.details.deadline_source),
    }
  }).filter((window) => window.start)
}

type Windows = {
  requestedPickup: WindowView | null
  pickupSlot: WindowView | null
  promise: WindowView | null
  requestedDelivery: WindowView | null
}

export function chosenWindows(bundle: Bundle): Windows {
  const all = windowViews(bundle)
  const origin = originPickupPoint(bundle)
  const final = finalDeliveryPoint(bundle)
  const pickupSlot = all.find((w) => w.purpose === "SELECTED_PICKUP_SLOT" && w.selected && (!origin || w.pointId === origin.id))
    ?? all.find((w) => w.purpose === "SELECTED_PICKUP_SLOT" && w.selected) ?? null
  const promise = all.find((w) => w.purpose === "CUSTOMER_DELIVERY_PROMISE" && w.selected && (!final || w.pointId === final.id))
    ?? all.find((w) => w.purpose === "CUSTOMER_DELIVERY_PROMISE" && w.selected) ?? null
  return {
    requestedPickup: all.find((w) => w.purpose === "REQUESTED_PICKUP_SLOT") ?? null,
    pickupSlot,
    promise,
    requestedDelivery: all.find((w) => w.purpose === "REQUESTED_DELIVERY_SLOT") ?? null,
  }
}

export type Tracking = { eta: string | null; observedAt: string | null; receivedAt: string | null; quality: string | null; source: string | null; remainingKm: number | null; progress: number | null; note: string | null }

export function latestTracking(bundle: Bundle): { direct: Tracking | null; inference: Tracking | null } {
  const observations = rows(bundle, "tracking_observations")
    .map((row) => row.details)
    .sort((a, b) => String(b.observed_at ?? "").localeCompare(String(a.observed_at ?? "")))
  const read = (row: Record<string, unknown> | undefined): Tracking | null => row ? {
    eta: str(row.estimated_delivery_at), observedAt: str(row.observed_at), receivedAt: str(row.received_at),
    quality: str(row.location_quality), source: str(row.source), remainingKm: num(row.distance_remaining_km),
    progress: num(row.progress_fraction), note: str(row.context_note),
  } : null
  return {
    direct: read(observations.find((row) => row.source === "driver_app")),
    inference: read(observations.find((row) => row.location_quality === "INFERRED")),
  }
}

export type Milestones = { pickedUpAt: string | null; deliveredAt: string | null }

export function milestones(bundle: Bundle): Milestones {
  const origin = originPickupPoint(bundle)
  const final = finalDeliveryPoint(bundle)
  const pickedUp = recordedAt(bundle, "vehicle.picked_up", origin?.id)
  const delivered = recordedAt(bundle, "vehicle.delivered", final?.id)
  const occurred = (event: { recordedAt: string; details: Record<string, unknown> } | null) => {
    if (!event) return null
    const changes = obj(event.details.changes)
    return str(changes?.occurred_at) ?? event.recordedAt
  }
  return { pickedUpAt: occurred(pickedUp), deliveredAt: occurred(delivered) }
}

function keyDate(key: KeyDate["key"], labelText: string, start: string, end: string | null, zone: string | null, source: string | null, tone: Tone, note: string | null): KeyDate {
  return { key, label: labelText, start, end, zone, source, tone, note }
}

export function deriveKeyDates(bundle: Bundle): { keyDates: KeyDate[]; decisive: KeyDate | null } {
  const { snapshotAt } = bundle
  const lane = bundle.order.lane
  const windows = chosenWindows(bundle)
  const { pickedUpAt, deliveredAt } = milestones(bundle)
  const { direct } = latestTracking(bundle)
  const rel = (iso: string | null) => relativeTo(iso, snapshotAt)?.text ?? null
  const dates: Partial<Record<KeyDate["key"], KeyDate>> = {}

  dates.created = keyDate("created", "Order created", bundle.order.createdAt, null, null, null, "neutral", rel(bundle.order.createdAt))

  if (windows.requestedPickup) {
    const w = windows.requestedPickup
    dates.requested_pickup = keyDate("requested_pickup", "Requested pickup", w.start, w.end, w.zone, w.source, "neutral", "customer preference, not a selected slot")
  }

  if (windows.pickupSlot) {
    const w = windows.pickupSlot
    let tone: Tone = "neutral"
    let note = rel(w.start)
    if (pickedUpAt) {
      tone = "ok"
      note = `picked up ${fmtDateTime(pickedUpAt, w.zone)}`
    } else if ((lane === "ready" || lane === "market") && snapshotAt && isBefore(w.start, snapshotAt)) {
      tone = "warn"
      note = "slot has started and no driver is booked"
    } else if (lane === "booked" && snapshotAt && w.end && isBefore(w.end, snapshotAt)) {
      tone = "warn"
      note = "slot has passed and no pickup is recorded"
    }
    dates.pickup_slot = keyDate("pickup_slot", "Pickup slot", w.start, w.end, w.zone, w.source, tone, note)
  }

  if (windows.promise) {
    const w = windows.promise
    let tone: Tone = "neutral"
    let note = rel(w.end ?? w.start)
    if (deliveredAt) {
      tone = "ok"
      note = snapshotAt && w.end && isBefore(w.end, deliveredAt) ? "delivered after the promised window" : "delivered within the window"
    } else if (lane === "moving" && snapshotAt && w.end && isBefore(w.end, snapshotAt)) {
      tone = "danger"
      note = "promise has passed and no delivery is recorded"
    } else if (lane === "moving" && direct?.eta && w.end && isBefore(w.end, direct.eta)) {
      tone = "danger"
      note = `driver-app ETA ${fmtDateTime(direct.eta, w.zone)} is after the promise`
    }
    const deadlineNote = w.deadline ? ` · outer limit ${fmtDateTime(w.deadline, w.zone)}` : ""
    dates.promise = keyDate("promise", "Delivery promise", w.start, w.end, w.zone, w.source, tone, note ? `${note}${deadlineNote}` : deadlineNote || null)
  } else if (windows.requestedDelivery) {
    const w = windows.requestedDelivery
    dates.promise = keyDate("promise", "Requested delivery", w.start, w.end, w.zone, w.source, "neutral", "customer preference, no promise selected")
  }

  if (direct?.eta && !deliveredAt && lane === "moving") {
    const zone = windows.promise?.zone ?? null
    const late = windows.promise?.end ? isBefore(windows.promise.end, direct.eta) : false
    const age = relativeTo(direct.receivedAt, snapshotAt)
    dates.eta = keyDate("eta", "ETA from driver app", direct.eta, null, zone, direct.source, late ? "danger" : "neutral",
      `${labelIn(direct.quality)} signal received ${age ? age.text : "at an unknown time"}; unverified`)
  }

  if (deliveredAt) {
    dates.delivered = keyDate("delivered", "Delivered", deliveredAt, null, windows.promise?.zone ?? null, "driver app", "ok", rel(deliveredAt))
  }

  const cancelledAt = str(bundle.order.details.cancelled_at)
  if (cancelledAt) {
    dates.cancelled = keyDate("cancelled", "Cancelled", cancelledAt, null, null, null, "neutral", rel(cancelledAt))
  }

  const order: KeyDate["key"][] = ["requested_pickup", "pickup_slot", "promise", "eta", "delivered", "cancelled", "created"]
  const keyDates = order.map((key) => dates[key]).filter((date): date is KeyDate => !!date)

  const pick = (...keys: KeyDate["key"][]) => keys.map((key) => dates[key]).find((date): date is KeyDate => !!date) ?? null
  const decisive = lane === "intake" ? pick("requested_pickup", "promise", "created")
    : lane === "ready" || lane === "market" || lane === "booked" ? pick("pickup_slot", "requested_pickup", "promise", "created")
    : lane === "moving" ? pick("promise", "eta", "pickup_slot")
    : lane === "delivered" ? pick("delivered", "promise", "created")
    : lane === "cancelled" ? pick("cancelled", "created")
    : pick("created")
  return { keyDates, decisive }
}

const OPEN_WORK = new Set(["OPEN", "NEEDS_EXTERNAL_INPUT", "IN_PROGRESS", "WAITING"])

export function deriveAttention(bundle: Bundle): AttentionItem[] {
  const { snapshotAt, dir } = bundle
  const lane = bundle.order.lane
  const items: AttentionItem[] = []

  for (const alert of bundle.alerts) {
    const severe = alert.severity === "critical" || alert.severity === "high"
    const owner = dir.title(alert.details.owner)
    if (alert.status === "OPEN") {
      items.push({
        kind: "alert", tone: severe ? "danger" : "warn", title: `Open alert: ${label(alert.signal)}`, short: owner ? `${label(alert.signal)} · ${owner}` : label(alert.signal), detail: alert.summary,
        owner, at: alert.triggeredAt, atLabel: "raised", section: "alerts", recordId: alert.id,
      })
    } else if (alert.status === "ACKNOWLEDGED") {
      const at = str(alert.details.acknowledged_at) ?? alert.triggeredAt
      items.push({
        kind: "owned_alert", tone: "neutral", title: `Owned alert: ${label(alert.signal)}`, short: `${label(alert.signal)} · owned by ${owner ?? "no one recorded"}`,
        detail: `${alert.summary} Acknowledged is not resolved.`, owner: owner ?? "owner not recorded",
        at, atLabel: "acknowledged", section: "alerts", recordId: alert.id,
      })
    }
  }

  for (const row of rows(bundle, "incidents")) {
    if (str(row.details.resolved_at)) continue
    const parts = [label(str(row.details.status)), str(row.details.reported_symptom), str(row.details.recovery_decision) ? `recovery ${labelIn(row.details.recovery_decision as string)}` : null]
    items.push({
      kind: "incident", tone: "danger", title: `Incident: ${label(str(row.details.kind))}`, short: `Incident: ${labelIn(str(row.details.kind))}${dir.title(row.details.owner) ? ` · ${dir.title(row.details.owner)}` : ""}`,
      detail: parts.filter(Boolean).join(" · "), owner: dir.title(row.details.owner),
      at: str(row.details.opened_at), atLabel: "opened", section: "work", recordId: row.id,
    })
  }

  for (const row of rows(bundle, "work_items")) {
    const status = str(row.details.status) ?? ""
    if (!OPEN_WORK.has(status)) continue
    const due = str(row.details.due_at)
    const overdue = !!(due && snapshotAt && isBefore(due, snapshotAt))
    const high = str(row.details.priority) === "high"
    items.push({
      kind: "work", tone: overdue || high ? "warn" : "neutral",
      title: `${label(str(row.details.kind))}${status !== "OPEN" ? ` · ${labelIn(status)}` : ""}`, short: `${label(str(row.details.kind))}${dir.title(row.details.owner) ? ` · ${dir.title(row.details.owner)}` : ""}`,
      detail: str(row.details.summary), owner: dir.title(row.details.owner), at: due,
      atLabel: due ? (overdue ? "was due" : "due") : null, section: "work", recordId: row.id,
    })
  }

  for (const row of rows(bundle, "endpoint_claims")) {
    if (str(row.details.resolution_status) !== "OPEN") continue
    items.push({
      kind: "claim", tone: "warn", title: `Unresolved claim about the ${labelIn(str(row.details.field))}`, short: `Unresolved ${labelIn(str(row.details.field))} claim`,
      detail: str(row.details.claim), owner: null, at: str(row.details.recorded_at), atLabel: "recorded",
      section: "journey", recordId: row.id,
    })
  }

  for (const row of rows(bundle, "agent_proposals")) {
    const status = str(row.details.status)
    const summary = str(row.details.summary)
    const execution = obj(row.details.execution)
    if (status === "PENDING_REVIEW") {
      items.push({ kind: "proposal", tone: "accent", title: "Agent proposal awaiting review", short: "Agent proposal awaiting review", detail: summary, owner: null, at: str(row.details.created_at), atLabel: "proposed", section: "decisions", recordId: row.id })
    } else if (status === "APPROVED_AWAITING_EXECUTION") {
      const reviewer = dir.title(obj(row.details.review)?.reviewer_id)
      items.push({ kind: "proposal", tone: "accent", title: "Approved proposal not yet executed", short: "Approved proposal not executed", detail: summary, owner: reviewer, at: str(obj(row.details.review)?.reviewed_at) ?? str(row.details.created_at), atLabel: "approved", section: "decisions", recordId: row.id })
    } else if (status === "FAILED") {
      items.push({ kind: "proposal", tone: "danger", title: "Agent action failed", short: "Agent action failed", detail: str(execution?.error) ?? summary, owner: null, at: str(execution?.attempted_at), atLabel: "attempted", section: "decisions", recordId: row.id })
    }
  }

  for (const thread of bundle.conversations) {
    if (thread.status !== "OPEN") continue
    const named = !!(str(thread.details.counterparty_id) || str(thread.details.counterparty_type))
    const counterparty = named ? dir.resolve(thread.details.counterparty_id, thread.details.counterparty_type) : null
    const withWhom = counterparty ? ` with ${counterparty.name}` : ""
    const waitingOn = str(thread.details.waiting_on)
    const owner = dir.title(thread.details.owner)
    if (waitingOn) {
      const nextCheck = str(thread.details.next_check_at)
      items.push({
        kind: "waiting", tone: "neutral", title: `Waiting on ${labelIn(waitingOn)}`, short: `Waiting on ${labelIn(waitingOn)}${owner ? ` · ${owner}` : ""}`,
        detail: `${label(thread.category)}${withWhom}`, owner,
        at: nextCheck ?? thread.updatedAt, atLabel: nextCheck ? "next check" : "last message", section: "conversations", recordId: thread.id,
      })
    } else {
      items.push({
        kind: "conversation", tone: "neutral", title: `Open conversation: ${labelIn(thread.category)}`, short: counterparty ? `Open thread with ${counterparty.name}: ${labelIn(thread.category)}` : `Open ${labelIn(thread.channel)}: ${labelIn(thread.category)}`,
        detail: `${label(thread.channel)}${withWhom}`, owner,
        at: thread.updatedAt, atLabel: "last message", section: "conversations", recordId: thread.id,
      })
    }
  }

  for (const row of rows(bundle, "custody_assets")) {
    const next = str(row.details.next_action)
    if (!next) continue
    items.push({
      kind: "custody", tone: "neutral", title: `Custody check: ${str(row.details.label) ?? label(str(row.details.kind))}`, short: `Custody check${dir.title(row.details.followup_owner) ? ` · ${dir.title(row.details.followup_owner)}` : ""}`,
      detail: next, owner: dir.title(row.details.followup_owner), at: str(row.details.followup_due_at), atLabel: "due",
      section: "evidence", recordId: row.id,
    })
  }

  if (lane === "booked" && !milestones(bundle).pickedUpAt) {
    const origin = originPickupPoint(bundle)
    const detail = rows(bundle, "order_endpoint_details").find((row) =>
      (origin && row.details.point_id === origin.id) || (!origin && row.details.boundary === "PICKUP"))
    if (detail) {
      const contact = str(detail.details.contact_status)
      const access = str(detail.details.access_status)
      if (contact === "UNCONFIRMED" || access === "NEEDS_VERIFICATION") {
        const source = str(detail.details.last_confirmed_source)
        items.push({
          kind: "check", tone: "neutral", title: "Pickup details not verified for this order", short: "Pickup contact or access not verified",
          detail: `Contact ${labelIn(contact)}, access ${labelIn(access)}${source ? ` (${labelIn(source)})` : ""}. Not an incident; check before the driver travels.`,
          owner: null, at: null, atLabel: null, section: "journey", recordId: detail.id,
        })
      }
    }
  }

  if (lane === "moving") {
    // A car on the road with a driver in progress, no driver-app position and a
    // promise still open is a gap in the record, not an incident. An open or
    // owned tracking or promise alert already covers the same gap.
    const active = rows(bundle, "work_assignments").find((row) => str(row.details.status) === "IN_PROGRESS")
    const positioned = rows(bundle, "tracking_observations").some((row) => str(row.details.source) === "driver_app")
    const promise = chosenWindows(bundle).promise
    const promiseOpen = !!(promise?.end && snapshotAt && !isBefore(promise.end, snapshotAt))
    const covered = bundle.alerts.some((alert) =>
      (alert.status === "OPEN" || alert.status === "ACKNOWLEDGED") && (alert.signal.includes("TRACKING") || alert.signal.includes("DELIVERY_PROMISE")))
    if (active && !positioned && promise && promiseOpen && !covered) {
      const driver = dir.driverName(active.details.driver_id)
      items.push({
        kind: "check", tone: "warn", title: "Moving with no driver-app position", short: "Moving, no driver-app position",
        detail: `${driver ?? "The driver"} started the leg and the app has sent no position. The promise ends ${fmtDateTime(promise.end, promise.zone)}. The record cannot say where the car is.`,
        owner: null, at: promise.end, atLabel: "promise ends", section: "journey", recordId: active.id,
      })
    }
  }

  for (const thread of bundle.inboxThreads) {
    const confirmed = strings(thread.details.linked_order_ids).includes(bundle.order.id)
    const state = str(thread.details.link_state)
    if (confirmed && str(thread.details.status) !== "OPEN") continue
    items.push({
      kind: "inbox", tone: "neutral",
      title: confirmed ? `Support inbox thread linked to this order` : "Unlinked support message may concern this order",
      short: confirmed ? "Open support inbox thread" : "Unlinked support message may belong here",
      detail: `${label(str(thread.details.category))} by ${label(str(thread.details.channel)).toLowerCase()} · ${labelIn(state)}${str(thread.details.candidate_basis) ? `. ${str(thread.details.candidate_basis)}` : ""}`,
      owner: dir.title(thread.details.owner), at: str(thread.details.updated_at), atLabel: "updated", section: "conversations", recordId: thread.id,
    })
  }

  return sortAttention(items)
}
