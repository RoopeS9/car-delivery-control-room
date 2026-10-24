// What we already know when the call starts, read through the starter's
// reading layer (lib/present/load.ts) and the dataset records it returns.
// Every fact carries its source and time, so the interviewer can confirm
// instead of asking, and the analyst can tell what came from the call.

import { eq } from "drizzle-orm"
import { db } from "@/lib/db"
import { loadOrder } from "@/lib/present/load"
import { journeyPlan, num, str } from "@/lib/present/bundle"
import { fmtDateTime, fmtRange } from "@/lib/present/time"
import { bookingSchedule } from "@/lib/present/bookings"
import { drivers, orders } from "@/lib/schema"
import { simNow } from "./clock"
import type { ContextFact, TelemetryHint } from "./types"

export type CallContext = {
  orderId: string
  orderRef: string
  driverId: string
  driverName: string | null
  firstName: string | null
  vehicleLabel: string | null
  facts: ContextFact[]
  /** A fault reported by the car before the call (drives the opening). */
  telemetryFault: boolean
}

export class CallContextError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = "CallContextError"
  }
}

type Details = Record<string, unknown>

const utc = (value: unknown) => fmtDateTime(str(value), "UTC")

export async function loadCallContext(input: { orderRef: string; driverId: string; telemetryHint?: TelemetryHint | null }): Promise<CallContext> {
  const reference = input.orderRef.trim().toUpperCase()
  const [orderRow] = await db.select({ id: orders.id }).from(orders).where(eq(orders.reference, reference)).limit(1)
  if (!orderRow) throw new CallContextError(404, `No order ${reference}.`)
  const loaded = await loadOrder(orderRow.id)
  if (!loaded) throw new CallContextError(404, `No order ${reference}.`)
  const { order, bundle, related, pickup, delivery, pickupSite, deliverySite, items, alerts, events } = loaded

  const assignments = (related.work_assignments ?? []).map((row) => row.details as Details)
  const assignment = assignments.find((row) => row.driver_id === input.driverId && ["IN_PROGRESS", "ASSIGNED"].includes(String(row.status)))
  if (!assignment) throw new CallContextError(403, `${input.driverId} is not the driver on ${reference}.`)
  const [driver] = await db.select().from(drivers).where(eq(drivers.id, input.driverId)).limit(1)
  const driverName = driver?.displayName ?? null

  const facts: ContextFact[] = []
  const add = (key: string, text: string, source: string, at: string | null = null) => facts.push({ key, text, source, at })

  if (driverName) add("driver", `Driver: ${driverName}.`, "Driver record")
  add("assignment", `Assignment status ${String(assignment.status).toLowerCase().replace(/_/g, " ")}${assignment.started_at ? `, journey started ${utc(assignment.started_at)}` : ""}.`,
    "Work assignment", str(assignment.accepted_at))

  const assignedSegments = Array.isArray(assignment.segment_ids) ? assignment.segment_ids : []
  const assignedItemId = related.transport_segments?.find((row) => assignedSegments.includes(row.id))?.details.order_item_id
  const primary = items.find((item) => item.item.id === assignedItemId) ?? items.find((item) => item.item.role === "PRIMARY") ?? items[0]
  const vehicle = primary?.vehicle
  const vehicleLabel = vehicle ? `${vehicle.make} ${vehicle.model}` : null
  if (vehicle) {
    add("vehicle", `Car: ${vehicle.modelYear} ${vehicle.make} ${vehicle.model}, ${vehicle.fuel.toLowerCase()}${vehicle.registration ? `, plate ${vehicle.registration}` : ""}.`, "Order vehicle record")
  }

  const from = pickupSite ? `${pickupSite.name}, ${pickup?.city ?? pickupSite.city}` : pickup ? `${pickup.name}, ${pickup.city}` : "pickup"
  const to = deliverySite ? `${deliverySite.name}, ${delivery?.city ?? deliverySite.city}` : delivery ? `${delivery.name}, ${delivery.city}` : "delivery"
  const { plan, active } = journeyPlan(bundle)
  add("route", `Route: ${from} to ${to}.`, active ? "Active transport plan" : "Latest transport plan", str(plan?.details.created_at))

  const pickedUp = events.find((event) => event.command === "vehicle.picked_up")
  if (pickedUp) add("picked_up", `Car collected ${utc(pickedUp.recordedAt.toISOString())}.`, "Collection event", pickedUp.recordedAt.toISOString())

  const currentPromise = bundle.cr.effective?.promise
  if (currentPromise) add("promise", `Customer delivery promise: ${fmtRange(currentPromise.start_utc, currentPromise.end_utc, currentPromise.zone)}.`,
    currentPromise.source.label, currentPromise.source.at ?? null)

  for (const row of related.time_windows ?? []) {
    const window = row.details as Details
    if (!currentPromise && window.purpose === "CUSTOMER_DELIVERY_PROMISE" && window.is_selected) {
      add("promise", `Customer delivery promise: ${fmtRange(str(window.start_at), str(window.end_at), str(window.timezone))}.`,
        `Time window, source ${String(window.source).toLowerCase()}`, str(window.stated_at))
    }
    if (window.purpose === "SELECTED_PICKUP_SLOT" && window.is_selected && !pickedUp) {
      add("pickup_slot", `Selected pickup slot: ${fmtRange(str(window.start_at), str(window.end_at), str(window.timezone))}.`,
        `Time window, source ${String(window.source).toLowerCase()}`, str(window.stated_at))
    }
  }

  const reservations = (related.travel_reservations ?? []).map((row) => row.details as Details)
  for (const booking of bundle.cr.effective?.bookings ?? []) {
    const trip = bookingSchedule(booking, reservations)
    if (booking.status === "cancelled") continue
    const kind = trip.kind
    const parts = [
      `${kind[0].toUpperCase()}${kind.slice(1)} ${trip.confirmed ? "booked" : "outcome unconfirmed"}${trip.simulated ? " (simulated)" : ""}: ${trip.origin ?? "origin unknown"} to ${trip.destination ?? "destination unknown"}`,
      trip.reference ? `booking ref ${trip.reference}` : null,
      trip.checkInCutoffAt ? `check-in cutoff ${utc(trip.checkInCutoffAt)}` : "check-in cutoff not recorded",
      trip.departureAt ? `departs ${utc(trip.departureAt)}` : "departure time not recorded",
      trip.arrivalAt ? `arrives ${utc(trip.arrivalAt)}` : null,
      `check-in ${trip.checkInConfirmed ? "confirmed" : "unconfirmed"}`,
    ].filter(Boolean)
    add(`travel_${kind}`, `${parts.join(", ")}.`, `${trip.sourceLabel}; ${trip.confirmed ? "a booking is not a boarding scan" : "do not treat this attempt as a confirmed booking"}`, trip.at)
  }

  const tracking = (related.tracking_observations ?? []).map((row) => row.details as Details)
    .sort((a, b) => String(b.observed_at).localeCompare(String(a.observed_at)))[0]
  if (tracking) {
    const remaining = num(tracking.distance_remaining_km)
    add("tracking", `Last app position report ${utc(tracking.observed_at)}${remaining !== null ? `: ${remaining.toLocaleString("en-GB")} km to go` : ""}${tracking.estimated_delivery_at ? `, app ETA ${utc(tracking.estimated_delivery_at)}` : ""}. Location quality ${String(tracking.location_quality ?? "unknown").toLowerCase()}, no exact position.`,
      `Tracking observation, ${String(tracking.source ?? "app").replace(/_/g, " ")}`, str(tracking.observed_at))
  }

  for (const row of related.order_endpoint_details ?? []) {
    const detail = row.details as Details
    const boundary = String(detail.boundary ?? "").toLowerCase()
    if (boundary === "pickup" && pickedUp) continue
    if (detail.access_instruction) {
      const status = String(detail.access_status ?? "unknown").toLowerCase().replace(/_/g, " ")
      add(`${boundary}_access`, `${boundary === "pickup" ? "Pickup" : "Delivery"} access note: ${detail.access_instruction} (status: ${status}).`,
        `Order endpoint detail, stated by ${String(detail.stated_by ?? "unknown").toLowerCase().replace(/_/g, " ")}`, str(detail.stated_at))
    }
    if (detail.contact_name) add(`${boundary}_contact`, `${boundary === "pickup" ? "Pickup" : "Delivery"} contact: ${detail.contact_name}, ${detail.contact_role ?? "contact"} (contact ${String(detail.contact_status ?? "unknown").toLowerCase()}).`, "Order endpoint detail", str(detail.last_confirmed_at))
  }
  const hours = deliverySite?.details.opening_hours as Details | undefined
  if (hours) add("delivery_hours", `Delivery site opening hours (local time): ${Object.entries(hours).map(([days, time]) => `${days.replace("_", "–")} ${time ?? "closed"}`).join(", ")}.`, "Site profile")

  for (const alert of alerts.filter((row) => row.status !== "RESOLVED")) {
    add(`alert_${alert.id}`, `Open alert: ${alert.summary} (an alert is a reason to look, not a diagnosis).`, `Alert, ${alert.severity.toLowerCase()}`, alert.triggeredAt.toISOString())
  }

  const hint = input.telemetryHint
  const at = simNow().toISOString()
  const telemetryFault = Boolean(hint && (hint.codes?.length || hint.milFlashing))
  if (hint?.codes?.length || hint?.milFlashing !== undefined) {
    add("obd", `The car's OBD dongle reports${hint.codes?.length ? ` trouble codes ${hint.codes.join(", ")}` : ""}${hint.milFlashing ? `${hint.codes?.length ? " and" : ""} a flashing check-engine light` : ""}${hint.note ? `, ${hint.note}` : ""}.`, "OBD dongle (simulated)", at)
  }
  if (hint?.place) add("gps", `Phone GPS puts the driver ${hint.place}.`, "Phone GPS (simulated)", at)

  const firstName = driverName?.split(" ")[0] ?? null
  return { orderId: order.id, orderRef: order.reference, driverId: input.driverId, driverName, firstName, vehicleLabel, facts, telemetryFault }
}
