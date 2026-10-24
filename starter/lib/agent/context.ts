// What the agent knows about an order, read from the dataset tables and our
// telemetry, and cut down to what each audience may see. Every fact carries a
// source the agent can cite and the control room can show as a chip.

import { and, asc, eq, inArray, sql } from "drizzle-orm"
import { crDb } from "@/lib/cr/db"
import { effectiveOrder, type EffectiveBooking, type EffectiveOrder } from "@/lib/cr/effective"
import { latestTelemetry } from "@/lib/cr/queries"
import { lifecycleOf, overlayAssignment, overlayReservation, overlayStatus } from "@/lib/cr/lifecycle"
import type { Audience, GpsData, ObdData, SourceRef } from "@/lib/cr/types"
import { addresses, alerts, conversations, customers, drivers, messages, orderItems, orders, relatedRecords, sites, vehicles } from "@/lib/schema"
import { firstName, localTime, money, relative, utcTime } from "./format"

export type Raw = Record<string, unknown>
export type End = "pickup" | "delivery"

const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null)
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null)

export type Endpoint = {
  end: End
  address: Raw
  site: Raw | null
  detail: Raw | null
  /** True when this end belongs to the paying customer (PLAN.md rule 1). */
  customerSide: boolean
  timezone: string | null
}

export type OrderFacts = {
  id: string
  reference: string
  status: string
  routeKind: string
  readiness: string | null
  customer: { id: string; name: string; country: string }
  vehicle: { id: string; make: string; model: string; year: number; fuel: string; registration: string | null; vin: string | null } | null
  pickup: Endpoint
  delivery: Endpoint
  windows: Raw[]
  assignments: Raw[]
  driverNames: Map<string, string>
  reservations: Raw[]
  options: Raw[]
  tracking: Raw[]
  alerts: Raw[]
  incidents: Raw[]
  workItems: Raw[]
  expenses: Raw[]
  openConversations: Raw[]
  /** Ferry terminal id → IANA time zone, for local departure times. */
  terminalZones: Map<string, string>
}

const RELATED = [
  "time_windows", "work_assignments", "travel_reservations", "travel_options", "tracking_observations", "incidents",
  "work_items", "expenses", "order_endpoint_details",
]

/**
 * A site counts as the customer when the order's customer owns it. A one-off
 * address has no owner on record: we treat the delivery end as the
 * customer's side (the buyer receives) and the pickup end as the seller's.
 */
export function isCustomerSide(end: End, site: Raw | null, customerId: string): boolean {
  if (site) return str(site.customer_id) === customerId
  return end === "delivery"
}

