// The moving fleet as the simulator sees it: one car per in-progress driver
// assignment, with its route shape, ferry booking and the last position the
// driver app reported in the dataset. Read once from the database and cached;
// the dataset does not change while the app runs.

import { and, eq, inArray } from "drizzle-orm"
import { crDb } from "@/lib/cr/db"
import { addresses, alerts, drivers, orderItems, orders, relatedRecords, vehicles } from "@/lib/schema"
import { cityPoint, legKey, polylineKm, seaKey, terminalPoint, type LatLng } from "./geo"
import { roadLeg, seaLane } from "./routes"

export type Fuel = "petrol" | "diesel" | "hybrid" | "electric"

/** One stretch of the route. `kind: "sea"` is the ferry crossing. */
export type RoutePart = { kind: "road" | "sea"; label: string; coords: LatLng[]; startKm: number; km: number }

export type Ferry = {
  reservationId: string
  bookingReference: string | null
  originName: string
  destinationName: string
  checkInCutoffAt: Date | null
  departureAt: Date
  arrivalAt: Date
}

/**
 * How the driver's phone behaves in the simulation.
 * LIVE: reports every minute. STALE: the dataset shows a gap; we keep only the
 * last reported point. NONE: the app never reported a position for this trip.
 */
export type PhoneState = "LIVE" | "STALE" | "NONE"

export type FleetCar = {
  orderId: string
  reference: string
  assignmentId: string
  segmentId: string
  vehicleId: string
  vehicleTitle: string
  fuel: Fuel
  driverId: string
  driverName: string
  fromCity: string
  toCity: string
  parts: RoutePart[]
  pathKm: number
  ferry: Ferry | null
  lastObservation: { id: string; at: Date; progress: number } | null
  phone: PhoneState
  /** Why the phone is stale, in words, when it is. */
  phoneNote: string | null
  /** Set when the dataset says the car is stopped (an open safety stop). It does not move in the sim. */
  stoppedNote: string | null
  /** Cruising speed for this car, km/h. */
  cruiseKmh: number
  /** For a few cars the phone goes quiet during the demo, on purpose. */
  quietFrom: Date | null
}

type Row = Record<string, unknown>
const str = (value: unknown) => (typeof value === "string" ? value : value == null ? "" : String(value))
const date = (value: unknown) => (value ? new Date(String(value)) : null)

/** A phone whose last report is older than this at the snapshot counts as stale. */
const STALE_AFTER_MS = 3 * 60 * 60 * 1000

/** Phones that go quiet a few minutes into the demo, so the map shows "last seen n min ago". */
const GOES_QUIET: Record<string, number> = { "CD-420710": 4, "CD-420576": 11 }

const holder = globalThis as unknown as { __simFleet?: { at: number; cars: FleetCar[] } }

export async function loadFleet(options: { fresh?: boolean } = {}): Promise<FleetCar[]> {
  if (!options.fresh && holder.__simFleet && Date.now() - holder.__simFleet.at < 10 * 60 * 1000) return holder.__simFleet.cars
  const cars = await readFleet()
  holder.__simFleet = { at: Date.now(), cars }
  return cars
}

export async function fleetCar(orderRefOrId: string): Promise<FleetCar | null> {
  const key = orderRefOrId.trim().toUpperCase()
  return (await loadFleet()).find((car) => car.reference === key || car.orderId.toUpperCase() === key) ?? null
}

async function related(collection: string, orderIds?: string[]): Promise<Row[]> {
  const where = orderIds
    ? and(eq(relatedRecords.collection, collection), inArray(relatedRecords.orderId, orderIds))
    : eq(relatedRecords.collection, collection)
  return (await crDb().select({ details: relatedRecords.details }).from(relatedRecords).where(where)).map((row) => row.details)
}

