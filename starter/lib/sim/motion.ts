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
  | "LIMPING" | "STOPPING" | "STOPPED_IDLING" | "STOPPED_ENGINE_OFF" | "OVERHEATING"

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
 * A fault injected by a scenario. Stored in the scenario's OBD event
 * (`data.sim`), so the simulation survives a server restart and disappears
 * with a reset.
 */
export type FaultPlan = MisfirePlan | OverheatPlan

type PlanBase = {
  /** When the fault began; the code is set `detectAfterSeconds` later. */
  startedAt: string
  /** Position along the route (km) and speed when it began. */
  kmAtStart: number
  speedAtStart: number
  codes: string[]
  detectAfterSeconds: number
  /**
   * Set when an operator cleared the driver to continue after the fault (a repair, a reset): from then on the car
   * drives on from where it stopped, with the light off and no codes. Read from the clearance, never stored here.
   */
  resumedAt?: string
}

/** Scenario A: flashing light and reduced power; the driver pulls into a service area and stops. */
export type MisfirePlan = PlanBase & {
  profile: "misfire"
  /** Reduced-power speed while the driver looks for a place to stop. */
  limpKmh: number
  limpSeconds: number
  /** Slowing down from limp speed to a stop. */
  rampSeconds: number
  /** The engine is switched off this long after the car stops. */
  engineOffAfterSeconds: number
  /** Where the car comes to rest, in words. */
  stopLabel: string
}

/**
 * Scenario F: coolant climbs, the temperature code is set, and then the dongle
 * stops reporting while the car is still moving. Nobody knows whether it stopped.
 */
export type OverheatPlan = PlanBase & {
  profile: "overheat"
  coolantStart: number
  coolantPerMinute: number
  /** The dongle's last frame is this long after the start. */
  silentAfterSeconds: number
  /** Where to tell the agent when the code is set (the app's own origin). The code comes due during a later sync. */
  notifyOrigin: string
}

/** One OBD frame as the simulator writes it: the shared shape plus whether the engine runs. */
export type SimObd = ObdData & { engine_on: boolean }

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
  if (car.stoppedNote) {
    const placed = placeOnRoute(car, km0)
    return { state: "PARKED", km: km0, ...placed, speedKmh: 0, engineOn: false, placeLabel: `Stopped ${roughWhere(placed.point, car.fromCity, car.toCity)}` }
  }
  return journeyFrom(car, km0, car.lastObservation?.at ?? at, at)
}