export async function loadOrderFacts(orderId: string): Promise<OrderFacts | null> {
  const db = crDb()
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1)
  if (!order) return null
  const [customerRows, itemRows, addressRows, related, alertRows, conversationRows, terminalRows, lifecycle] = await Promise.all([
    db.select().from(customers).where(eq(customers.id, order.customerId)).limit(1),
    db.select({ item: orderItems, vehicle: vehicles }).from(orderItems).innerJoin(vehicles, eq(orderItems.vehicleId, vehicles.id))
      .where(eq(orderItems.orderId, orderId)),
    db.select().from(addresses).where(inArray(addresses.id, [order.pickupAddressId, order.deliveryAddressId])),
    db.select().from(relatedRecords).where(and(eq(relatedRecords.orderId, orderId), inArray(relatedRecords.collection, RELATED))),
    db.select().from(alerts).where(eq(alerts.orderId, orderId)).orderBy(asc(alerts.triggeredAt)),
    db.select().from(conversations).where(and(eq(conversations.orderId, orderId), eq(conversations.status, "OPEN"))),
    db.select().from(relatedRecords).where(eq(relatedRecords.collection, "ferry_terminals")),
    lifecycleOf(orderId).catch(() => undefined),
  ])
  const siteIds = [order.pickupSiteId, order.deliverySiteId].filter((id): id is string => Boolean(id))
  const siteRows = siteIds.length ? await db.select().from(sites).where(inArray(sites.id, siteIds)) : []
  // The driver's reports in this app (collected, checked in, handed over) are laid over the snapshot.
  const overlay = (name: string, details: Raw): Raw => name === "work_assignments" ? overlayAssignment({ ...details, id: details.id ?? null }, lifecycle)
    : name === "travel_reservations" ? overlayReservation(details, lifecycle) : details
  const byCollection = (name: string) => related.filter((row) => row.collection === name).map((row) => overlay(name, row.details))

  const details = byCollection("order_endpoint_details")
  const endpoint = (end: End, addressId: string, siteId: string | null): Endpoint => {
    const addressRow = addressRows.find((row) => row.id === addressId)
    const siteRow = siteRows.find((row) => row.id === siteId)
    const site: Raw | null = siteRow ? { ...siteRow.details, id: siteRow.id, name: siteRow.name } : null
    const address: Raw = addressRow ? { ...addressRow.details, id: addressRow.id, name: addressRow.name, city: addressRow.city, country: addressRow.country } : {}
    return {
      end, address, site,
      detail: details.find((row) => row.boundary === end.toUpperCase()) ?? null,
      customerSide: isCustomerSide(end, site, order.customerId),
      timezone: str(address.timezone) ?? str(site?.timezone),
    }
  }

  const assignments = byCollection("work_assignments").filter((row) => row.status !== "CANCELLED")
  const driverIds = [...new Set(assignments.map((row) => str(row.driver_id)).filter((id): id is string => Boolean(id)))]
  const driverRows = driverIds.length ? await db.select().from(drivers).where(inArray(drivers.id, driverIds)) : []
  const primary = itemRows.find((row) => row.item.role === "PRIMARY") ?? itemRows[0]
  const customer = customerRows[0]
  const byTime = (field: string) => (a: Raw, b: Raw) => String(a[field] ?? "").localeCompare(String(b[field] ?? ""))

  return {
    id: order.id,
    reference: order.reference,
    status: overlayStatus(order.status, lifecycle),
    routeKind: order.routeKind,
    readiness: str(order.details.readiness_status),
    customer: { id: order.customerId, name: customer?.name ?? "Unknown customer", country: customer?.country ?? "" },
    vehicle: primary ? {
      id: primary.vehicle.id, make: primary.vehicle.make, model: primary.vehicle.model, year: primary.vehicle.modelYear,
      fuel: primary.vehicle.fuel, registration: primary.vehicle.registration, vin: primary.vehicle.syntheticVin,
    } : null,
    pickup: endpoint("pickup", order.pickupAddressId, order.pickupSiteId),
    delivery: endpoint("delivery", order.deliveryAddressId, order.deliverySiteId),
    windows: byCollection("time_windows"),
    assignments,
    driverNames: new Map(driverRows.map((row) => [row.id, row.displayName])),
    reservations: byCollection("travel_reservations").sort(byTime("departure_at")),
    options: byCollection("travel_options").sort(byTime("departure_at")),
    tracking: byCollection("tracking_observations").sort(byTime("observed_at")),
    alerts: alertRows.map((row) => row.details),
    incidents: byCollection("incidents"),
    workItems: byCollection("work_items"),
    expenses: byCollection("expenses").sort(byTime("submitted_at")),
    openConversations: conversationRows.map((row) => row.details),
    terminalZones: new Map(terminalRows.map((row) => [row.id, String(row.details.timezone ?? "UTC")])),
  }
}

/** The driver currently working this order: the started assignment first, then a booked one. */
export function activeDriverId(facts: OrderFacts): string | null {
  const rank = (row: Raw) => (row.status === "IN_PROGRESS" ? 0 : row.status === "ASSIGNED" ? 1 : 2)
  const live = facts.assignments.filter((row) => row.status === "IN_PROGRESS" || row.status === "ASSIGNED").sort((a, b) => rank(a) - rank(b))
  return str(live[0]?.driver_id)
}

