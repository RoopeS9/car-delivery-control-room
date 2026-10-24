// A car whose app went quiet comes back: the driver plugs the OBD dongle in or
// reopens the app, the dongle sends its stored codes with the freeze frame it
// kept, and the phone shares where it is now. Used by scenario B (CD-420322),
// where the dataset already has the safe stop but no diagnosis and no
// verified location.

import { and, eq, sql } from "drizzle-orm"
import { simNow } from "@/lib/cr/clock"
import { crDb } from "@/lib/cr/db"
import { appendEvent, insertTelemetry, openCaseForOrder } from "@/lib/cr/queries"
import { crEvents } from "@/lib/cr/schema"
import type { GpsData, ObdData, SourceRef } from "@/lib/cr/types"
import { fleetCar, type FleetCar } from "./fleet"
import { pointAlong, polylineKm } from "./geo"
import { roughWhere } from "./places"

type StoredFault = {
  codes: string[]
  /** When the dongle stored the codes, before the driver stopped. */
  freezeAt: string
  freezeValues: Record<string, number>
  /** When the engine was switched off (the driver's stop). */
  stoppedAt: string
  /** Where along the route the car stands, as a share of the route. */
  stopShare: number
  /** Fictional service area name. */
  serviceArea: string
}

/** Cars that can reconnect, with what their dongle stored. */
const STORED: Record<string, StoredFault> = {
  // Dataset: "A red warning came on and the car felt different when accelerating", stop reported 08:04.
  "CD-420322": {
    codes: ["P0217", "P0299"],
    freezeAt: "2026-10-21T08:02:00Z",
    freezeValues: { speed_kmh: 112, rpm: 2480, engine_load_pct: 81, throttle_pct: 46, coolant_c: 124, fuel_trim_short_pct: 3.1, fuel_trim_long_pct: 1.6, battery_v: 14.1 },
    stoppedAt: "2026-10-21T08:04:00Z",
    stopShare: 0.86,
    serviceArea: "Heidmoor Süd",
  },
}

export function canReconnect(reference: string): boolean {
  return reference in STORED
}

export type ReconnectResult = { ok: boolean; message: string; eventId?: string; alreadyConnected?: boolean }

/** Where the reconnecting car stands, in words. Shared with the simulated driver so both say the same place. */
export async function reconnectPlace(reference: string): Promise<string | null> {
  const car = await fleetCar(reference)
  const stored = STORED[reference]
  if (!car || !stored) return null
  return placeOf(car, stored).label
}

function placeOf(car: FleetCar, stored: StoredFault) {
  const km = stored.stopShare * car.pathKm
  const part = car.parts.find((candidate) => km <= candidate.startKm + candidate.km) ?? car.parts[car.parts.length - 1]
  const share = part.km === 0 ? 0 : (km - part.startKm) / part.km
  const { point } = pointAlong(part.coords, share * polylineKm(part.coords))
  return { point, label: `${stored.serviceArea} service area on the motorway ${roughWhere(point, car.fromCity, car.toCity)}` }
}

export async function alreadyReconnected(orderId: string): Promise<string | null> {
  const [row] = await crDb().select({ id: crEvents.id }).from(crEvents)
    .where(and(eq(crEvents.orderId, orderId), eq(crEvents.actorType, "obd"), sql`${crEvents.data} ? 'reconnect'`)).limit(1)
  return row?.id ?? null
}

export async function reconnectCar(reference: string): Promise<ReconnectResult> {
  const key = reference.trim().toUpperCase()
  const stored = STORED[key]
  const car = await fleetCar(key)
  if (!stored || !car) return { ok: false, message: `${key} has no car waiting to reconnect.` }
  const existing = await alreadyReconnected(car.orderId)
  if (existing) return { ok: true, message: "The car is already connected.", eventId: existing, alreadyConnected: true }

  const now = simNow()
  const minutesOff = Math.max(0, (now.getTime() - Date.parse(stored.stoppedAt)) / 60_000)
  const coolant = Math.round(9 + (stored.freezeValues.coolant_c - 9) * Math.exp(-minutesOff / 50))
  const obd: ObdData = {
    speed_kmh: 0, rpm: 0, engine_load_pct: 0, throttle_pct: 0, coolant_c: coolant, battery_v: 12.3,
    mil: "ON", dtcs: stored.codes, freeze_frame: { code: stored.codes[0], at: stored.freezeAt, values: stored.freezeValues },
  }
  const place = placeOf(car, stored)
  const gps: GpsData = { lat: place.point[0], lng: place.point[1], accuracy_m: 9, speed_kmh: 0, place_label: place.label }
  const [obdRow, gpsRow] = await insertTelemetry([
    { orderId: car.orderId, vehicleId: car.vehicleId, source: "OBD", at: now, simulated: true, data: obd as unknown as Record<string, unknown> },
    { orderId: car.orderId, vehicleId: car.vehicleId, source: "PHONE_GPS", at: now, simulated: true, data: gps as unknown as Record<string, unknown> },
  ])
  const sources: SourceRef[] = [
    { kind: "cr_telemetry", id: obdRow.id, label: "OBD dongle (simulated)", at: now.toISOString() },
    { kind: "cr_telemetry", id: gpsRow.id, label: "Driver's phone GPS (simulated)", at: now.toISOString() },
  ]
  const freezeTime = stored.freezeAt.slice(11, 16)
  // File the readout on the case the driver already has open, so it shows in that timeline.
  const openCase = await openCaseForOrder(car.orderId)
  const event = await appendEvent({
    caseId: openCase?.id ?? null, orderId: car.orderId, at: now, actorType: "obd", actorId: `obd-${car.vehicleId}`, kind: "dtc", channel: "telemetry",
    body: `OBD dongle reconnected with the ignition on and the engine off. Stored trouble codes ${stored.codes.join(" and ")}; ` +
      `freeze frame from ${freezeTime} UTC: coolant ${stored.freezeValues.coolant_c} °C at ${stored.freezeValues.speed_kmh} km/h. Coolant now ${coolant} °C.`,
    data: { codes: stored.codes, mil: "ON", freeze_frame: obd.freeze_frame, telemetry_id: obdRow.id, simulated: true, reconnect: { place: place.label } },
    sourceRefs: sources,
  })
  return { ok: true, message: `${car.reference}: dongle reconnected, stored codes ${stored.codes.join(", ")}; phone shared ${place.label}.`, eventId: event.id }
}
