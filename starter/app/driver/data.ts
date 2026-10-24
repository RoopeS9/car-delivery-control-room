// Server-side reads for the driver app: who has work, one driver's jobs, and
// the thread a driver may see. A driver sees only their own assignments and
// messages addressed to them or written by them; never internal notes,
// customer mail or other drivers' work.

import { and, asc, eq, inArray, or } from "drizzle-orm"
import { crDb } from "@/lib/cr/db"
import { crEvents } from "@/lib/cr/schema"
import type { PhotoData } from "@/lib/cr/types"
import { addresses, drivers, messages, orderItems, orders, relatedRecords, sites, vehicles } from "@/lib/schema"

type Row = Record<string, unknown>
const str = (value: unknown) => (typeof value === "string" ? value : value == null ? null : String(value))

export type Stop = {
  boundary: "PICKUP" | "DELIVERY"
  name: string
  city: string
  addressLine: string | null
  timezone: string
  /** What to do on arrival, with where that instruction comes from. */
  instruction: string | null
  instructionSource: string | null
  contactName: string | null
  contactRole: string | null
  hours: string | null
}

export type Window = { startAt: string; endAt: string; timezone: string; source: string | null }

export type DriverJob = {
  assignmentId: string
  status: "IN_PROGRESS" | "ASSIGNED"
  orderId: string
  reference: string
  vehicle: { title: string; year: number; fuel: string; plate: string | null }
  pickup: Stop
  delivery: Stop
  pickupSlot: Window | null
  deliveryPromise: Window | null
  ferry: {
    origin: string; destination: string; timezone: string; departureAt: string; checkInCutoffAt: string | null
    bookingReference: string | null; checkInConfirmed: boolean
  } | null
}

export type DriverListing = { id: string; name: string; homeCity: string; jobs: { reference: string; status: DriverJob["status"]; vehicle: string; route: string }[] }

export type ThreadMessage = {
  id: string
  at: string
  from: "me" | "agent" | "operator" | "system"
  fromName: string
  kind: "message" | "safety" | "photo_request" | "photo"
  text: string
  voice: boolean
  /** Data URL for a photo the driver sent, when small enough to show inline. */
  photo: string | null
  photoSubject: string | null
  /** "Earlier, before Road Desk" for dataset messages; null for ours. */
  origin: "dataset" | null
}

async function related(collection: string, where?: { orderIds?: string[] }): Promise<Row[]> {
  const db = crDb()
  const filter = where?.orderIds
    ? and(eq(relatedRecords.collection, collection), inArray(relatedRecords.orderId, where.orderIds))
    : eq(relatedRecords.collection, collection)
  return (await db.select({ details: relatedRecords.details }).from(relatedRecords).where(filter)).map((row) => row.details)
}

const ACTIVE = ["IN_PROGRESS", "ASSIGNED"]

/** Drivers with work today or coming up, moving drivers first. Each job names the car and leg this driver moves. */
export async function listDrivers(): Promise<DriverListing[]> {
  const assignments = (await related("work_assignments")).filter((row) => ACTIVE.includes(String(row.status)))
  const orderIds = [...new Set(assignments.map((row) => String(row.order_id)))]
  const db = crDb()
  const [driverRows, orderRows, itemRows, segments, points, addressRows] = await Promise.all([
    db.select().from(drivers),
    db.select().from(orders).where(inArray(orders.id, orderIds)),
    db.select({ id: orderItems.id, make: vehicles.make, model: vehicles.model }).from(orderItems)
      .innerJoin(vehicles, eq(orderItems.vehicleId, vehicles.id)).where(inArray(orderItems.orderId, orderIds)),
    related("transport_segments", { orderIds }),
    related("transport_points", { orderIds }),
    db.select({ id: addresses.id, city: addresses.city }).from(addresses),
  ])
  const orderById = new Map(orderRows.map((row) => [row.id, row]))
  const cityOfAddress = new Map(addressRows.map((row) => [row.id, row.city]))
  const cityOfPoint = (pointId: unknown) => cityOfAddress.get(String(points.find((row) => row.id === pointId)?.address_id)) ?? "?"
  const listings = new Map<string, DriverListing>()
  for (const assignment of assignments) {
    const driver = driverRows.find((row) => row.id === assignment.driver_id)
    const order = orderById.get(String(assignment.order_id))
    const segment = segments.find((row) => (assignment.segment_ids as string[]).includes(String(row.id)))
    if (!driver || !order || !segment) continue
    const car = itemRows.find((row) => row.id === segment.order_item_id)
    const entry = listings.get(driver.id) ?? { id: driver.id, name: driver.displayName, homeCity: driver.homeCity, jobs: [] }
    entry.jobs.push({
      reference: order.reference,
      status: assignment.status as DriverJob["status"],
      vehicle: car ? `${car.make} ${car.model}` : "Car",
      route: `${cityOfPoint(segment.from_point_id)} to ${cityOfPoint(segment.to_point_id)}`,
    })
    listings.set(driver.id, entry)
  }
  const moving = (listing: DriverListing) => listing.jobs.some((job) => job.status === "IN_PROGRESS") ? 0 : 1
  for (const listing of listings.values()) listing.jobs.sort((a, b) => (a.status === "IN_PROGRESS" ? 0 : 1) - (b.status === "IN_PROGRESS" ? 0 : 1))
  return [...listings.values()].sort((a, b) => moving(a) - moving(b) || a.name.localeCompare(b.name))
}