/** The order a driver is working on now, if any: a started job first, then a booked one. */
export async function activeOrderForDriver(driverId: string): Promise<string | null> {
  const rows = await crDb().select({ orderId: relatedRecords.orderId, details: relatedRecords.details }).from(relatedRecords)
    .where(and(
      eq(relatedRecords.collection, "work_assignments"),
      sql`${relatedRecords.details}->>'driver_id' = ${driverId}`,
      sql`${relatedRecords.details}->>'status' in ('IN_PROGRESS', 'ASSIGNED')`,
    ))
  rows.sort((a, b) => (a.details.status === "IN_PROGRESS" ? 0 : 1) - (b.details.status === "IN_PROGRESS" ? 0 : 1))
  return rows[0]?.orderId ?? null
}

export async function driverName(driverId: string): Promise<string | null> {
  const [row] = await crDb().select({ name: drivers.displayName }).from(drivers).where(eq(drivers.id, driverId)).limit(1)
  return row?.name ?? null
}

// ---------------------------------------------------------------- reading out

const STATUS_WORDS: Record<string, string> = {
  NEW: "being prepared, no driver yet",
  WAITING_FOR_PICKUP: "driver booked, car not collected yet",
  IN_TRANSIT: "car collected and on its way",
  DELIVERED: "delivered",
}

const WINDOW_WORDS: Record<string, string> = {
  PICKUP_AVAILABILITY: "Pickup availability",
  SELECTED_PICKUP_SLOT: "Pickup slot",
  CUSTOMER_DELIVERY_PROMISE: "Delivery promise",
  REQUESTED_PICKUP_SLOT: "Requested pickup (a wish, not agreed)",
  REQUESTED_DELIVERY_SLOT: "Requested delivery (a wish, not agreed)",
  SELECTED_DELIVERY_SLOT: "Delivery slot",
}

const SOURCE_WORDS: Record<string, string> = {
  CUSTOMER: "set by the customer", OPS: "selected by operations", SYSTEM: "system estimate, not agreed", SITE: "from the site",
}

const CONFIRM_WORDS: Record<string, string> = {
  MANAGED_SITE_PROFILE: "the site's standard profile, not a call about this car",
  SITE_REPLY: "a reply from the site about this order",
  DRIVER_HANDOVER: "a driver's handover report",
  CUSTOMER_ORDER_INPUT: "the customer's order form",
  OPERATOR_CALL: "an operator's call",
}

function ref(kind: string, id: unknown, label: string, at?: unknown): SourceRef {
  return { kind, id: String(id ?? ""), label, at: str(at) }
}

function placeLine(endpoint: Endpoint): string {
  const a = endpoint.address
  const line = [str(a.address_line1), str(a.city), str(a.country)].filter(Boolean).join(", ")
  return line || "Address not recorded"
}

function endpointView(endpoint: Endpoint, audience: Audience) {
  const detail = endpoint.detail ?? {}
  const site = endpoint.site
  const confirmedBy = str(detail.last_confirmed_source)
  const view: Raw = {
    place: str(endpoint.address.name) ?? str(site?.name) ?? "One-off address",
    address: placeLine(endpoint),
    time_zone: endpoint.timezone,
    opening_hours: site?.opening_hours ?? endpoint.address.opening_hours ?? "not recorded",
    access_instruction: str(detail.access_instruction) ?? str(site?.[`${endpoint.end}_access_note`]) ?? "not recorded",
    access_status: str(detail.access_status) ?? "not recorded",
    contact: {
      name: str(detail.contact_name) ?? "not recorded",
      role: str(detail.contact_role),
      handle: audience === "site" ? null : str(detail.contact_handle),
      status: str(detail.contact_status) ?? "not recorded",
    },
    how_confirmed: confirmedBy ? (CONFIRM_WORDS[confirmedBy] ?? confirmedBy.toLowerCase().replace(/_/g, " ")) : "not confirmed for this order",
    confirmed_at: utcTime(str(detail.last_confirmed_at)),
    source: ref("order_endpoint_details", detail.id, `${endpoint.end === "pickup" ? "Pickup" : "Delivery"} details, ${confirmedBy ? CONFIRM_WORDS[confirmedBy] ?? "recorded" : "unconfirmed"}`, detail.stated_at),
  }
  if (site) {
    view.site_rules = {
      handover_mode: str(site.handover_mode),
      requires_signed_release: site.requires_signed_release ?? null,
      release_document_rule: str(site.release_document_rule),
      advance_notice_minutes: num(site.advance_notice_minutes),
    }
  }
  if (audience === "operator") view.belongs_to_customer = endpoint.customerSide
  return view
}

