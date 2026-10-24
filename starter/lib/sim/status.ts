// Read-side helpers for pages that show the simulation: one car's latest
// readings, and the fleet at a glance for the demo panel.

import { and, desc, eq } from "drizzle-orm"
import { simNow } from "@/lib/cr/clock"
import { crDb } from "@/lib/cr/db"
import { crTelemetry } from "@/lib/cr/schema"
import type { GpsData, ObdData } from "@/lib/cr/types"
import { fleetCar, loadFleet, simStart, type FleetCar, type PhoneState } from "./fleet"
import { motionAt, type MotionState } from "./motion"
import { activeFaults, syncTelemetry } from "./sync"

export type CarReadings = {
  orderId: string
  reference: string
  vehicleTitle: string
  fuel: FleetCar["fuel"]
  driverId: string
  driverName: string
  phone: PhoneState
  phoneNote: string | null
  now: string
  obd: { at: string; data: ObdData } | null
  gps: { at: string; data: GpsData } | null
  /** Last few OBD samples, oldest first, for a small trend line. */
  obdTrend: { at: string; speed_kmh: number | null; rpm: number | null; coolant_c: number | null }[]
  /** Codes from the newest OBD sample, or the stored ones after the engine stopped. */
  codes: string[]
  mil: ObdData["mil"]
}

export async function carReadings(orderRefOrId: string): Promise<CarReadings | null> {
  const car = await fleetCar(orderRefOrId)
  if (!car) return null
  await syncTelemetry()
  const db = crDb()
  const [obdRows, gpsRows] = await Promise.all([
    db.select().from(crTelemetry).where(and(eq(crTelemetry.orderId, car.orderId), eq(crTelemetry.source, "OBD")))
      .orderBy(desc(crTelemetry.at)).limit(40),
    db.select().from(crTelemetry).where(and(eq(crTelemetry.orderId, car.orderId), eq(crTelemetry.source, "PHONE_GPS")))
      .orderBy(desc(crTelemetry.at)).limit(1),
  ])
  const latestObd = obdRows[0] ? { at: obdRows[0].at.toISOString(), data: obdRows[0].data as unknown as ObdData } : null
  const latestGps = gpsRows[0] ? { at: gpsRows[0].at.toISOString(), data: gpsRows[0].data as unknown as GpsData } : null
  return {
    orderId: car.orderId,
    reference: car.reference,
    vehicleTitle: car.vehicleTitle,
    fuel: car.fuel,
    driverId: car.driverId,
    driverName: car.driverName,
    phone: car.phone,
    phoneNote: car.phoneNote,
    now: simNow().toISOString(),
    obd: latestObd,
    gps: latestGps,
    obdTrend: obdRows.slice(0, 24).reverse().map((row) => {
      const data = row.data as unknown as ObdData
      return { at: row.at.toISOString(), speed_kmh: data.speed_kmh ?? null, rpm: data.rpm ?? null, coolant_c: data.coolant_c ?? null }
    }),
    codes: latestObd?.data.dtcs ?? [],
    mil: latestObd?.data.mil ?? "OFF",
  }
}

export type FleetRow = {
  reference: string
  orderId: string
  vehicleTitle: string
  driverName: string
  driverId: string
  phone: PhoneState
  /** UNKNOWN when the app never reported; LAST_SEEN when only an old report exists. */
  state: MotionState | "UNKNOWN" | "LAST_SEEN"
  placeLabel: string
  speedKmh: number
  fault: string | null
  quietFrom: string | null
}

export async function fleetOverview(): Promise<{ now: string; start: string; cars: FleetRow[] }> {
  const [fleet, faults] = await Promise.all([loadFleet(), activeFaults()])
  const now = simNow()
  return {
    now: now.toISOString(),
    start: simStart().toISOString(),
    cars: fleet.map((car) => {
      const plan = faults.get(car.orderId) ?? null
      const row = {
        reference: car.reference, orderId: car.orderId, vehicleTitle: car.vehicleTitle, driverName: car.driverName, driverId: car.driverId,
        phone: car.phone, fault: plan ? plan.codes.join(", ") : null, quietFrom: car.quietFrom?.toISOString() ?? null,
      }
      // Say only what a report supports: no position without one, and an old one as old.
      if (car.phone === "NONE" || !car.lastObservation) {
        return { ...row, state: "UNKNOWN" as const, placeLabel: "No position from the driver app on this trip", speedKmh: 0 }
      }
      const silentSince = car.phone === "STALE" ? car.lastObservation.at : car.quietFrom && car.quietFrom < now ? car.quietFrom : null
      if (silentSince) {
        const last = motionAt(car, silentSince, null)
        const where = last.placeLabel.replace(/^(On the road|Stopped|Near the delivery address in) ?/, "")
        const note = car.stoppedNote ? ". The driver reported a safety stop" : ""
        return { ...row, state: "LAST_SEEN" as const, placeLabel: `Last app position ${where} at ${silentSince.toISOString().slice(11, 16)} UTC${note}`, speedKmh: 0 }
      }
      const motion = motionAt(car, now, plan)
      return { ...row, state: motion.state, placeLabel: motion.placeLabel, speedKmh: motion.speedKmh }
    }),
  }
}
