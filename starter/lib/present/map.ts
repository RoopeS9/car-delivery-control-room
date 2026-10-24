// The live map: one marker per order with a simulated phone position. Every
// position is labelled simulated and carries its age (PLAN.md 4.7). Orders on
// the road with no position are listed, not guessed.

import type { TelemetryRow } from "@/lib/cr/queries"
import type { GpsData } from "@/lib/cr/types"
import { rows, str, type Bundle } from "./bundle"
import { changedTiming } from "./attention"
import { buildQueue } from "./queue"
import { minutesBetween, relativeTo } from "./time"
import type { MapMarker, MapMarkerState, MapView, Tone } from "./types"

/** A phone that has not reported for this long is drawn hollow. */
export const STALE_AFTER_MINUTES = 30

function markerState(bundle: Bundle): { state: MapMarkerState; label: string; tone: Tone; caseId: string | null; caseTitle: string | null; ask: string | null } {
  // Match the attention queue, including overdue follow-ups, unknown outcomes
  // and human work outside the road agent's case.
  const queue = buildQueue([bundle], bundle.snapshotAt, bundle.cr.now)
  const decide = queue.decide[0]
  if (decide) return { state: "decide", label: "Needs your decision", tone: decide.tone, caseId: decide.caseId, caseTitle: decide.headline, ask: decide.ask }
  const working = queue.agentWorking[0]
  if (working) return { state: "agent", label: "Agent working", tone: "accent", caseId: working.caseId, caseTitle: working.headline, ask: working.ask }
  const waiting = queue.waiting[0]
  if (waiting) return { state: "waiting", label: waiting.statusLabel, tone: "neutral", caseId: waiting.caseId, caseTitle: waiting.headline, ask: waiting.ask }
  const routine = queue.routine[0]
  if (routine) return { state: "fine", label: "Routine recorded follow-up", tone: "neutral", caseId: null, caseTitle: routine.headline, ask: routine.ask }
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
      timing: changedTiming(bundle),
      speedKmh: typeof gps.speed_kmh === "number" ? Math.round(gps.speed_kmh) : null,
      placeLabel: typeof gps.place_label === "string" ? gps.place_label : null,
      simulated: position.simulated,
    })
  }
  const rank: Record<MapMarkerState, number> = { decide: 0, agent: 1, waiting: 2, fine: 3 }
  markers.sort((a, b) => rank[a.state] - rank[b.state] || Number(a.stale) - Number(b.stale) || a.reference.localeCompare(b.reference))
  return { simNow: now, markers, unplaced, staleAfterMinutes: STALE_AFTER_MINUTES }
}
