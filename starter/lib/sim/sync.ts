// Brings `cr_telemetry` up to the current sim time. Called by the tick route
// (the driver app and the demo panel poll it) and by scenarios. Each call
// writes the samples that fell due since the last one, so the result is the
// same however often it runs.

import { and, eq, sql } from "drizzle-orm"
import { beginRuntimeWork, isResetting } from "@/lib/cr/activity"
import { advanceSimClock, simNow } from "@/lib/cr/clock"
import { crDb } from "@/lib/cr/db"
import { appendEvent, insertTelemetry, type NewTelemetry } from "@/lib/cr/queries"
import { crEvents } from "@/lib/cr/schema"
import { loadFleet, simStart, type FleetCar } from "./fleet"
import { notifyAgent } from "./agent-hooks"
import { freezeFrame, gpsSample, motionAt, obdSample, obdSilentFrom, type FaultPlan, type OverheatPlan } from "./motion"

const GPS_EVERY_S = 60
const GPS_EVERY_FAULT_S = 15
const OBD_EVERY_S = 60
const OBD_EVERY_FAULT_S = 5
/** A first sync, or one after a long pause, writes at most this much history. */
const BACKFILL_S = 10 * 60
/** A fault keeps the fast sample rate for this long. */
const FAULT_FAST_S = 15 * 60

type Latest = Map<string, Date>

const holder = globalThis as unknown as { __simSyncing?: Promise<SyncResult>; __simClockCaughtUp?: boolean }

export type SyncResult = { at: string; gps: number; obd: number }

/** Write every sample due up to `now`. Concurrent calls share one run. */
export function syncTelemetry(now?: Date): Promise<SyncResult> {
  if (isResetting()) return Promise.resolve({ at: (now ?? simNow()).toISOString(), gps: 0, obd: 0 })
  if (!holder.__simSyncing) {
    const release = beginRuntimeWork("telemetry sync")
    holder.__simSyncing = catchUpClock().then(() => runSync(now ?? simNow())).finally(() => { holder.__simSyncing = undefined; release() })
  }
  return holder.__simSyncing
}

/**
 * The clock lives in memory and starts at SIM_NOW, so a restart (a deploy, a crash) would put it behind the samples
 * and events already stored: a GPS fix "in 8 min", reply deadlines that never come. Once per process, before the first
 * sync, the clock moves up to just after the newest stored sample or event. A demo reset marks it done.
 */
async function catchUpClock(): Promise<void> {
  if (holder.__simClockCaughtUp) return
  holder.__simClockCaughtUp = true
  const result = await crDb().execute(sql`SELECT greatest((SELECT max(at) FROM cr_telemetry), (SELECT max(at) FROM cr_events)) AS at`)
  const latest = (result as unknown as { at: string | Date | null }[])[0]?.at
  const behindMs = latest ? new Date(latest).getTime() - simNow().getTime() : 0
  if (behindMs > 0) advanceSimClock(Math.ceil(behindMs / 60000))
}

/** The demo reset starts the clock at SIM_NOW on purpose; nothing to catch up to. */
export function markClockCaughtUp(): void {
  holder.__simClockCaughtUp = true
}

/** Faults injected by scenarios, newest per order. The plan rides on the scenario's OBD event. */
export async function activeFaults(): Promise<Map<string, FaultPlan>> {
  const rows = await crDb().select({ orderId: crEvents.orderId, data: crEvents.data, at: crEvents.at }).from(crEvents)
    .where(and(eq(crEvents.actorType, "obd"), sql`${crEvents.data} ? 'sim'`))
    .orderBy(crEvents.at)
  const plans = new Map<string, FaultPlan>()
  for (const row of rows) {
    const plan = row.data.sim as FaultPlan | undefined
    if (plan?.profile === "misfire" || plan?.profile === "overheat") plans.set(row.orderId, plan)
  }
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
  for (const car of fleet) {
    const plan = faults.get(car.orderId)
    if (plan?.profile === "overheat") await setCodeWhenDue(car, plan, now)
  }
  return { at: now.toISOString(), gps, obd }
}

/**
 * An overheating car sets its code a while after the coolant starts climbing.
 * When that moment has passed, write the `dtc` event once and tell the agent,
 * exactly as scenario A does at its start.
 */
async function setCodeWhenDue(car: FleetCar, plan: OverheatPlan, now: Date): Promise<void> {
  const detectedAt = new Date(Date.parse(plan.startedAt) + plan.detectAfterSeconds * 1000)
  if (now < detectedAt) return
  const [existing] = await crDb().select({ id: crEvents.id }).from(crEvents)
    .where(and(eq(crEvents.orderId, car.orderId), eq(crEvents.kind, "dtc"), sql`${crEvents.data}->>'fault_started_at' = ${plan.startedAt}`)).limit(1)
  if (existing) return
  const frame = freezeFrame(car, plan)
  const event = await appendEvent({
    caseId: null, orderId: car.orderId, at: detectedAt, actorType: "obd", actorId: `obd-${car.vehicleId}`, kind: "dtc", channel: "telemetry",
    body: `Engine temperature warning on. Trouble code ${plan.codes.join(", ")}. Coolant ${frame.values.coolant_c} °C and rising; ` +
      `the car was moving at ${frame.values.speed_kmh} km/h.`,
    data: { codes: plan.codes, mil: "ON", freeze_frame: frame, simulated: true, fault_started_at: plan.startedAt },
  })
  // Not awaited: the agent's first turn can take a while, and the caller may be a page poll.
  const release = beginRuntimeWork("pending telemetry alert")
  void notifyAgent(plan.notifyOrigin, {
    orderRef: car.reference, codes: plan.codes, mil: "ON", note: "engine temperature warning, coolant rising", eventId: event.id,
  }).finally(release)
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
  // Only scenario cars carry a dongle; a parked car's dongle sleeps until the driver reconnects it.
  if (!car.obd || car.stoppedNote) return []
  const silent = obdSilentFrom(plan)
  const until = silent && silent < now ? silent : now
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
