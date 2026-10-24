// One sentence per operational event. The event stays the source; the sentence
// only reads it out with names instead of identifiers.

import { type Bundle, type EventRow, num, obj, rows, str } from "./bundle"
import { humanize, label, labelIn } from "./labels"
import { fmtDateTime, fmtMoney } from "./time"
import type { HistoryEvent } from "./types"

function pointName(bundle: Bundle, pointId: string): string | null {
  const point = rows(bundle, "transport_points").find((row) => row.id === pointId)
  if (!point) return null
  const place = bundle.places.get(String(point.details.address_id))
  const role = str(point.details.role)
  const where = place ? `${place.name}, ${place.city}` : null
  if (role === "TRANSFER") return where ? `transfer yard ${where}` : "the transfer yard"
  return where
}

function scalarChanges(changes: Record<string, unknown>, skip: string[] = []): string | null {
  const parts = Object.entries(changes)
    .filter(([key, value]) => !skip.includes(key) && !/(_id|_ids|_refs|_reference|_at)$/.test(key) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean"))
    .map(([key, value]) => `${humanize(key).toLowerCase()}: ${typeof value === "string" ? label(value) : String(value)}`)
  return parts.length ? parts.join(" · ") : null
}

export function describeEvent(event: EventRow, bundle: Bundle): HistoryEvent {
  const { dir } = bundle
  const d = event.details
  const changes = obj(d.changes) ?? {}
  const actor = dir.resolve(d.actor_id, d.actor_type)
  const actorName = actor.kind === "system" ? null : actor.name
  const toState = str(d.to_state)
  const fromState = str(d.from_state)
  const shared = event.orderId !== bundle.order.id
  let text = ""
  let detail: string | null = null

  switch (event.command) {
    case "order.created":
      text = `Order created${actor.kind === "customer" ? ` by ${actor.name}` : ""}`
      detail = str(d.source) ? `via ${labelIn(str(d.source))}` : null
      break
    case "order.status_changed":
      text = `Status changed to ${label(toState)}`
      detail = fromState ? `from ${label(fromState)}` : null
      break
    case "order.readiness_assessed":
      text = "Readiness assessed"
      detail = scalarChanges(changes)
      break
    case "order.item_added":
      text = "Second item added to the order"
      break
    case "availability.confirmed":
      text = "Collection availability confirmed"
      break
    case "plan.created":
      text = `Transport plan created${num(changes.version) ? ` (version ${num(changes.version)})` : ""}`
      break
    case "plan.activated":
      text = "Transport plan activated"
      break
    case "plan.completed":
      text = "Transport plan completed"
      break
    case "plan.replaced":
      text = "Transport plan replaced"
      detail = scalarChanges(changes)
      break
    case "plan.cancelled":
      text = "Transport plan cancelled"
      break
    case "offer.published":
      text = `Driver offer published${num(changes.fee_cents) ? ` at ${fmtMoney(num(changes.fee_cents), str(changes.currency) ?? "EUR")}` : ""}`
      detail = str(changes.visibility) === "DIRECTED" ? "directed to a named driver" : null
      break
    case "offer.accepted":
      text = `Offer accepted${actor.kind === "driver" ? ` by ${actor.name}` : ""}`
      break
    case "offer.withdrawn":
      text = "Offer withdrawn"
      detail = scalarChanges(changes)
      break
    case "assignment.booked":
      text = `${actor.kind === "driver" ? actor.name : "A driver"} booked the gig`
      break
    case "assignment.started":
      text = `${actor.kind === "driver" ? actor.name : "The driver"} started the assignment`
      break
    case "assignment.completed":
      text = `${actor.kind === "driver" ? actor.name : "The driver"} completed the assignment`
      break
    case "assignment.cancelled":
      text = "Assignment cancelled"
      detail = [str(changes.reason_code) ? labelIn(str(changes.reason_code)) : null, str(changes.payout_decision) ? labelIn(str(changes.payout_decision)) : null].filter(Boolean).join(", ") || null
      break
    case "vehicle.picked_up": {
      const where = pointName(bundle, event.targetId)
      const transfer = where?.startsWith("transfer yard")
      text = transfer ? `Vehicle released from the ${where}` : `Vehicle picked up${where ? ` at ${where}` : ""}`
      const occurred = str(changes.occurred_at)
      detail = occurred && occurred !== event.recordedAt ? `occurred ${fmtDateTime(occurred)}, recorded later` : null
      break
    }
    case "vehicle.delivered": {
      const where = pointName(bundle, event.targetId)
      const transfer = where?.startsWith("transfer yard")
      text = transfer ? `Vehicle received at the ${where}` : `Vehicle delivered${where ? ` at ${where}` : ""}`
      const occurred = str(changes.occurred_at)
      detail = occurred && occurred !== event.recordedAt ? `occurred ${fmtDateTime(occurred)}, recorded later` : null
      break
    }
    case "vehicle.custody_reported":
      text = `${actor.kind === "driver" ? actor.name : "Driver"} reported custody of the vehicle`
      detail = scalarChanges(changes)
      break
    case "proof.require":
      text = `${label(str(changes.kind))} required`
      break
    case "proof.submitted":
      text = `${label(str(changes.kind))} submitted${num(changes.file_count) ? ` (${num(changes.file_count)} files)` : ""}`
      break
    case "proof.approved":
      text = `${label(str(changes.kind)) || "Proof"} approved`
      break
    case "proof.rejected":
      text = `${label(str(changes.kind)) || "Proof"} rejected`
      detail = scalarChanges(changes, ["kind"])
      break
    case "proof.review":
      text = "Proof reviewed"
      detail = scalarChanges(changes)
      break
    case "proof.requirement_migrated":
      text = "Proof requirement moved to a replacement step"
      break
    case "expense.submitted":
      text = `${label(str(changes.kind)) || "Cost"} claim submitted${num(changes.amount_cents) ? `, ${fmtMoney(num(changes.amount_cents), str(changes.currency) ?? "EUR")}` : ""}`
      break
    case "expense.reviewed":
      text = `Cost claim ${labelIn(toState) || "reviewed"}`
      detail = scalarChanges(changes)
      break
    case "expense.auto_recorded":
      text = `${label(str(changes.kind)) || "Cost"} recorded automatically`
      detail = scalarChanges(changes, ["kind"])
      break
    case "travel.booked":
      text = `${label(str(changes.kind)) || "Travel"} booked`
      break
    case "travel.rebooked":
      text = `${label(str(changes.kind)) || "Travel"} rebooked`
      detail = scalarChanges(changes, ["kind"])
      break
    case "travel.arrival_reported":
      text = `${actor.kind === "driver" ? actor.name : "Driver"} reported arrival`
      detail = scalarChanges(changes)
      break
    case "alert.raised":
      text = `Alert raised: ${label(str(changes.signal))}`
      break
    case "alert.acknowledged":
      text = `Alert acknowledged${actorName ? ` by ${actorName}` : ""}`
      detail = scalarChanges(changes)
      break
    case "alert.resolved":
      text = "Alert resolved"
      detail = scalarChanges(changes)
      break
    case "alert.dismissed":
      text = "Alert dismissed"
      detail = scalarChanges(changes)
      break
    case "document.verified":
      text = `${label(str(changes.kind)) || "Document"} verified`
      break
    case "document.prepared":
      text = `${label(str(changes.kind)) || "Document"} prepared`
      break
    case "document.signed":
      text = `${label(str(changes.kind)) || "Document"} signed`
      detail = scalarChanges(changes, ["kind"])
      break
    case "work_item.opened": {
      const what = label(str(changes.decision_code) ?? str(changes.kind))
      text = what ? `Work item opened: ${what}` : "Work item opened"
      detail = dir.title(changes.owner) ? `owner ${dir.title(changes.owner)}` : null
      break
    }
    case "work_item.closed":
      text = "Work item closed"
      detail = scalarChanges(changes)
      break
    case "endpoint.access_confirmed":
      text = `${label(str(changes.boundary)) || "Endpoint"} access confirmed${actorName ? ` by ${actorName}` : ""}`
      detail = scalarChanges(changes, ["boundary"])
      break
    case "endpoint.contact_confirmed":
      text = `${label(str(changes.boundary)) || "Endpoint"} contact confirmed${actorName ? ` by ${actorName}` : ""}`
      detail = scalarChanges(changes, ["boundary"])
      break
    case "endpoint.claim_recorded":
      text = `Claim recorded about the ${labelIn(str(changes.field)) || "endpoint"}`
      break
    case "endpoint.claim_resolved":
      text = `Claim ${labelIn(toState) || "resolved"}`
      break
    case "incident.opened":
      text = `Incident opened: ${label(str(changes.kind))}`
      detail = dir.title(changes.owner) ? `owner ${dir.title(changes.owner)}` : null
      break
    case "exposure.shown":
      text = `Directed offer shown to ${dir.driverName(changes.driver_id) ?? "a driver"}`
      break
    case "exposure.notified":
      text = `${dir.driverName(changes.driver_id) ?? "The driver"} was notified of the directed offer`
      break
    case "exposure.viewed":
      text = `${dir.driverName(changes.driver_id) ?? "The driver"} viewed the directed offer`
      break
    case "exposure.accepted":
      text = `${dir.driverName(changes.driver_id) ?? actor.name} accepted the directed offer`
      break
    case "exposure.rejected":
      text = `${dir.driverName(changes.driver_id) ?? actor.name} declined the directed offer`
      break
    case "exposure.expired":
      text = "Directed offer expired"
      break
    case "market.offer_assessed":
      text = `Live offer reviewed: ${labelIn(str(changes.decision)) || "no change"}`
      break
    case "site_visit.recorded":
      text = `Site visit recorded: ${labelIn(str(changes.outcome))}`
      break
    default:
      text = `${humanize(event.command)}${toState ? `: ${label(toState)}` : ""}`
      detail = scalarChanges(changes)
  }

  const named = actorName ? text.includes(actorName) : false
  return { id: event.id, at: event.recordedAt, text, actor: named ? null : actorName, detail, shared }
}
