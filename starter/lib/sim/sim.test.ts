// Simulator tests. They read the seeded dataset (no writes, no model) and
// check the promises the demo relies on: positions only where the app
// reported, OBD limited to decision signals, faults that play out as scripted,
// and route shapes that start where they should.
// Run: npm test (from starter/).

import "dotenv/config"
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"
import { closeCrDb } from "@/lib/cr/db"
import { loadFleet, type FleetCar } from "./fleet"
import { cityPoint, haversineKm, terminalPoint } from "./geo"
import { baseMotion, faultMotion, freezeFrame, motionAt, obdSample, obdSilentFrom, type MisfirePlan, type OverheatPlan } from "./motion"
import routeFile from "@/knowledge/routes/routes.json"

let fleet: FleetCar[]
const car = (reference: string) => {
  const found = fleet.find((candidate) => candidate.reference === reference)
  assert.ok(found, `${reference} should be on the road`)
  return found
}
const at = (iso: string) => new Date(iso)

before(async () => { fleet = await loadFleet({ fresh: true }) })
after(async () => { await closeCrDb() })

describe("fleet", () => {
  test("a moving car is an in-progress assignment, trade-in returns included", () => {
    assert.equal(fleet.length, 25)
    assert.equal(car("CD-420055").vehicleTitle, "Volvo V60", "the trade-in return, not the delivered primary car")
  })

  test("phones say only what the data supports", () => {
    assert.equal(car("CD-420735").phone, "NONE", "never reported on this trip")
    assert.equal(car("CD-420322").phone, "STALE", "open tracking-gap alert")
    assert.equal(car("CD-420537").phone, "STALE", "scenario F: silent since 08:02")
    assert.equal(car("CD-420584").phone, "LIVE")
    assert.ok(car("CD-420322").stoppedNote, "the dataset's safety stop keeps the car still")
  })

  test("only the scenario cars carry a dongle", () => {
    assert.deepEqual(fleet.filter((candidate) => candidate.obd).map((candidate) => candidate.reference).sort(), ["CD-420145", "CD-420537", "CD-420584"])
  })
})

describe("routes", () => {
  test("every road leg starts at its city or terminal", () => {
    const routes = routeFile as unknown as { road: Record<string, { coords: [number, number][] }> }
    for (const [key, leg] of Object.entries(routes.road)) {
      const [from] = key.split(">")
      const start = from.startsWith("terminal:") ? terminalPoint(from.slice(9))?.point : cityPoint(...(from.slice(5).split("|") as [string, string]))
      assert.ok(start, `${key} has a known start`)
      assert.ok(haversineKm(start, leg.coords[0]) < 15, `${key} starts ${haversineKm(start, leg.coords[0]).toFixed(1)} km from its start point`)
    }
  })

  test("a ferry car waits at the terminal before departure and crosses only after it", () => {
    const ferryCar = car("CD-420584")
    assert.ok(ferryCar.ferry)
    const beforeDeparture = baseMotion(ferryCar, new Date(ferryCar.ferry.departureAt.getTime() - 60_000))
    assert.equal(beforeDeparture.state, "AT_TERMINAL")
    const midCrossing = baseMotion(ferryCar, new Date((ferryCar.ferry.departureAt.getTime() + ferryCar.ferry.arrivalAt.getTime()) / 2))
    assert.equal(midCrossing.state, "ON_FERRY")
  })
})

describe("OBD", () => {
  const allowed = new Set(["speed_kmh", "coolant_c", "battery_v", "engine_on", "mil", "dtcs", "freeze_frame"])

  test("frames carry only decision signals", () => {
    const time = at("2026-10-21T09:10:00Z")
    for (const reference of ["CD-420584", "CD-420537", "CD-420145", "CD-420071"]) {
      const subject = car(reference)
      const frame = obdSample(subject, baseMotion(subject, time), time, null)
      for (const key of Object.keys(frame)) assert.ok(allowed.has(key), `${reference} reports ${key}`)
      if (subject.fuel === "electric") assert.equal(frame.coolant_c, undefined, "electric cars report fewer signals")
    }
  })

  test("scenario A: the misfire limps, stops and switches off, codes after detection", () => {
    const subject = car("CD-420584")
    const start = at("2026-10-21T09:05:00Z")
    const base = baseMotion(subject, start)
    const plan: MisfirePlan = {
      profile: "misfire", startedAt: start.toISOString(), kmAtStart: base.km, speedAtStart: base.speedKmh, codes: ["P0300", "P0302"],
      detectAfterSeconds: 6, limpKmh: 70, limpSeconds: 50, rampSeconds: 35, engineOffAfterSeconds: 90, stopLabel: "Test service area",
    }
    const second = (s: number) => new Date(start.getTime() + s * 1000)
    assert.deepEqual(obdSample(subject, motionAt(subject, second(3), plan), second(3), plan).dtcs, [], "no code before detection")
    const limping = obdSample(subject, motionAt(subject, second(30), plan), second(30), plan)
    assert.equal(limping.mil, "FLASHING")
    assert.deepEqual(limping.dtcs, ["P0300", "P0302"])
    assert.equal(motionAt(subject, second(100), plan).state, "STOPPED_IDLING")
    const off = motionAt(subject, second(200), plan)
    assert.equal(off.state, "STOPPED_ENGINE_OFF")
    assert.equal(obdSample(subject, off, second(200), plan).mil, "ON", "light stays on, no longer flashing, once the engine stops")
    assert.equal(faultMotion(subject, plan, second(500)).km, off.km, "a stopped car does not move")
    assert.equal(freezeFrame(subject, plan).at, second(6).toISOString())

    // An operator clears the repaired car: it drives on from where it stopped, light off, no codes.
    const repaired: MisfirePlan = { ...plan, resumedAt: second(3600).toISOString() }
    assert.equal(faultMotion(subject, repaired, second(3000)).km, off.km, "still stopped before the clearance")
    const onward = motionAt(subject, second(3600 + 1800), repaired)
    assert.equal(onward.state, "DRIVING")
    assert.ok(onward.km > off.km + 20, "half an hour later it is well past the stop")
    const frame = obdSample(subject, onward, second(3600 + 1800), repaired)
    assert.equal(frame.mil, "OFF")
    assert.deepEqual(frame.dtcs, [])
  })

  test("scenario F: coolant climbs, P0217 is set, then the dongle goes quiet while the car moves", () => {
    const subject = car("CD-420537")
    const start = at("2026-10-21T09:05:00Z")
    const base = baseMotion(subject, start)
    const plan: OverheatPlan = {
      profile: "overheat", startedAt: start.toISOString(), kmAtStart: base.km, speedAtStart: base.speedKmh, codes: ["P0217"],
      detectAfterSeconds: 90, coolantStart: 97, coolantPerMinute: 13, silentAfterSeconds: 150, notifyOrigin: "http://localhost:3000",
    }
    const frame = (s: number) => { const time = new Date(start.getTime() + s * 1000); return obdSample(subject, motionAt(subject, time, plan), time, plan) }
    assert.ok((frame(80).coolant_c ?? 0) > (frame(20).coolant_c ?? 0), "coolant rises")
    assert.deepEqual(frame(80).dtcs, [])
    assert.deepEqual(frame(95).dtcs, ["P0217"])
    assert.equal(frame(95).mil, "ON")
    assert.equal(obdSilentFrom(plan)?.toISOString(), new Date(start.getTime() + 150_000).toISOString())
    assert.ok((frame(149).speed_kmh ?? 0) > 0, "still moving when the dongle stops")
  })
})
