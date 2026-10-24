// Brings `cr_telemetry` up to the current sim time. Called by the tick route
// (the driver app and the demo panel poll it) and by scenarios. Each call
// writes the samples that fell due since the last one, so the result is the
// same however often it runs.

import { and, eq, sql } from "drizzle-orm"
import { simNow } from "@/lib/cr/clock"
import { crDb } from "@/lib/cr/db"
import { insertTelemetry, type NewTelemetry } from "@/lib/cr/queries"
import { crEvents } from "@/lib/cr/schema"
import { loadFleet, simStart, type FleetCar } from "./fleet"
import { gpsSample, motionAt, obdSample, type FaultPlan } from "./motion"

const GPS_EVERY_S = 60
const GPS_EVERY_FAULT_S = 15
const OBD_EVERY_S = 60
const OBD_EVERY_FAULT_S = 5
/** A first sync, or one after a long pause, writes at most this much history. */
const BACKFILL_S = 10 * 60
/** A fault keeps the fast sample rate for this long. */
const FAULT_FAST_S = 15 * 60

type Latest = Map<string, Date>

const holder = globalThis as unknown as { __simSyncing?: Promise<SyncResult> }

export type SyncResult = { at: string; gps: number; obd: number }

/** Write every sample due up to `now`. Concurrent calls share one run. */
export function syncTelemetry(now: Date = simNow()): Promise<SyncResult> {
  if (!holder.__simSyncing) {
    holder.__simSyncing = runSync(now).finally(() => { holder.__simSyncing = undefined })
  }
  return holder.__simSyncing
}

/** Faults injected by scenarios, newest per order. */
export async function activeFaults(): Promise<Map<string, FaultPlan>> {
  const rows = await crDb().select({ orderId: crEvents.orderId, data: crEvents.data, at: crEvents.at }).from(crEvents)
    .where(and(eq(crEvents.kind, "dtc"), eq(crEvents.actorType, "obd"), sql`${crEvents.data} ? 'sim'`))
    .orderBy(crEvents.at)
  const plans = new Map<string, FaultPlan>()
  for (const row of rows) plans.set(row.orderId, row.data.sim as FaultPlan)
  return plans
}

async function latestBySource(): Promise<{ gps: Latest; obd: Latest }> {
  const result = await crDb().execute(sql`SELECT order_id, source, max(at) AS at FROM cr_telemetry GROUP BY order_id, source`)
  const gps: Latest = new Map()
  const obd: Latest = new Map()
  for (const row of result as unknown as { order_id: string; source: string; at: string | Date }[]) {
    ;(row.source === "PHONE_GPS" ? gps : obd).set(row.order_id, new Date(row.at))
  }
  return { gps, obd }
}

/**
 * Grid times (multiples of `every` seconds) after `after` and up to `until`.
 * Never before the snapshot: up to then, the dataset's own tracking records are the truth.
 */
function grid(after: Date, until: Date, every: number): Date[] {
  const step = every * 1000
  const earliest = simStart().getTime()
  const times: Date[] = []
  for (let t = Math.floor(after.getTime() / step) * step + step; t <= until.getTime(); t += step) {
    if (t >= earliest) times.push(new Date(t))
  }
  return times
}

async function runSync(now: Date): Promise<SyncResult> {
  const [fleet, faults, latest] = await Promise.all([loadFleet(), activeFaults(), latestBySource()])
  const rows: (Omit<NewTelemetry, "id" | "at"> & { at: Date })[] = []
  let gps = 0
  let obd = 0
  for (const car of fleet) {
    const plan = faults.get(car.orderId) ?? null
    for (const sample of gpsDue(car, plan, latest.gps.get(car.orderId) ?? null, now)) { rows.push(sample); gps += 1 }
    for (const sample of obdDue(car, plan, latest.obd.get(car.orderId) ?? null, now)) { rows.push(sample); obd += 1 }
  }
  for (let index = 0; index < rows.length; index += 500) await insertTelemetry(rows.slice(index, index + 500))
  return { at: now.toISOString(), gps, obd }
}

function fastWindow(plan: FaultPlan | null, at: Date): boolean {
  if (!plan) return false
  const seconds = (at.getTime() - Date.parse(plan.startedAt)) / 1000
  return seconds >= -GPS_EVERY_S && seconds <= FAULT_FAST_S
}

function gpsDue(car: FleetCar, plan: FaultPlan | null, last: Date | null, now: Date) {
  const base = { orderId: car.orderId, vehicleId: car.vehicleId, source: "PHONE_GPS" as const, simulated: true }
  if (car.phone === "NONE") return []
  if (car.phone === "STALE" || car.stoppedNote) {
    // Keep only the last point the app reported. Nothing newer exists.
    if (last || !car.lastObservation) return []
    const at = car.lastObservation.at
    const motion = motionAt(car, at, null)
    const sample = gpsSample(car, motion, at)
    const where = sample.place_label?.replace(/^(On the road|Stopped|Near the delivery address in) ?/, "") ?? ""
    return [{ ...base, at, data: { ...sample, speed_kmh: undefined, accuracy_m: 1500, place_label: `Last app position ${where}`.trim() } }]
  }
  const until = car.quietFrom && car.quietFrom < now ? car.quietFrom : now
  const from = new Date(Math.max(last?.getTime() ?? 0, until.getTime() - BACKFILL_S * 1000, car.lastObservation?.at.getTime() ?? 0))
  const every = fastWindow(plan, until) ? GPS_EVERY_FAULT_S : GPS_EVERY_S
  return grid(from, until, every).map((at) => ({ ...base, at, data: gpsSample(car, motionAt(car, at, plan), at) }))
}

function obdDue(car: FleetCar, plan: FaultPlan | null, last: Date | null, now: Date) {
  const base = { orderId: car.orderId, vehicleId: car.vehicleId, source: "OBD" as const, simulated: true }
  // The dongle reports through the driver app, so it goes silent with the phone.
  if (car.stoppedNote || car.phone !== "LIVE") return []
  const until = car.quietFrom && car.quietFrom < now ? car.quietFrom : now
  const from = new Date(Math.max(last?.getTime() ?? 0, until.getTime() - BACKFILL_S * 1000))
  const every = fastWindow(plan, until) ? OBD_EVERY_FAULT_S : OBD_EVERY_S
  const samples = []
  for (const at of grid(from, until, every)) {
    const motion = motionAt(car, at, plan)
    if (motion.engineOn) {
      samples.push({ ...base, at, data: obdSample(car, motion, at, plan) })
      continue
    }
    // The dongle sleeps with the ignition off. After a fault it sends one last frame as the engine stops.
    const before = new Date(at.getTime() - every * 1000)
    if (plan && motion.state === "STOPPED_ENGINE_OFF" && motionAt(car, before, plan).engineOn) {
      samples.push({ ...base, at, data: obdSample(car, motion, at, plan) })
    }
  }
  return samples
}
