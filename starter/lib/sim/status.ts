// Read-side helpers for pages that show the simulation: one car's latest
// readings, and the fleet at a glance for the demo panel.

import { and, desc, eq } from "drizzle-orm"
import { simNow } from "@/lib/cr/clock"
import { crDb } from "@/lib/cr/db"
import { crTelemetry } from "@/lib/cr/schema"
import { sql } from "drizzle-orm"
import type { GpsData, ObdData } from "@/lib/cr/types"
import { fleetCar, loadFleet, simStart, type FleetCar, type PhoneState } from "./fleet"
import { motionAt, type MotionState, type SimObd } from "./motion"
import { alreadyReconnected, canReconnect } from "./reconnect"
import { routineCaseCount } from "./routine"
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
  obd: { at: string; data: SimObd } | null
  gps: { at: string; data: GpsData } | null
  /** Last few OBD samples, oldest first, for a small trend line. */
  obdTrend: { at: string; speed_kmh: number | null; coolant_c: number | null }[]
  /** Codes from the newest OBD sample, or the stored ones after the engine stopped. */
  codes: string[]
  mil: ObdData["mil"]
  /** True when the driver can plug the dongle back in (scenario B) and has not yet. */
  canConnect: boolean
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
  const canConnect = canReconnect(car.reference) && !(await alreadyReconnected(car.orderId))
  const latestObd = obdRows[0] ? { at: obdRows[0].at.toISOString(), data: obdRows[0].data as unknown as SimObd } : null
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
      return { at: row.at.toISOString(), speed_kmh: data.speed_kmh ?? null, coolant_c: data.coolant_c ?? null }
    }),
    codes: latestObd?.data.dtcs ?? [],
    mil: latestObd?.data.mil ?? "OFF",
    canConnect,
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

/** What the agent has cost so far: the `cost_usd` the agent loop sums from OpenRouter on each run. */
async function spend(): Promise<{ dollars: number; runs: number }> {
  const result = await crDb().execute(sql`SELECT count(*)::int AS runs, coalesce(sum((usage->>'cost_usd')::numeric), 0)::float AS dollars FROM cr_agent_runs`)
  const row = (result as unknown as { runs: number; dollars: number }[])[0]
  return { dollars: Number(row?.dollars ?? 0), runs: Number(row?.runs ?? 0) }
}

export async function fleetOverview(): Promise<{ now: string; start: string; spend: { dollars: number; runs: number }; routineCases: number; cars: FleetRow[] }> {
  const [fleet, faults, cost, routineCases] = await Promise.all([loadFleet(), activeFaults(), spend(), routineCaseCount()])
  const now = simNow()
  return {
    now: now.toISOString(),
    start: simStart().toISOString(),
    spend: cost,
    routineCases,
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
