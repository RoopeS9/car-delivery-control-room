// Server-side reads for the driver app: who has work, one driver's jobs, and
// the thread a driver may see. A driver sees only their own assignments and
// messages addressed to them or written by them; never internal notes,
// customer mail or other drivers' work.

import { and, asc, eq, inArray, or } from "drizzle-orm"
import { crDb } from "@/lib/cr/db"
import { effectiveOrder } from "@/lib/cr/effective"
import { simNow } from "@/lib/cr/clock"
import { lifecycleByOrder, MILESTONE_WORDS, MILESTONES, milestoneEvents, overlayAssignment, overlayReservation, type Lifecycle, type Milestone } from "@/lib/cr/lifecycle"
import { crEvents } from "@/lib/cr/schema"
import type { PhotoData } from "@/lib/cr/types"
import { currentFerrySchedule, historicalFerrySchedules, type BookingSchedule } from "@/lib/present/bookings"
import { addresses, drivers, messages, operationalEvents, orderItems, orders, relatedRecords, sites, vehicles } from "@/lib/schema"

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
  /** DELIVERED: handed over in this app; the job stays on the phone so the driver sees it closed. */
  status: "IN_PROGRESS" | "ASSIGNED" | "DELIVERED"
  orderId: string
  reference: string
  vehicle: { title: string; year: number; fuel: string; plate: string | null }
  pickup: Stop
  delivery: Stop
  pickupSlot: Window | null
  deliveryPromise: Window | null
  roadDeskBookings: { kind: string; reference: string | null; status: string }[]
  ferry: BookingSchedule | null
  historicalFerries: BookingSchedule[]
  /** The delivery's steps the driver reports, with when each was reported. */
  steps: { milestone: Milestone; label: string; at: string | null }[]
  next: Milestone | null
}

export type DriverListing = { id: string; name: string; homeCity: string; jobs: { reference: string; status: DriverJob["status"]; vehicle: string; route: string }[] }

