// Demo scenarios, started from /demo. Each one changes only our own `cr_`
// tables; the dataset is never touched. `reset` puts the demo back to the
// start: no cases, no events, a fresh sim clock at the snapshot time.

import { resetSimClock, simNow } from "@/lib/cr/clock"
import { appendEvent, insertTelemetry, resetCrData } from "@/lib/cr/queries"
import type { SourceRef } from "@/lib/cr/types"
import { fleetCar, type FleetCar } from "./fleet"
import { baseMotion, faultMotion, freezeFrame, type FaultPlan } from "./motion"
import { roughWhere } from "./places"
import { activeFaults, syncTelemetry } from "./sync"

export type ScenarioName = "warning-light-584" | "reset"

export type ScenarioInfo = {
  name: ScenarioName
  title: string
  orderRef: string | null
  description: string
}

export const SCENARIOS: ScenarioInfo[] = [
  {
    name: "warning-light-584",
    title: "Fresh warning light",
    orderRef: "CD-420584",
    description: "The Bentley on its way from Cologne to the Helsinki ferry gets a flashing check-engine light and loses power. " +
      "The driver pulls into a service area. The OBD dongle sends misfire codes P0300 and P0302 with a freeze frame.",
  },
  {
    name: "reset",
    title: "Reset the demo",
    orderRef: null,
    description: "Remove every case, message, decision and telemetry sample we added, and restart the sim clock at 09:00 UTC on 21 Oct.",
  },
]

/** The fictional service area where the car in scenario A stops. */
const SERVICE_AREA = "Velmerheide Nord"

export type ScenarioResult = {
  ok: boolean
  name: ScenarioName
  message: string
  orderId?: string
  eventId?: string
  /** True when the agent should be told about a new event (the caller does that). */
  notifyAgent?: { kind: "telemetry_fault"; orderId: string; eventId: string }
}

export async function runScenario(name: string): Promise<ScenarioResult> {
  if (name === "reset") return reset()
  if (name === "warning-light-584") return warningLight584()
  return { ok: false, name: name as ScenarioName, message: `There is no scenario called "${name}".` }
}

async function reset(): Promise<ScenarioResult> {
  await resetCrData()
  resetSimClock()
  await syncTelemetry()
  return { ok: true, name: "reset", message: `Demo reset. Sim clock back at ${simNow().toISOString().slice(11, 16)} UTC.` }
}

async function warningLight584(): Promise<ScenarioResult> {
  const car = await fleetCar("CD-420584")
  if (!car) return { ok: false, name: "warning-light-584", message: "CD-420584 is not moving in this dataset." }
  if ((await activeFaults()).has(car.orderId)) {
    return { ok: false, name: "warning-light-584", message: "The warning light is already on for CD-420584. Reset the demo to run it again." }
  }
  const now = simNow()
  // Bring the history up to now first, so the fault starts from a car that was driving normally.
  await syncTelemetry(now)
  const detectAfterSeconds = 6
  const startedAt = new Date(now.getTime() - detectAfterSeconds * 1000)
  const before = baseMotion(car, startedAt)
  if (before.state !== "DRIVING") {
    return { ok: false, name: "warning-light-584", message: `CD-420584 is not on the road at this sim time (${before.placeLabel}). Reset the demo first.` }
  }
  const plan = misfirePlan(car, startedAt, before.km, before.speedKmh, detectAfterSeconds)
  const frame = freezeFrame(car, plan)
  const detectedAt = new Date(frame.at)
  const [snapshot] = await insertTelemetry([{
    orderId: car.orderId, vehicleId: car.vehicleId, source: "OBD", at: detectedAt, simulated: true,
    data: { ...frame.values, misfire_count: 19, mil: "FLASHING", dtcs: plan.codes, freeze_frame: frame },
  }])
  const sources: SourceRef[] = [{ kind: "cr_telemetry", id: snapshot.id, label: "OBD dongle (simulated)", at: detectedAt.toISOString() }]
  const event = await appendEvent({
    caseId: null,
    orderId: car.orderId,
    at: detectedAt,
    actorType: "obd",
    actorId: `obd-${car.vehicleId}`,
    kind: "dtc",
    channel: "telemetry",
    body: `Check-engine light flashing. New trouble codes ${plan.codes.join(" and ")}. ` +
      `Freeze frame stored at ${frame.values.speed_kmh} km/h and ${frame.values.rpm} rpm.`,
    data: { codes: plan.codes, mil: "FLASHING", freeze_frame: frame, telemetry_id: snapshot.id, simulated: true, sim: plan },
    sourceRefs: sources,
  })
  await syncTelemetry()
  return {
    ok: true,
    name: "warning-light-584",
    message: `Warning light on for CD-420584. The car limps for about a minute, then stops at ${plan.stopLabel}.`,
    orderId: car.orderId,
    eventId: event.id,
    notifyAgent: { kind: "telemetry_fault", orderId: car.orderId, eventId: event.id },
  }
}

function misfirePlan(car: FleetCar, startedAt: Date, km: number, speed: number, detectAfterSeconds: number): FaultPlan {
  const draft: FaultPlan = {
    profile: "misfire",
    startedAt: startedAt.toISOString(),
    kmAtStart: km,
    speedAtStart: speed,
    limpKmh: 70,
    limpSeconds: 50,
    rampSeconds: 35,
    engineOffAfterSeconds: 90,
    stopLabel: "",
    codes: ["P0300", "P0302"],
    detectAfterSeconds,
  }
  // Name the stop after where the car actually comes to rest.
  const stopAt = new Date(startedAt.getTime() + (draft.limpSeconds + draft.rampSeconds + 1) * 1000)
  const stop = faultMotion(car, draft, stopAt)
  return { ...draft, stopLabel: `${SERVICE_AREA} service area on the motorway ${roughWhere(stop.point, car.fromCity, car.toCity)}` }
}
