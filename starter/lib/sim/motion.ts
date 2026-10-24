// Where a simulated car is and what its OBD dongle reads at a given sim time.
// Pure functions: the same car, fault and time always give the same answer,
// so a sample can be regenerated or checked in a test.

import type { GpsData, MilState, ObdData } from "@/lib/cr/types"
import type { FleetCar } from "./fleet"
import { hash } from "./fleet"
import { pointAlong, type LatLng } from "./geo"
import { roughWhere } from "./places"

export type MotionState =
  | "DRIVING" | "AT_TERMINAL" | "ON_FERRY" | "ARRIVED" | "PARKED"
  | "LIMPING" | "STOPPING" | "STOPPED_IDLING" | "STOPPED_ENGINE_OFF"

export type Motion = {
  state: MotionState
  km: number
  point: LatLng
  heading: number
  speedKmh: number
  engineOn: boolean
  placeLabel: string
}

/**
 * A fault injected by a scenario. Stored in the `dtc` event's `data.sim` so
 * the simulation survives a server restart and disappears with a reset.
 */
export type FaultPlan = {
  profile: "misfire"
  /** When the fault began; codes are detected a few seconds later. */
  startedAt: string
  /** Position along the route (km) and speed when it began. */
  kmAtStart: number
  speedAtStart: number
  /** Reduced-power speed while the driver looks for a place to stop. */
  limpKmh: number
  limpSeconds: number
  /** Slowing down from limp speed to a stop. */
  rampSeconds: number
  /** The engine is switched off this long after the car stops. */
  engineOffAfterSeconds: number
  /** Where the car comes to rest, in words. */
  stopLabel: string
  codes: string[]
  detectAfterSeconds: number
}

// ---------------------------------------------------------------- noise

/** Deterministic noise in [-1, 1] for a car, a signal and a second. */
function noise(seed: string, signal: string, at: Date): number {
  let state = hash(`${seed}:${signal}:${Math.floor(at.getTime() / 1000)}`)
  state = Math.imul(state ^ (state >>> 15), 2246822507)
  state = Math.imul(state ^ (state >>> 13), 3266489909)
  return (((state ^ (state >>> 16)) >>> 0) / 4294967295) * 2 - 1
}

const round = (value: number, digits = 0) => Math.round(value * 10 ** digits) / 10 ** digits

// ---------------------------------------------------------------- position

function placeOnRoute(car: FleetCar, km: number): { point: LatLng; heading: number; partIndex: number } {
  const clamped = Math.max(0, Math.min(car.pathKm, km))
  let index = car.parts.findIndex((part) => clamped <= part.startKm + part.km)
  if (index < 0) index = car.parts.length - 1
  const part = car.parts[index]
  // A part's stored km is road distance; its polyline is shorter. Walk it by fraction.
  const fraction = part.km === 0 ? 1 : (clamped - part.startKm) / part.km
  const lineKm = part.coords.reduce((sum, point, i) => i === 0 ? 0 : sum + approxKm(part.coords[i - 1], point), 0)
  const placed = pointAlong(part.coords, fraction * lineKm)
  return { ...placed, partIndex: index }
}

function approxKm(a: LatLng, b: LatLng): number {
  const dLat = (b[0] - a[0]) * 111.2
  const dLng = (b[1] - a[1]) * 111.2 * Math.cos(((a[0] + b[0]) / 2) * Math.PI / 180)
  return Math.hypot(dLat, dLng)
}

/** Kilometres along the route at the last dataset observation (or 0 when the app never reported). */
export function kmAtObservation(car: FleetCar): number {
  return car.lastObservation ? car.lastObservation.progress * car.pathKm : 0
}