async function readFleet(): Promise<FleetCar[]> {
  const db = crDb()
  const assignments = (await related("work_assignments")).filter((row) => row.status === "IN_PROGRESS")
  if (assignments.length === 0) return []
  const orderIds = [...new Set(assignments.map((row) => str(row.order_id)))]
  const [orderRows, segments, points, reservations, observations, incidents, alertRows, itemRows, driverRows] = await Promise.all([
    db.select().from(orders).where(inArray(orders.id, orderIds)),
    related("transport_segments", orderIds),
    related("transport_points", orderIds),
    related("travel_reservations", orderIds),
    related("tracking_observations", orderIds),
    related("incidents", orderIds),
    db.select().from(alerts).where(inArray(alerts.orderId, orderIds)),
    db.select({ item: orderItems, vehicle: vehicles }).from(orderItems).innerJoin(vehicles, eq(orderItems.vehicleId, vehicles.id))
      .where(inArray(orderItems.orderId, orderIds)),
    db.select().from(drivers),
  ])
  const addressIds = [...new Set(points.map((row) => str(row.address_id)))]
  const addressRows = await db.select().from(addresses).where(inArray(addresses.id, addressIds))
  const addressById = new Map(addressRows.map((row) => [row.id, row]))
  const pointById = new Map(points.map((row) => [str(row.id), row]))
  const segmentById = new Map(segments.map((row) => [str(row.id), row]))
  const orderById = new Map(orderRows.map((row) => [row.id, row]))
  const driverById = new Map(driverRows.map((row) => [row.id, row]))
  const snapshot = simStart()
  const cars: FleetCar[] = []

  for (const assignment of assignments) {
    const order = orderById.get(str(assignment.order_id))
    const segmentId = (assignment.segment_ids as string[] | undefined)?.find((id) => segmentById.has(id))
    const segment = segmentId ? segmentById.get(segmentId) : undefined
    if (!order || !segment || !segmentId) continue
    const from = addressById.get(str(pointById.get(str(segment.from_point_id))?.address_id))
    const to = addressById.get(str(pointById.get(str(segment.to_point_id))?.address_id))
    const item = itemRows.find((row) => row.item.id === segment.order_item_id)
    const driver = driverById.get(str(assignment.driver_id))
    if (!from || !to || !item || !driver) continue

    const ferryRow = segment.transport_mode === "DRIVE_WITH_FERRY"
      ? reservations.find((row) => row.kind === "FERRY" && row.status === "BOOKED" && row.order_id === order.id)
      : undefined
    const parts = buildParts(from.city, from.country, to.city, to.country, ferryRow)
    if (!parts) continue
    const ferry: Ferry | null = ferryRow ? {
      reservationId: str(ferryRow.id),
      bookingReference: ferryRow.booking_reference ? str(ferryRow.booking_reference) : null,
      originName: str(ferryRow.origin_terminal),
      destinationName: str(ferryRow.destination_terminal),
      checkInCutoffAt: date(ferryRow.check_in_cutoff_at),
      departureAt: date(ferryRow.departure_at)!,
      arrivalAt: date(ferryRow.expected_arrival_at)!,
    } : null

    const observed = observations
      .filter((row) => row.assignment_id === assignment.id || (!row.assignment_id && row.order_id === order.id))
      .sort((a, b) => str(a.observed_at).localeCompare(str(b.observed_at)))
    const last = observed.at(-1)
    const lastObservation = last ? { id: str(last.id), at: new Date(str(last.observed_at)), progress: Number(last.progress_fraction) } : null
    const gapAlert = alertRows.find((row) => row.orderId === order.id && row.signal === "TRACKING_GAP" && row.status !== "RESOLVED" && row.status !== "DISMISSED")
    const safetyStop = alertRows.find((row) => row.orderId === order.id && row.signal === "SAFETY_STOP" && row.status !== "RESOLVED" && row.status !== "DISMISSED")
    const openWarning = incidents.find((row) => row.order_id === order.id && row.kind === "VEHICLE_WARNING" && !row.resolved_at)

    let phone: PhoneState = "LIVE"
    let phoneNote: string | null = null
    if (!lastObservation) {
      phone = "NONE"
      phoneNote = "The driver app has not reported a position on this trip."
    } else if (gapAlert) {
      phone = "STALE"
      phoneNote = "No new position from the driver app since the last report (open tracking-gap alert)."
    } else if (snapshot.getTime() - lastObservation.at.getTime() > STALE_AFTER_MS) {
      phone = "STALE"
      phoneNote = "The driver app has not reported for several hours."
    }
    const quietMinutes = GOES_QUIET[order.reference]
    cars.push({
      orderId: order.id,
      reference: order.reference,
      assignmentId: str(assignment.id),
      segmentId,
      vehicleId: item.vehicle.id,
      vehicleTitle: `${item.vehicle.make} ${item.vehicle.model}`,
      fuel: (["petrol", "diesel", "hybrid", "electric"].includes(item.vehicle.fuel) ? item.vehicle.fuel : "petrol") as Fuel,
      driverId: driver.id,
      driverName: driver.displayName,
      fromCity: from.city,
      toCity: to.city,
      parts,
      pathKm: parts.reduce((sum, part) => sum + part.km, 0),
      ferry,
      lastObservation,
      phone,
      phoneNote,
      stoppedNote: safetyStop || openWarning ? "The driver reported a safety stop; the car is not moving." : null,
      cruiseKmh: 78 + (hash(order.id) % 15),
      quietFrom: phone === "LIVE" && quietMinutes ? new Date(snapshot.getTime() + quietMinutes * 60_000) : null,
    })
  }
  return cars.sort((a, b) => a.reference.localeCompare(b.reference))
}