/** Driving on from `km0` at `since`: road, the terminal and the booked sailing, then the last stretch. */
function journeyFrom(car: FleetCar, km0: number, since: Date, at: Date): Motion {
  const label = (point: LatLng) => `On the road ${roughWhere(point, car.fromCity, car.toCity)}`
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

/** Speed profile of a misfire: limping at reduced power, then slowing to a stop. */
function misfireSpeed(plan: MisfirePlan, seconds: number): number {
  if (seconds < 0) return plan.speedAtStart
  const settle = 20
  if (seconds < settle) return plan.speedAtStart + (plan.limpKmh - plan.speedAtStart) * (seconds / settle)
  if (seconds < plan.limpSeconds) return plan.limpKmh
  const ramp = seconds - plan.limpSeconds
  if (ramp < plan.rampSeconds) return plan.limpKmh * (1 - ramp / plan.rampSeconds)
  return 0
}

/** Overheating: the car keeps going; once the code is set the engine protects itself and power drops. */
function overheatSpeed(plan: OverheatPlan, seconds: number): number {
  const after = seconds - plan.detectAfterSeconds
  if (after <= 0) return plan.speedAtStart
  return Math.max(78, plan.speedAtStart - (plan.speedAtStart - 78) * Math.min(1, after / 60))
}

function faultSpeed(plan: FaultPlan, seconds: number): number {
  return plan.profile === "misfire" ? misfireSpeed(plan, seconds) : overheatSpeed(plan, seconds)
}

/** Kilometres covered since the fault began, integrated second by second. */
function faultDistanceKm(plan: FaultPlan, seconds: number): number {
  let km = 0
  const end = plan.profile === "misfire" ? Math.min(seconds, plan.limpSeconds + plan.rampSeconds) : seconds
  for (let second = 0; second < end; second += 1) km += faultSpeed(plan, second + 0.5) / 3600
  return km
}

export function faultMotion(car: FleetCar, plan: FaultPlan, at: Date): Motion {
  if (plan.profile === "misfire" && plan.resumedAt && at.getTime() >= Date.parse(plan.resumedAt)) {
    const stoppedKm = plan.kmAtStart + faultDistanceKm(plan, plan.limpSeconds + plan.rampSeconds)
    return journeyFrom(car, stoppedKm, new Date(plan.resumedAt), at)
  }
  const seconds = (at.getTime() - Date.parse(plan.startedAt)) / 1000
  const km = plan.kmAtStart + faultDistanceKm(plan, Math.max(0, seconds))
  const placed = placeOnRoute(car, km)
  const where = `On the road ${roughWhere(placed.point, car.fromCity, car.toCity)}`
  if (plan.profile === "overheat") {
    return { state: "OVERHEATING", km, ...placed, speedKmh: round(faultSpeed(plan, seconds)), engineOn: true, placeLabel: where }
  }
  const stopAfter = plan.limpSeconds + plan.rampSeconds
  if (seconds < plan.limpSeconds) {
    return { state: "LIMPING", km, ...placed, speedKmh: round(faultSpeed(plan, seconds)), engineOn: true, placeLabel: where }
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

/** When the dongle stops reporting under this plan, if it does. */
export function obdSilentFrom(plan: FaultPlan | null): Date | null {
  return plan?.profile === "overheat" ? new Date(Date.parse(plan.startedAt) + plan.silentAfterSeconds * 1000) : null
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

/**
 * Only the signals a decision uses (PLAN.md 4.5): trouble codes, the
 * check-engine light, coolant, battery voltage, speed and engine on/off.
 * Electric cars report speed, battery voltage, light and codes.
 */
export function obdSample(car: FleetCar, motion: Motion, at: Date, plan: FaultPlan | null): SimObd {
  const n = (signal: string) => noise(car.orderId, signal, at)
  const seed = hash(car.vehicleId)
  const running = motion.engineOn
  const repaired = plan?.resumedAt && at.getTime() >= Date.parse(plan.resumedAt)
  const fault = plan && !repaired && at.getTime() >= Date.parse(plan.startedAt) ? plan : null
  const seconds = fault ? (at.getTime() - Date.parse(fault.startedAt)) / 1000 : 0
  const detected = !!fault && seconds >= fault.detectAfterSeconds
  const mil: MilState = !detected ? "OFF" : fault.profile === "misfire" && running ? "FLASHING" : "ON"
  const dtcs = detected ? [...fault.codes] : []
  const battery = round(running ? 14.2 + 0.1 * n("bv") : 12.4 + 0.05 * n("bv"), 1)

  if (car.fuel === "electric") return { speed_kmh: round(motion.speedKmh), battery_v: battery, engine_on: running, mil, dtcs }

  let coolant = running ? 90 + (seed % 4) + 0.6 * n("cool") : 40 + (seed % 6)
  if (fault?.profile === "overheat") coolant = Math.min(124, fault.coolantStart + fault.coolantPerMinute * (seconds / 60)) + 0.4 * n("cool")
  return { speed_kmh: round(motion.speedKmh), coolant_c: round(coolant, 1), battery_v: battery, engine_on: running, mil, dtcs }
}

/** The freeze frame the dongle stores when it sets a code: the readings at that moment. */
export function freezeFrame(car: FleetCar, plan: FaultPlan): { code: string; at: string; values: Record<string, number> } {
  const at = new Date(Date.parse(plan.startedAt) + plan.detectAfterSeconds * 1000)
  const sample = obdSample(car, faultMotion(car, plan, at), at, plan)
  const values: Record<string, number> = {}
  for (const key of ["speed_kmh", "coolant_c", "battery_v"] as const) {
    const value = sample[key]
    if (typeof value === "number") values[key] = value
  }
  return { code: plan.codes[0], at: at.toISOString(), values }
}