function windowView(row: Raw) {
  const purpose = str(row.purpose) ?? "WINDOW"
  const source = str(row.source)
  const zone = str(row.timezone)
  return {
    what: WINDOW_WORDS[purpose] ?? purpose,
    selected: row.is_selected === true,
    start: localTime(str(row.start_at), zone),
    end: localTime(str(row.end_at), zone),
    start_utc: str(row.start_at),
    end_utc: str(row.end_at),
    starts: relative(str(row.start_at)),
    set_by: source ? SOURCE_WORDS[source] ?? source.toLowerCase() : "source not recorded",
    source: ref("time_windows", row.id, `${WINDOW_WORDS[purpose] ?? "Window"}, ${source ? SOURCE_WORDS[source] ?? source.toLowerCase() : "source not recorded"}`),
  }
}

function reservationView(row: Raw, terminalZones: Map<string, string>) {
  const kind = str(row.kind) ?? "TRAVEL"
  const zone = terminalZones.get(str(row.origin_terminal_id) ?? "") ?? null
  return {
    kind: kind.toLowerCase(),
    status: str(row.status),
    note: "A booking is not a check-in or boarding. Only a terminal gate scan confirms check-in.",
    provider: str(row.provider),
    reference: str(row.booking_reference),
    from: str(row.origin_terminal) ?? str(row.from_city),
    to: str(row.destination_terminal) ?? str(row.to_city),
    departs: localTime(str(row.departure_at), zone) ?? utcTime(str(row.departure_at)),
    departs_utc: str(row.departure_at),
    departs_in: relative(str(row.departure_at)),
    check_in_closes: localTime(str(row.check_in_cutoff_at), zone),
    check_in_closes_utc: str(row.check_in_cutoff_at),
    arrives_utc: str(row.expected_arrival_at),
    check_in_confirmed: str(row.check_in_confirmation),
    boarding_confirmed: str(row.boarding_confirmation),
    source: ref("travel_reservations", row.id, `${kind.toLowerCase()} booking ${str(row.booking_reference) ?? ""}`.trim(), row.booked_at),
  }
}

/**
 * Travel as it stands: the dataset's reservations (one replaced by a confirmed Road Desk booking says so) and the
 * bookings an operator approved here, with the times of the quote that was booked. A quote is never in this list.
 */
function bookingsView(facts: OrderFacts, effective: EffectiveOrder, rows: Raw[]) {
  const current = new Set(effective.bookings.filter((booking) => booking.source.kind === "travel_reservations").map((booking) => booking.source.id))
  const ours = effective.bookings.filter((booking) => booking.source.kind === "cr_effects")
  return [
    ...rows.map((row) => {
      const view = reservationView(row, facts.terminalZones)
      if (current.has(String(row.id))) return view
      const by = ours.find((booking) => booking.replacesReservationId === String(row.id))
      return { ...view, status: `REPLACED${by?.reference ? ` by Road Desk booking ${by.reference}` : ""}` }
    }),
    ...ours.map((booking) => roadDeskBookingView(booking, facts.terminalZones)),
  ]
}