/** The car's normal journey, with no fault. */
export function baseMotion(car: FleetCar, at: Date): Motion {
  const km0 = kmAtObservation(car)
  const since = car.lastObservation?.at ?? at
  const label = (point: LatLng) => `On the road ${roughWhere(point, car.fromCity, car.toCity)}`

  if (car.stoppedNote) {
    const placed = placeOnRoute(car, km0)
    return { state: "PARKED", km: km0, ...placed, speedKmh: 0, engineOn: false, placeLabel: `Stopped ${roughWhere(placed.point, car.fromCity, car.toCity)}` }
  }

  const hours = Math.max(0, (at.getTime() - since.getTime()) / 3_600_000)
  let km = km0 + car.cruiseKmh * hours
  const cruise = cruiseSpeed(car, at)

  if (car.ferry) {
    const roadBefore = car.parts[0].km
    const sea = car.parts[1]
    if (km >= roadBefore) {
      const reachedTerminalAt = new Date(since.getTime() + ((roadBefore - km0) / car.cruiseKmh) * 3_600_000)
      const terminal = placeOnRoute(car, roadBefore)
      if (at < car.ferry.departureAt || reachedTerminalAt > car.ferry.departureAt) {
        return { state: "AT_TERMINAL", km: roadBefore, ...terminal, speedKmh: 0, engineOn: false, placeLabel: `At ${car.ferry.originName}` }
      }
      if (at < car.ferry.arrivalAt) {
        const share = (at.getTime() - car.ferry.departureAt.getTime()) / (car.ferry.arrivalAt.getTime() - car.ferry.departureAt.getTime())
        const seaKm = roadBefore + sea.km * share
        const placed = placeOnRoute(car, seaKm)
        return { state: "ON_FERRY", km: seaKm, ...placed, speedKmh: 38, engineOn: false, placeLabel: `On the ferry to ${car.ferry.destinationName}` }
      }
      km = roadBefore + sea.km + car.cruiseKmh * ((at.getTime() - car.ferry.arrivalAt.getTime()) / 3_600_000)
    }
  }

  if (km >= car.pathKm - 0.5) {
    const placed = placeOnRoute(car, car.pathKm)
    return { state: "ARRIVED", km: car.pathKm, ...placed, speedKmh: 0, engineOn: false, placeLabel: `Near the delivery address in ${car.toCity}` }
  }
  const placed = placeOnRoute(car, km)
  return { state: "DRIVING", km, ...placed, speedKmh: cruise, engineOn: true, placeLabel: label(placed.point) }
}

function cruiseSpeed(car: FleetCar, at: Date): number {
  const seconds = at.getTime() / 1000
  const wave = 14 * Math.sin(seconds / 113 + hash(car.orderId)) + 5 * Math.sin(seconds / 37)
  return Math.max(60, round(car.cruiseKmh + 30 + wave + 2 * noise(car.orderId, "speed", at)))
}

/** Speed profile of a fault: limping at reduced power, then slowing to a stop. */
function faultSpeed(plan: FaultPlan, seconds: number): number {
  if (seconds < 0) return plan.speedAtStart
  const settle = 20
  if (seconds < settle) return plan.speedAtStart + (plan.limpKmh - plan.speedAtStart) * (seconds / settle)
  if (seconds < plan.limpSeconds) return plan.limpKmh
  const ramp = seconds - plan.limpSeconds
  if (ramp < plan.rampSeconds) return plan.limpKmh * (1 - ramp / plan.rampSeconds)
  return 0
}

/** Kilometres covered since the fault began, integrated second by second. */
function faultDistanceKm(plan: FaultPlan, seconds: number): number {
  let km = 0
  const end = Math.min(seconds, plan.limpSeconds + plan.rampSeconds)
  for (let second = 0; second < end; second += 1) km += faultSpeed(plan, second + 0.5) / 3600
  return km
}

export function faultMotion(car: FleetCar, plan: FaultPlan, at: Date): Motion {
  const seconds = (at.getTime() - Date.parse(plan.startedAt)) / 1000
  const km = plan.kmAtStart + faultDistanceKm(plan, Math.max(0, seconds))
  const placed = placeOnRoute(car, km)
  const stopAfter = plan.limpSeconds + plan.rampSeconds
  if (seconds < plan.limpSeconds) {
    return { state: "LIMPING", km, ...placed, speedKmh: round(faultSpeed(plan, seconds)), engineOn: true, placeLabel: `On the road ${roughWhere(placed.point, car.fromCity, car.toCity)}` }
  }
  if (seconds < stopAfter) {
    return { state: "STOPPING", km, ...placed, speedKmh: round(faultSpeed(plan, seconds)), engineOn: true, placeLabel: `Pulling into ${plan.stopLabel}` }
  }
  const engineOn = seconds < stopAfter + plan.engineOffAfterSeconds
  return { state: engineOn ? "STOPPED_IDLING" : "STOPPED_ENGINE_OFF", km, ...placed, speedKmh: 0, engineOn, placeLabel: plan.stopLabel }
}

export function motionAt(car: FleetCar, at: Date, plan: FaultPlan | null): Motion {
  if (plan && at.getTime() >= Date.parse(plan.startedAt)) return faultMotion(car, plan, at)
  return baseMotion(car, at)
}

// ---------------------------------------------------------------- GPS