export async function loadDriver(driverId: string): Promise<{ id: string; name: string; homeCity: string; jobs: DriverJob[] } | null> {
  const db = crDb()
  const [driver] = await db.select().from(drivers).where(eq(drivers.id, driverId)).limit(1)
  if (!driver) return null
  const assignments = (await related("work_assignments")).filter((row) => row.driver_id === driverId && ACTIVE.includes(String(row.status)))
  const orderIds = [...new Set(assignments.map((row) => String(row.order_id)))]
  if (orderIds.length === 0) return { id: driver.id, name: driver.displayName, homeCity: driver.homeCity, jobs: [] }
  const [orderRows, segments, points, windows, endpoints, reservations, terminals, itemRows] = await Promise.all([
    db.select().from(orders).where(inArray(orders.id, orderIds)),
    related("transport_segments", { orderIds }),
    related("transport_points", { orderIds }),
    related("time_windows", { orderIds }),
    related("order_endpoint_details", { orderIds }),
    related("travel_reservations", { orderIds }),
    related("ferry_terminals"),
    db.select({ item: orderItems, vehicle: vehicles }).from(orderItems).innerJoin(vehicles, eq(orderItems.vehicleId, vehicles.id))
      .where(inArray(orderItems.orderId, orderIds)),
  ])
  const addressIds = points.map((row) => String(row.address_id))
  const [addressRows, siteRows] = await Promise.all([
    db.select().from(addresses).where(inArray(addresses.id, addressIds)),
    db.select().from(sites),
  ])

  const jobs: DriverJob[] = []
  for (const assignment of assignments) {
    const order = orderRows.find((row) => row.id === assignment.order_id)
    const segment = segments.find((row) => (assignment.segment_ids as string[]).includes(String(row.id)))
    if (!order || !segment) continue
    const item = itemRows.find((row) => row.item.id === segment.order_item_id)
    const stop = (pointId: unknown, boundary: Stop["boundary"]): Stop | null => {
      const point = points.find((row) => row.id === pointId)
      const address = addressRows.find((row) => row.id === point?.address_id)
      if (!point || !address) return null
      const site = siteRows.find((row) => row.id === (point.site_id ?? address.managedSiteId))
      const endpoint = endpoints.find((row) => row.point_id === point.id) ?? endpoints.find((row) => row.boundary === boundary && row.address_id === address.id)
      const siteDetails = (site?.details ?? {}) as Row
      const siteNote = str(siteDetails[boundary === "PICKUP" ? "pickup_access_note" : "delivery_access_note"]) ?? str(siteDetails.access_note)
      const instruction = str(endpoint?.access_instruction) ?? siteNote ?? str(address.details.access_note)
      const hours = siteDetails.opening_hours as Record<string, string | null> | undefined
      return {
        boundary,
        name: site?.name ?? address.name,
        city: address.city,
        addressLine: str(address.details.address_line1),
        timezone: str(address.details.timezone) ?? str(siteDetails.timezone) ?? "UTC",
        instruction,
        instructionSource: instruction ? sourceWords(endpoint, !!siteNote) : null,
        contactName: str(endpoint?.contact_name),
        contactRole: str(endpoint?.contact_role),
        hours: hours?.mon_fri ? `Mon–Fri ${hours.mon_fri}${hours.sat ? `, Sat ${hours.sat}` : ""}` : null,
      }
    }
    const pickup = stop(segment.from_point_id, "PICKUP")
    const delivery = stop(segment.to_point_id, "DELIVERY")
    if (!pickup || !delivery || !item) continue
    const window = (purpose: string, pointId: unknown): Window | null => {
      const row = windows.find((candidate) => candidate.purpose === purpose && candidate.is_selected && candidate.point_id === pointId)
        ?? windows.find((candidate) => candidate.purpose === purpose && candidate.is_selected && candidate.order_id === order.id)
      return row ? { startAt: String(row.start_at), endAt: String(row.end_at), timezone: String(row.timezone), source: str(row.source) } : null
    }
    const ferryRow = segment.transport_mode === "DRIVE_WITH_FERRY"
      ? reservations.find((row) => row.kind === "FERRY" && row.status === "BOOKED" && row.order_id === order.id)
      : undefined
    jobs.push({
      assignmentId: String(assignment.id),
      status: assignment.status as DriverJob["status"],
      orderId: order.id,
      reference: order.reference,
      vehicle: { title: `${item.vehicle.make} ${item.vehicle.model}`, year: item.vehicle.modelYear, fuel: item.vehicle.fuel, plate: item.vehicle.registration },
      pickup,
      delivery,
      pickupSlot: window("SELECTED_PICKUP_SLOT", segment.from_point_id),
      deliveryPromise: window("CUSTOMER_DELIVERY_PROMISE", segment.to_point_id),
      ferry: ferryRow ? {
        origin: String(ferryRow.origin_terminal), destination: String(ferryRow.destination_terminal),
        timezone: str(terminals.find((row) => row.id === ferryRow.origin_terminal_id)?.timezone) ?? "UTC",
        departureAt: String(ferryRow.departure_at), checkInCutoffAt: str(ferryRow.check_in_cutoff_at), bookingReference: str(ferryRow.booking_reference),
        checkInConfirmed: ferryRow.check_in_confirmation === "CONFIRMED",
      } : null,
    })
  }
  const order = (job: DriverJob) => (job.status === "IN_PROGRESS" ? 0 : 1)
  jobs.sort((a, b) => order(a) - order(b) || (a.pickupSlot?.startAt ?? "").localeCompare(b.pickupSlot?.startAt ?? ""))
  return { id: driver.id, name: driver.displayName, homeCity: driver.homeCity, jobs }
}