function roadDeskBookingView(booking: EffectiveBooking, terminalZones: Map<string, string>) {
  const selection = booking.selection
  const zone = [...terminalZones.values()][0] ?? null
  return {
    kind: booking.kind,
    status: booking.status,
    note: "Booked through Road Desk after an operator's approval (simulated). A booking is not a check-in or boarding.",
    provider: booking.provider,
    reference: booking.reference,
    from: selection?.from ?? null,
    to: selection?.to ?? null,
    departs: localTime(selection?.departure_at ?? null, zone) ?? utcTime(selection?.departure_at ?? null),
    departs_utc: selection?.departure_at ?? null,
    departs_in: relative(selection?.departure_at ?? null),
    check_in_closes: localTime(selection?.check_in_cutoff_at ?? null, zone),
    check_in_closes_utc: selection?.check_in_cutoff_at ?? null,
    arrives_utc: selection?.arrival_at ?? null,
    replaces: booking.replacesReservationId,
    source: booking.source,
  }
}

function optionView(row: Raw) {
  return {
    kind: str(row.kind)?.toLowerCase(),
    status: str(row.status),
    note: "A quote, not a booking. Availability may have changed since it was checked.",
    provider: str(row.provider),
    from: str(row.from_city), to: str(row.to_city),
    departs_utc: str(row.departure_at),
    arrives_utc: str(row.arrival_at),
    price: money(row.quote_cents, row.currency),
    capacity_note: str(row.capacity_note),
    checked: relative(str(row.checked_at)),
    source: ref("travel_options", row.id, `${str(row.kind)?.toLowerCase() ?? "travel"} quote, checked ${utcTime(str(row.checked_at)) ?? "at an unknown time"}`, row.checked_at),
  }
}

function trackingView(row: Raw | undefined) {
  if (!row) return null
  return {
    observed: utcTime(str(row.observed_at)),
    age: relative(str(row.observed_at)),
    received: utcTime(str(row.received_at)),
    progress_percent: num(row.progress_fraction) !== null ? Math.round((row.progress_fraction as number) * 100) : null,
    distance_remaining_km: num(row.distance_remaining_km),
    app_estimate_of_delivery_utc: str(row.estimated_delivery_at),
    quality: str(row.location_quality),
    note: "Coarse driver-app progress. It has no coordinates and is not a verified location.",
    source: ref("tracking_observations", row.id, `Driver app progress, ${utcTime(str(row.observed_at))}`, row.observed_at),
  }
}

export async function telemetryView(orderId: string) {
  const [gps, obd] = await Promise.all([latestTelemetry(orderId, "PHONE_GPS"), latestTelemetry(orderId, "OBD")])
  const gpsData = gps?.data as GpsData | undefined
  const obdData = obd?.data as ObdData | undefined
  return {
    phone_position: gps && gpsData ? {
      lat: gpsData.lat, lng: gpsData.lng, place: gpsData.place_label ?? null, speed_kmh: gpsData.speed_kmh ?? null,
      at: utcTime(gps.at), age: relative(gps.at),
      note: gps.simulated ? "Simulated phone GPS for this demo, not a verified position." : "Phone GPS.",
      source: ref("cr_telemetry", gps.id, `${gps.simulated ? "Simulated phone GPS" : "Phone GPS"}, ${utcTime(gps.at)}`, gps.at.toISOString()),
    } : null,
    car_status: obd && obdData ? {
      check_engine_light: obdData.mil, trouble_codes: obdData.dtcs ?? [], speed_kmh: obdData.speed_kmh ?? null,
      at: utcTime(obd.at), age: relative(obd.at),
      source: ref("cr_telemetry", obd.id, `OBD dongle, ${utcTime(obd.at)}`, obd.at.toISOString()),
    } : null,
  }
}

function journeyStart(assignment: Raw | null) {
  const started = str(assignment?.started_at)
  return started
    ? { recorded: true, at: utcTime(started), text: `Journey start recorded ${relative(started)}` }
    : { recorded: false, at: null, text: "No journey start is recorded yet. That does not prove the driver has not set off." }
}