export function gpsSample(car: FleetCar, motion: Motion, at: Date): GpsData {
  const jitter = motion.speedKmh > 0 ? 0.00008 : 0.00003
  return {
    lat: round(motion.point[0] + jitter * noise(car.orderId, "lat", at), 6),
    lng: round(motion.point[1] + jitter * noise(car.orderId, "lng", at), 6),
    accuracy_m: round(12 + 8 * Math.abs(noise(car.orderId, "acc", at))),
    speed_kmh: round(motion.speedKmh),
    heading: round(motion.heading),
    place_label: motion.placeLabel,
  }
}

// ---------------------------------------------------------------- OBD

export function obdSample(car: FleetCar, motion: Motion, at: Date, plan: FaultPlan | null): ObdData {
  const n = (signal: string) => noise(car.orderId, signal, at)
  const seed = hash(car.vehicleId)
  const speed = motion.speedKmh

  if (car.fuel === "electric") {
    const soc = Math.max(8, 86 - (seed % 9) - (motion.km - kmAtObservation(car)) * 0.17 - (car.lastObservation?.progress ?? 0) * 40)
    return { speed_kmh: round(speed), soc_pct: round(soc), battery_v: round(14.4 + 0.1 * n("bv"), 1), mil: "OFF", dtcs: [] }
  }

  const fault = plan && at.getTime() >= Date.parse(plan.startedAt) ? plan : null
  const faultSeconds = fault ? (at.getTime() - Date.parse(fault.startedAt)) / 1000 : 0
  const detected = !!fault && faultSeconds >= fault.detectAfterSeconds
  const hybridEngineOff = car.fuel === "hybrid" && speed < 35 && !fault
  const running = motion.engineOn && !hybridEngineOff
  const idle = car.fuel === "diesel" ? 760 : 680
  const perKmh = car.fuel === "diesel" ? 9.5 : 11.5

  let rpm = running ? idle + speed * perKmh + 40 * n("rpm") : 0
  let load = running ? 16 + speed * 0.25 + 3 * n("load") : 0
  let throttle = running ? 6 + speed * 0.11 + 2 * n("thr") : 0
  let stft = running ? 2 * n("stft") : 0
  const ltft = ((seed % 7) - 3) * 0.8
  let misfires = 0
  let mil: MilState = "OFF"
  const dtcs: string[] = []

  if (fault) {
    misfires = Math.floor(3.2 * Math.max(0, Math.min(faultSeconds, fault.limpSeconds + fault.rampSeconds + fault.engineOffAfterSeconds)))
    if (detected) dtcs.push(...fault.codes)
    if (detected) mil = running ? "FLASHING" : "ON"
    if (running) {
      const rough = Math.abs(n("rough")) > 0.75 ? -260 : 0
      rpm += 220 * n("jit") + rough
      stft = 9 + 3 * n("stft")
      if (motion.state === "LIMPING" || motion.state === "STOPPING") {
        throttle = 34 + 8 * n("thr")
        load = 72 + 10 * n("load")
      } else {
        rpm = 620 + 130 * n("idle") + rough / 2
        load = 28 + 6 * n("load")
        throttle = 0
      }
    }
  }

  const sample: ObdData = {
    speed_kmh: round(speed),
    rpm: round(Math.max(0, rpm)),
    engine_load_pct: round(Math.max(0, Math.min(100, load))),
    throttle_pct: round(Math.max(0, Math.min(100, throttle))),
    coolant_c: round(running || fault ? 90 + (seed % 4) + 0.6 * n("cool") : 40 + (seed % 6), 1),
    battery_v: round(running ? 14.2 + 0.1 * n("bv") : 12.5 + 0.05 * n("bv"), 1),
    fuel_trim_short_pct: round(stft, 1),
    fuel_trim_long_pct: round(ltft, 1),
    misfire_count: misfires,
    mil,
    dtcs,
  }
  if (car.fuel === "hybrid") sample.soc_pct = round(58 + 6 * Math.sin(at.getTime() / 900_000 + seed))
  return sample
}

/** The freeze frame the dongle stores when it sets a code: the readings at that moment. */
export function freezeFrame(car: FleetCar, plan: FaultPlan): { code: string; at: string; values: Record<string, number> } {
  const at = new Date(Date.parse(plan.startedAt) + plan.detectAfterSeconds * 1000)
  const sample = obdSample(car, faultMotion(car, plan, at), at, plan)
  const values: Record<string, number> = {}
  for (const key of ["speed_kmh", "rpm", "engine_load_pct", "throttle_pct", "coolant_c", "fuel_trim_short_pct", "fuel_trim_long_pct", "battery_v"] as const) {
    const value = sample[key]
    if (typeof value === "number") values[key] = value
  }
  return { code: plan.codes[0], at: at.toISOString(), values }
}