function sourceWords(endpoint: Row | undefined, fromSite: boolean): string {
  if (endpoint?.last_confirmed_source === "MANAGED_SITE_PROFILE" || endpoint?.stated_by === "MANAGED_SITE_PROFILE") return "the place's standard instructions"
  if (endpoint?.stated_by) return "the order's handover notes"
  return fromSite ? "the place's standard instructions" : "the address notes"
}

/** Inline photos above this size show as "Photo sent" instead of an image. */
const INLINE_PHOTO_LIMIT = 1_500_000

/** The thread this driver may see on one order, oldest first. */
export async function loadThread(driverId: string, orderId: string): Promise<ThreadMessage[]> {
  const db = crDb()
  const [datasetRows, ourRows] = await Promise.all([
    db.select().from(messages).where(eq(messages.orderId, orderId)).orderBy(asc(messages.authoredAt)),
    db.select().from(crEvents).where(and(eq(crEvents.orderId, orderId), or(
      and(eq(crEvents.actorType, "driver"), eq(crEvents.actorId, driverId)),
      and(eq(crEvents.recipientType, "driver"), eq(crEvents.recipientId, driverId)),
    ))).orderBy(asc(crEvents.at)),
  ])
  const fromDataset: ThreadMessage[] = datasetRows.filter((row) => {
    const details = row.details as Row
    if (details.visibility !== "PUBLIC") return false
    return (row.authorType === "driver" && details.author_id === driverId) || (details.recipient_type === "driver" && details.recipient_id === driverId)
  }).map((row) => {
    const mine = row.authorType === "driver"
    return {
      id: row.id, at: row.authoredAt.toISOString(), from: mine ? "me" : row.authorType === "agent" ? "agent" : "operator",
      fromName: mine ? "You" : row.authorType === "agent" ? "Bahn assistant" : "Bahn operations",
      kind: "message", text: row.body, voice: false, photo: null, photoSubject: null, origin: "dataset",
    }
  })
  const fromUs: ThreadMessage[] = ourRows.filter((row) => ["message", "voice_turn", "photo", "effect"].includes(row.kind)).map((row) => {
    const mine = row.actorType === "driver"
    const photo = row.kind === "photo" ? (row.data as unknown as PhotoData) : null
    const request = row.data.request === "photo" && typeof row.data.subject === "string" ? String(row.data.subject) : null
    return {
      id: row.id, at: row.at.toISOString(),
      from: mine ? "me" : row.actorType === "agent" ? "agent" : row.actorType === "operator" ? "operator" : "system",
      fromName: mine ? "You" : row.actorType === "agent" ? "Bahn assistant" : "Bahn operations",
      kind: photo ? "photo" : row.channel === "safety" ? "safety" : request ? "photo_request" : "message",
      text: row.body, voice: row.kind === "voice_turn" || row.channel === "driver_voice",
      photo: photo ? photoUrl(photo) : null, photoSubject: photo?.subject ?? request, origin: null,
    }
  })
  return [...fromDataset, ...fromUs].sort((a, b) => a.at.localeCompare(b.at))
}

function photoUrl(photo: PhotoData): string | null {
  if (photo.path) return photo.path
  if (photo.base64 && photo.base64.length <= INLINE_PHOTO_LIMIT) return `data:${photo.media_type};base64,${photo.base64}`
  return null
}