function promiseView(effective: EffectiveOrder, audience: Audience) {
  const promise = effective.promise
  if (!promise) return null
  return {
    start_utc: promise.start_utc, end_utc: promise.end_utc, zone: promise.zone,
    start: localTime(promise.start_utc, promise.zone), end: localTime(promise.end_utc, promise.zone),
    basis: promise.basis, source: promise.source,
    ...(audience === "operator" ? {
      pending_changes: promise.pending.map((entry) => ({ ...entry, note: "Proposed to the customer, not agreed. The promise above still stands." })),
      history: promise.history,
    } : {}),
  }
}

/**
 * What a pickup or delivery place may know about this order: its own end's
 * timing, the driver's first name, the vehicle and plate, and where the
 * driver is if we know. Never customer details, prices, conversations or
 * other orders (PLAN.md 4.2).
 */
export async function getSiteContext(facts: OrderFacts, end: End) {
  const endpoint = end === "pickup" ? facts.pickup : facts.delivery
  const driverId = activeDriverId(facts)
  const driver = driverId ? facts.driverNames.get(driverId) ?? null : null
  const assignment = facts.assignments.find((row) => row.driver_id === driverId) ?? null
  const telemetry = await telemetryView(facts.id)
  const effective = await effectiveOrder(facts.id)
  const slot = end === "pickup" ? facts.windows.find((row) => row.purpose === "SELECTED_PICKUP_SLOT" && row.is_selected === true) : null
  const vehicle = facts.vehicle
  return {
    order: facts.reference,
    your_end: end,
    place: endpointView(endpoint, "site").place,
    vehicle: vehicle ? { make: vehicle.make, model: vehicle.model, plate: vehicle.registration ?? "not recorded" } : null,
    driver_first_name: firstName(driver),
    driver_booking: assignment ? { status: str(assignment.status) === "IN_PROGRESS" ? "on the job" : str(assignment.status) === "ASSIGNED" ? "booked" : str(assignment.status)?.toLowerCase(), source: ref("work_assignments", assignment.id, "Driver booking", assignment.accepted_at) } : null,
    journey_start: journeyStart(assignment),
    planned_window: end === "pickup" ? (slot ? windowView(slot) : null) : promiseView(effective, "site"),
    latest_driver_position: telemetry.phone_position,
    may_not_share: "Prices, other orders, the customer's details, conversations, internal notes.",
    this_site_is_the_customer: endpoint.customerSide,
  }
}

function commonView(facts: OrderFacts, audience: "driver" | "operator", driverId: string | null) {
  const vehicle = facts.vehicle
  const driver = driverId ? facts.driverNames.get(driverId) ?? null : null
  const assignment = facts.assignments.find((row) => row.driver_id === driverId) ?? null
  return {
    order: {
      reference: facts.reference,
      stage: STATUS_WORDS[facts.status] ?? facts.status,
      route: `${placeLine(facts.pickup)} → ${placeLine(facts.delivery)}`,
      route_kind: facts.routeKind === "IMPORT" ? "cross-border import" : "domestic",
      source: ref("orders", facts.id, `Order ${facts.reference}`),
    },
    vehicle: vehicle ? {
      make: vehicle.make, model: vehicle.model, year: vehicle.year, fuel: vehicle.fuel,
      plate: vehicle.registration ?? "not recorded", vin: vehicle.vin ?? "not recorded",
      source: ref("vehicles", vehicle.id, `Vehicle record, ${vehicle.make} ${vehicle.model}`),
    } : null,
    pickup: endpointView(facts.pickup, audience),
    delivery: endpointView(facts.delivery, audience),
    driver: driver ? {
      name: driver, job_status: str(assignment?.status), journey_start: journeyStart(assignment),
      source: ref("work_assignments", assignment?.id, `Driver booking, ${driver}`, assignment?.accepted_at),
    } : null,
    last_driver_app_progress: trackingView(facts.tracking.at(-1)),
  }
}