function buildParts(fromCity: string, fromCountry: string, toCity: string, toCountry: string, ferry: Row | undefined): RoutePart[] | null {
  const fromId = `city:${fromCity}|${fromCountry}`
  const toId = `city:${toCity}|${toCountry}`
  const chain: Omit<RoutePart, "startKm">[] = []
  const road = (a: string, b: string, aLabel: string, bLabel: string, aPoint: LatLng | null, bPoint: LatLng | null) => {
    const leg = roadLeg(legKey(a, b))
    if (leg) return { kind: "road" as const, label: `${aLabel} to ${bLabel}`, coords: leg.coords, km: leg.km }
    if (!aPoint || !bPoint) return null
    // No stored shape: a straight line on land, still labelled simulated.
    return { kind: "road" as const, label: `${aLabel} to ${bLabel}`, coords: [aPoint, bPoint], km: polylineKm([aPoint, bPoint]) * 1.25 }
  }
  if (ferry) {
    const originId = str(ferry.origin_terminal_id)
    const destinationId = str(ferry.destination_terminal_id)
    const origin = terminalPoint(originId)
    const destination = terminalPoint(destinationId)
    const lane = seaLane(seaKey(originId, destinationId))
    if (!origin || !destination || !lane) return null
    const first = road(fromId, `terminal:${originId}`, fromCity, origin.name, cityPoint(fromCity, fromCountry), origin.point)
    const last = road(`terminal:${destinationId}`, toId, destination.name, toCity, destination.point, cityPoint(toCity, toCountry))
    if (!first || !last) return null
    chain.push(first, { kind: "sea", label: `Ferry, ${origin.name} to ${destination.name}`, coords: lane.coords, km: lane.km }, last)
  } else {
    const only = road(fromId, toId, fromCity, toCity, cityPoint(fromCity, fromCountry), cityPoint(toCity, toCountry))
    if (!only) return null
    chain.push(only)
  }
  let startKm = 0
  return chain.map((part) => {
    const placed = { ...part, startKm }
    startKm += part.km
    return placed
  })
}

/** Where the sim clock starts (and restarts on reset): the dataset snapshot unless SIM_NOW says otherwise. */
export function simStart(): Date {
  const parsed = Date.parse(process.env.SIM_NOW ?? "2026-10-21T09:00:00Z")
  return new Date(Number.isFinite(parsed) ? parsed : Date.parse("2026-10-21T09:00:00Z"))
}

/** Small stable hash for per-car variation. */
export function hash(text: string): number {
  let value = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index)
    value = Math.imul(value, 16777619)
  }
  return value >>> 0
}
