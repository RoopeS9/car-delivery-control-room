import { deriveAttention, deriveKeyDates, latestTracking, strongestTone } from "./attention"
import { type Bundle, isBeforeSnapshot, num, rows, str, strings } from "./bundle"
import { label } from "./labels"
import { fmtDateTime, fmtMoney, relativeTo } from "./time"
import type { AttentionKind, BoardCard, WorkLine } from "./types"

const ICONS: Record<AttentionKind, WorkLine["icon"]> = {
  alert: "alert", owned_alert: "alert", work: "work", incident: "incident", waiting: "waiting", conversation: "waiting",
  proposal: "proposal", claim: "alert", custody: "work", check: "note", inbox: "waiting",
}

const MAX_LINES = 2

export function buildBoardCard(bundle: Bundle): BoardCard {
  const { order, dir, snapshotAt } = bundle
  const primary = bundle.items.find((item) => item.role === "PRIMARY") ?? bundle.items[0] ?? null
  const pickup = bundle.places.get(order.pickupAddressId)
  const delivery = bundle.places.get(order.deliveryAddressId)
  const attention = deriveAttention(bundle)
  const { decisive } = deriveKeyDates(bundle)
  const tone = attention.length ? strongestTone(attention.map((item) => item.tone)) : "ok"

  const work: WorkLine[] = []
  const first = attention[0]
  if (first) {
    const hidden = attention.length - 1
    work.push({ icon: ICONS[first.kind], text: hidden > 0 ? `${first.short} · +${hidden} more` : first.short, tone: first.tone })
  }

  const assignments = rows(bundle, "work_assignments").map((row) => row.details)
  const active = assignments.find((row) => row.status === "IN_PROGRESS") ?? assignments.find((row) => row.status === "ASSIGNED")
  if (active) {
    const name = dir.driverName(active.driver_id) ?? "Driver"
    const segmentIds = strings(active.segment_ids)
    const tradeInItems = new Set(bundle.items.filter((item) => item.role === "TRADE_IN").map((item) => item.id))
    const returnLeg = rows(bundle, "transport_segments").some((segment) => segmentIds.includes(segment.id) && tradeInItems.has(String(segment.details.order_item_id)))
    const prefix = returnLeg ? "Trade-in return · " : ""
    if (active.status === "IN_PROGRESS") {
      const eta = latestTracking(bundle).direct?.eta ?? null
      work.push({ icon: "driver", text: eta ? `${prefix}${name} driving · ETA ${fmtDateTime(eta, decisive?.zone ?? null)}` : `${prefix}${name} driving · no driver-app ETA`, tone: "neutral" })
    } else {
      work.push({ icon: "driver", text: `${prefix}${name} assigned`, tone: "neutral" })
    }
  } else if (order.lane === "market") {
    const offer = rows(bundle, "market_offers").map((row) => row.details).find((row) => row.status === "PUBLISHED")
    if (offer) {
      const age = relativeTo(str(offer.published_at), snapshotAt)
      const cutoffPassed = isBeforeSnapshot(str(offer.expires_at), snapshotAt)
      const fee = fmtMoney(num(offer.fee_cents), str(offer.currency) ?? "EUR")
      work.push({
        icon: "offer",
        text: `${offer.visibility === "DIRECTED" ? "Directed offer" : "Offer"} published ${age?.text ?? ""}${fee ? ` · ${fee}` : ""}${cutoffPassed ? " · booking cutoff passed" : ""}`.trim(),
        tone: cutoffPassed ? "warn" : "neutral",
      })
    }
  } else if (order.lane === "delivered") {
    const done = assignments.find((row) => row.status === "COMPLETED")
    const name = done ? dir.driverName(done.driver_id) : null
    if (name) work.push({ icon: "driver", text: `Delivered by ${name}`, tone: "neutral" })
  }

  return {
    id: order.id,
    reference: order.reference,
    displayLane: order.lane,
    status: order.status,
    statusLabel: label(order.status),
    routeKind: order.routeKind,
    routeKindLabel: label(order.routeKind),
    customer: bundle.customer.name,
    customerTier: bundle.customer.tier,
    vehicle: primary ? `${primary.vehicle.make} ${primary.vehicle.model}` : "Vehicle not linked",
    vehicleMake: primary?.vehicle.make ?? null,
    plate: primary?.vehicle.registration ?? null,
    origin: pickup ? `${pickup.city}, ${pickup.country}` : "Unknown",
    destination: delivery ? `${delivery.city}, ${delivery.country}` : "Unknown",
    from: { city: pickup?.city ?? "Unknown", country: pickup?.country ?? "" },
    to: { city: delivery?.city ?? "Unknown", country: delivery?.country ?? "" },
    openAlerts: bundle.alerts.filter((alert) => alert.status === "OPEN").map((alert) => alert.severity),
    acknowledgedAlerts: bundle.alerts.filter((alert) => alert.status === "ACKNOWLEDGED").map((alert) => alert.severity),
    attention,
    attentionTone: tone,
    decisive,
    work: work.slice(0, MAX_LINES),
    updatedAt: order.updatedAt,
  }
}