/**
 * What the driver on this order may know: their own job, route, access
 * notes, keys, their travel bookings, the car's status. No customer account
 * details, prices, conversations or other orders.
 */
export async function getDriverContext(facts: OrderFacts, driverId: string | null) {
  const id = driverId ?? activeDriverId(facts)
  const [telemetry, effective, earlier] = await Promise.all([telemetryView(facts.id), effectiveOrder(facts.id),
    crDb().select().from(messages).where(eq(messages.orderId, facts.id)).orderBy(asc(messages.authoredAt))])
  const assignmentIds = new Set(facts.assignments.filter((row) => row.driver_id === id).map((row) => String(row.id)))
  const pickupSlot = facts.windows.find((row) => row.purpose === "SELECTED_PICKUP_SLOT" && row.is_selected === true)
  return {
    ...commonView(facts, "driver", id),
    your_pickup_slot: pickupSlot ? windowView(pickupSlot) : null,
    delivery_window: promiseView(effective, "driver"),
    your_travel_bookings: bookingsView(facts, effective, facts.reservations
      .filter((row) => !row.assignment_id || facts.assignments.some((a) => a.id === row.assignment_id && a.driver_id === id)))
      .map(({ replaces: _replaces, ...view }: Record<string, unknown>) => view),
    // What already happened on this job, so the agent does not ask the driver to tell it again.
    your_open_issues: facts.incidents.filter((row) => row.status !== "RESOLVED" && (!row.assignment_id || assignmentIds.has(String(row.assignment_id)))).map((row) => ({
      what: str(row.kind)?.toLowerCase().replace(/_/g, " "), you_reported: str(row.reported_symptom), where_you_said: str(row.reported_stop_text),
      opened: utcTime(str(row.opened_at)), location_verified: row.location_verified === true,
      decision: row.recovery_decision === "PENDING_CUSTOMER" ? "operations is waiting for the car owner's decision on recovery" : str(row.recovery_decision)?.toLowerCase().replace(/_/g, " ") ?? null,
      dashboard_photo: row.warning_photo_status === "REQUESTED" ? "requested, not received" : str(row.warning_photo_status)?.toLowerCase() ?? null,
      source: ref("incidents", row.id, `Incident, ${str(row.kind)?.toLowerCase().replace(/_/g, " ")}`, row.opened_at),
    })),
    your_earlier_messages_with_bahn: earlier.filter((row) => {
      const details = row.details as Raw
      if (details.visibility && details.visibility !== "PUBLIC") return false
      return (row.authorType === "driver" && details.author_id === id) || (details.recipient_type === "driver" && details.recipient_id === id)
    }).slice(-8).map((row) => ({
      at: utcTime(row.authoredAt.toISOString()), from: row.authorType === "driver" ? "you" : "Bahn", text: row.body.slice(0, 300),
      source: ref("messages", row.id, `${row.authorType === "driver" ? "Driver" : "Bahn"} message, ${utcTime(row.authoredAt.toISOString())}`, row.authoredAt.toISOString()),
    })),
    phone_position: telemetry.phone_position,
    car_status: telemetry.car_status,
    your_expense_claims: facts.expenses.filter((row) => row.driver_id === id).map((row) => ({
      kind: str(row.kind), status: str(row.status), submitted: utcTime(str(row.submitted_at)), receipt: str(row.receipt_state),
      note: row.status === "APPROVED" ? "Approved is not paid." : null,
      source: ref("expenses", row.id, `Expense claim, ${str(row.kind)?.toLowerCase()}`, row.submitted_at),
    })),
  }
}