export type ThreadMessage = {
  id: string
  at: string
  from: "me" | "agent" | "operator" | "system"
  fromName: string
  kind: "message" | "safety" | "photo_request" | "photo" | "call" | "milestone"
  /** For a `call` item: the voice call to answer. */
  callId?: string | null
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
/** Assignments as the driver's reports in this app leave them (collected: in progress; handed over: delivered). */
async function liveAssignments(): Promise<{ rows: Row[]; lifecycles: Map<string, Lifecycle> }> {
  const lifecycles = lifecycleByOrder(await milestoneEvents().catch(() => []))
  const rows = (await related("work_assignments")).map((row) => {
    const lifecycle = lifecycles.get(String(row.order_id))
    const overlaid = overlayAssignment(row, lifecycle)
    return lifecycle?.DELIVERED && overlaid.status === "COMPLETED" ? { ...overlaid, status: "DELIVERED" } : overlaid
  })
  return { rows, lifecycles }
}

export async function listDrivers(): Promise<DriverListing[]> {
  const assignments = (await liveAssignments()).rows.filter((row) => ACTIVE.includes(String(row.status)))
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
  const live = await liveAssignments()
  const assignments = live.rows.filter((row) => row.driver_id === driverId && (ACTIVE.includes(String(row.status)) || row.status === "DELIVERED"))
  const orderIds = [...new Set(assignments.map((row) => String(row.order_id)))]
  if (orderIds.length === 0) return { id: driver.id, name: driver.displayName, homeCity: driver.homeCity, jobs: [] }
  const [orderRows, segments, points, windows, endpoints, reservations, itemRows, pickedUp] = await Promise.all([
    db.select().from(orders).where(inArray(orders.id, orderIds)),
    related("transport_segments", { orderIds }),
    related("transport_points", { orderIds }),
    related("time_windows", { orderIds }),
    related("order_endpoint_details", { orderIds }),
    related("travel_reservations", { orderIds }),
    db.select({ item: orderItems, vehicle: vehicles }).from(orderItems).innerJoin(vehicles, eq(orderItems.vehicleId, vehicles.id))
      .where(inArray(orderItems.orderId, orderIds)),
    db.select({ orderId: operationalEvents.orderId, at: operationalEvents.recordedAt }).from(operationalEvents)
      .where(and(eq(operationalEvents.command, "vehicle.picked_up"), inArray(operationalEvents.orderId, orderIds))),
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
    const effective = await effectiveOrder(order.id)
    const orderReservations = reservations.filter((row) => row.order_id === order.id).map((row) => overlayReservation(row, live.lifecycles.get(order.id)))
    const deliveryPromise = effective.promise ? {
      startAt: effective.promise.start_utc,
      endAt: effective.promise.end_utc,
      timezone: effective.promise.zone ?? delivery.timezone,
      source: effective.promise.basis,
    } : window("CUSTOMER_DELIVERY_PROMISE", segment.to_point_id)
    jobs.push({
      assignmentId: String(assignment.id),
      status: assignment.status as DriverJob["status"],
      orderId: order.id,
      reference: order.reference,
      vehicle: { title: `${item.vehicle.make} ${item.vehicle.model}`, year: item.vehicle.modelYear, fuel: item.vehicle.fuel, plate: item.vehicle.registration },
      pickup,
      delivery,
      pickupSlot: window("SELECTED_PICKUP_SLOT", segment.from_point_id),
      deliveryPromise,
      roadDeskBookings: effective.bookings.filter((booking) => booking.source.kind === "cr_effects")
        .map((booking) => ({ kind: booking.kind, reference: booking.reference, status: booking.status })),
      ferry: segment.transport_mode === "DRIVE_WITH_FERRY" ? currentFerrySchedule(effective, orderReservations) : null,
      historicalFerries: historicalFerrySchedules(effective, orderReservations),
      ...stepsOf(live.lifecycles.get(order.id) ?? {}, segment.transport_mode === "DRIVE_WITH_FERRY" && orderReservations.some((row) => row.kind === "FERRY" && row.status === "BOOKED"), {
        // What the records already say happened before this app was in the driver's hand.
        COLLECTED: assignment.status === "IN_PROGRESS" || assignment.status === "COMPLETED"
          ? pickedUp.find((row) => row.orderId === order.id)?.at.toISOString() ?? str(assignment.started_at) ?? simNow().toISOString() : null,
        CHECKED_IN: str(orderReservations.find((row) => row.kind === "FERRY" && row.status === "BOOKED" && row.check_in_confirmation === "CONFIRMED_BY_GATE_SCAN")?.check_in_confirmed_at),
      }),
    })
  }
  const order = (job: DriverJob) => (job.status === "IN_PROGRESS" ? 0 : job.status === "ASSIGNED" ? 1 : 2)
  jobs.sort((a, b) => order(a) - order(b) || (a.pickupSlot?.startAt ?? "").localeCompare(b.pickupSlot?.startAt ?? ""))
  return { id: driver.id, name: driver.displayName, homeCity: driver.homeCity, jobs }
}

/** The steps as reported in the app, or as the records already have them (a collection before the app was used). */
function stepsOf(lifecycle: Lifecycle, ferry: boolean, recorded: Partial<Record<Milestone, string | null>>): Pick<DriverJob, "steps" | "next"> {
  const steps = MILESTONES.filter((step) => ferry || step !== "CHECKED_IN")
  const at = (milestone: Milestone) => lifecycle[milestone]?.at ?? recorded[milestone] ?? null
  // The step after the last one done; an arrival the driver went straight past stays skipped.
  const last = Math.max(-1, ...steps.map((step, index) => (at(step) ? index : -1)))
  return { steps: steps.map((milestone) => ({ milestone, label: MILESTONE_WORDS[milestone], at: at(milestone) })), next: steps[last + 1] ?? null }
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
  const fromUs: ThreadMessage[] = ourRows.filter((row) => ["message", "voice_turn", "photo", "effect", "milestone"].includes(row.kind)).map((row) => {
    if (row.kind === "milestone") {
      const step = (row.data as { milestone?: Milestone }).milestone
      return { id: row.id, at: row.at.toISOString(), from: "me" as const, fromName: "You", kind: "milestone" as const, text: row.body.replace(/^[^:]+:\s*/, "") || (step ? MILESTONE_WORDS[step] : ""), voice: false, photo: null, photoSubject: null, origin: null }
    }
    const mine = row.actorType === "driver"
    const photo = row.kind === "photo" ? (row.data as unknown as PhotoData) : null
    const request = row.data.request === "photo" && typeof row.data.subject === "string" ? String(row.data.subject) : null
    return {
      id: row.id, at: row.at.toISOString(),
      from: mine ? "me" : row.actorType === "agent" ? "agent" : row.actorType === "operator" ? "operator" : "system",
      fromName: mine ? "You" : row.actorType === "agent" ? "Bahn assistant" : "Bahn operations",
      kind: photo ? "photo" : row.channel === "safety" ? "safety" : row.data.call === true || typeof row.data.call_id === "string" ? "call" : request ? "photo_request" : "message",
      callId: typeof row.data.call_id === "string" ? row.data.call_id : null,
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
