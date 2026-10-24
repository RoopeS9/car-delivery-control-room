// The live map: one marker per order with a simulated phone position. Every
// position is labelled simulated and carries its age (PLAN.md 4.7). Orders on
// the road with no position are listed, not guessed.

import type { TelemetryRow } from "@/lib/cr/queries"
import type { GpsData } from "@/lib/cr/types"
import { rows, str, type Bundle } from "./bundle"
import { caseStatusLabel, urgencyTone } from "./cases"
import { minutesBetween, relativeTo } from "./time"
import type { MapMarker, MapMarkerState, MapView, Tone } from "./types"

/** A phone that has not reported for this long is drawn hollow. */
export const STALE_AFTER_MINUTES = 30

function markerState(bundle: Bundle): { state: MapMarkerState; label: string; tone: Tone; caseId: string | null; caseTitle: string | null; ask: string | null } {
  const open = bundle.cr.cases.filter((kase) => kase.status !== "RESOLVED" && kase.status !== "HANDLED_BY_AGENT")
  const pending = bundle.cr.proposals.find((proposal) => proposal.status === "PENDING" && open.some((kase) => kase.id === proposal.caseId))
  const decide = pending ? open.find((kase) => kase.id === pending.caseId) : open.find((kase) => kase.status === "NEEDS_DECISION")
  if (decide) return { state: "decide", label: "Needs your decision", tone: urgencyTone(decide.urgency), caseId: decide.id, caseTitle: decide.title, ask: pending?.title ?? decide.nextStep }
  const working = open.find((kase) => kase.status === "AGENT_WORKING")
  if (working) return { state: "agent", label: "Agent working", tone: "accent", caseId: working.id, caseTitle: working.title, ask: working.nextStep }
  const waiting = open.find((kase) => kase.status === "WAITING_EXTERNAL")
  if (waiting) return { state: "waiting", label: caseStatusLabel(waiting), tone: "neutral", caseId: waiting.id, caseTitle: waiting.title, ask: waiting.nextStep }
  return { state: "fine", label: "No open case", tone: "ok", caseId: null, caseTitle: null, ask: null }
}

export function buildMap(bundles: Bundle[], positions: TelemetryRow[], now: string): MapView {
  const byOrder = new Map(positions.map((row) => [row.orderId, row]))
  const markers: MapMarker[] = []
  const unplaced: MapView["unplaced"] = []
  for (const bundle of bundles) {
    const primary = bundle.items.find((item) => item.role === "PRIMARY") ?? bundle.items[0] ?? null
    const from = bundle.places.get(bundle.order.pickupAddressId)
    const to = bundle.places.get(bundle.order.deliveryAddressId)
    const vehicle = primary ? `${primary.vehicle.make} ${primary.vehicle.model}` : "Vehicle not linked"
    const route = `${from?.city ?? "Unknown"} → ${to?.city ?? "Unknown"}`
    const position = byOrder.get(bundle.order.id)
    const gps = position?.data as Partial<GpsData> | undefined
    if (!position || typeof gps?.lat !== "number" || typeof gps?.lng !== "number") {
      if (bundle.order.lane === "moving") unplaced.push({ orderId: bundle.order.id, reference: bundle.order.reference, vehicle, route })
      continue
    }
    const at = position.at.toISOString()
    const minutes = minutesBetween(at, now) ?? 0
    const rel = relativeTo(at, now)
    const active = rows(bundle, "work_assignments").find((row) => str(row.details.status) === "IN_PROGRESS")
    const state = markerState(bundle)
    markers.push({
      orderId: bundle.order.id, reference: bundle.order.reference, vehicle, vehicleMake: primary?.vehicle.make ?? null,
      route, customer: bundle.customer.name, driver: active ? bundle.dir.driverName(active.details.driver_id) : null,
      lat: gps.lat, lng: gps.lng, at, ageLabel: rel ? (rel.text === "now" ? "just now" : rel.text) : "time unknown",
      stale: minutes > STALE_AFTER_MINUTES,
      state: state.state, stateLabel: state.label, tone: state.tone, caseId: state.caseId, caseTitle: state.caseTitle, ask: state.ask,
      speedKmh: typeof gps.speed_kmh === "number" ? Math.round(gps.speed_kmh) : null,
      placeLabel: typeof gps.place_label === "string" ? gps.place_label : null,
      simulated: position.simulated,
    })
  }
  const rank: Record<MapMarkerState, number> = { decide: 0, agent: 1, waiting: 2, fine: 3 }
  markers.sort((a, b) => rank[a.state] - rank[b.state] || Number(a.stale) - Number(b.stale) || a.reference.localeCompare(b.reference))
  return { simNow: now, markers, unplaced, staleAfterMinutes: STALE_AFTER_MINUTES }
}