/** Everything on the order for operations, with sources, read through the effective state. */
export async function getOperatorContext(facts: OrderFacts) {
  const driverId = activeDriverId(facts)
  const assignment = facts.assignments.find((row) => row.driver_id === driverId) ?? null
  const [telemetry, effective] = await Promise.all([telemetryView(facts.id), effectiveOrder(facts.id)])
  const windows = facts.windows.filter((row) => row.is_selected === true || String(row.purpose).startsWith("REQUESTED"))
  return {
    ...commonView(facts, "operator", driverId),
    customer: {
      name: facts.customer.name,
      country: facts.customer.country,
      rule: "The customer pays Bahn. The agent never contacts them directly; use a CONTACT_CUSTOMER proposal.",
      source: ref("customers", facts.customer.id, `Customer account, ${facts.customer.name}`),
    },
    delivery_promise: promiseView(effective, "operator"),
    windows: windows.map(windowView),
    eta_estimate: effective.eta,
    travel_bookings: bookingsView(facts, effective, facts.reservations),
    travel_quotes: facts.options.map(optionView),
    driver_fee: money(assignment?.fee_cents, assignment?.currency),
    phone_position: telemetry.phone_position,
    car_status: telemetry.car_status,
    open_records: {
      alerts: facts.alerts.filter((row) => row.status !== "RESOLVED" && row.status !== "DISMISSED").map((row) => ({
        summary: str(row.summary), status: str(row.status), severity: str(row.severity), raised: relative(str(row.triggered_at)),
        note: "An alert is a reason to look, not a diagnosis.",
        source: ref("alerts", row.id, `Alert, ${str(row.signal)?.toLowerCase().replace(/_/g, " ")}`, row.triggered_at),
      })),
      incidents: facts.incidents.filter((row) => row.status !== "RESOLVED").map((row) => ({
        kind: str(row.kind), status: str(row.status), opened: relative(str(row.opened_at)),
        source: ref("incidents", row.id, `Incident, ${str(row.kind)?.toLowerCase().replace(/_/g, " ")}`, row.opened_at),
      })),
      work_items: facts.workItems.filter((row) => row.status !== "DONE").map((row) => ({
        summary: str(row.summary), next_action: str(row.next_action), owner: str(row.owner), due: relative(str(row.due_at)),
        source: ref("work_items", row.id, "Open work item", row.created_at),
      })),
      open_conversations: facts.openConversations.map((row) => ({
        topic: str(row.category)?.replace(/_/g, " "), waiting_on: str(row.waiting_on), owner: str(row.owner),
        source: ref("conversations", row.id, `Conversation, ${str(row.category)?.replace(/_/g, " ")}`, row.updated_at),
      })),
    },
    expense_claims: facts.expenses.map((row) => ({
      kind: str(row.kind), amount: money(row.amount_cents, row.currency), status: str(row.status), payer: str(row.payer),
      submitted: utcTime(str(row.submitted_at)), receipt: str(row.receipt_state),
      source: ref("expenses", row.id, `Expense claim, ${str(row.kind)?.toLowerCase()}`, row.submitted_at),
    })),
  }
}

/** The order read out for one audience. */
export async function contextFor(audience: Audience, facts: OrderFacts, options: { siteEnd?: End | null; driverId?: string | null } = {}) {
  if (audience === "site") return getSiteContext(facts, options.siteEnd ?? "pickup")
  if (audience === "driver") return getDriverContext(facts, options.driverId ?? null)
  return getOperatorContext(facts)
}

/**
 * Open dataset records on an order that a new case takes over (PLAN.md 4.1,
 * "Linking imported work"), so the queue shows one row for the order.
 */
export function linkedRecordsOf(facts: OrderFacts): SourceRef[] {
  return [
    ...facts.workItems.filter((row) => row.status !== "DONE").map((row) => ref("work_items", row.id, `Work item: ${str(row.summary) ?? "open"}`, row.created_at)),
    ...facts.incidents.filter((row) => row.status !== "RESOLVED").map((row) => ref("incidents", row.id, `Incident: ${str(row.kind)?.toLowerCase().replace(/_/g, " ")}`, row.opened_at)),
    ...facts.alerts.filter((row) => row.status !== "RESOLVED" && row.status !== "DISMISSED").map((row) => ref("alerts", row.id, `Alert: ${str(row.summary) ?? ""}`, row.triggered_at)),
  ]
}
