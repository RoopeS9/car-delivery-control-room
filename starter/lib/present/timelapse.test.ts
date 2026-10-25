import assert from "node:assert/strict"
import { test } from "node:test"
import { buildTimelapse, CALM_HOLD, FADE, NAMED, phaseAt, simTimeAt, tallyAt, type TimelapseOrder } from "./timelapse"

const orders: TimelapseOrder[] = Array.from({ length: 40 }, (_, i) => ({
  orderId: `ord-${String(i + 1).padStart(5, "0")}`, reference: `CD-4200${String(i + 10).padStart(2, "0")}`, vehicle: `Car ${i}`, driver: `Driver ${i}`,
  problem: i % 3 === 0 ? "Phone has gone quiet" : null,
}))
for (const entry of NAMED) orders.push({ orderId: `ord-${entry.reference}`, reference: entry.reference, vehicle: "Named", driver: "Named driver", problem: null })

const DURATION = 15
const events = buildTimelapse(orders, 7, DURATION)
const peak = (list = events, from = 0, to = DURATION) => {
  let best = { count: 0, at: 0 }
  for (let t = from; t <= to; t += 0.05) {
    const count = tallyAt(list, t).needAPerson
    if (count > best.count) best = { count, at: t }
  }
  return best
}

test("the same seed gives the same storyline, another seed another", () => {
  assert.deepEqual(buildTimelapse(orders, 7, DURATION), events)
  assert.notDeepEqual(buildTimelapse(orders, 8, DURATION).map((e) => e.start), events.map((e) => e.start))
})

test("about 24 events, each ends after it starts, in order, and has faded before the calm frame", () => {
  assert.equal(events.length, 24)
  for (const event of events) {
    assert.ok(event.start >= 0 && event.start < event.agentFrom && event.agentFrom < event.agentUntil, event.id)
    assert.ok(event.end >= event.agentUntil && event.end > event.start, event.id)
    assert.ok(event.end + FADE <= DURATION - CALM_HOLD + 1e-9, `${event.id} fades after the calm frame starts`)
    const work = event.agentUntil - event.agentFrom
    assert.ok(work >= 1 - 1e-9 && work <= 3 + 1e-9, `${event.id} agent works ${work}s`)
    if (event.outcome === "person") assert.ok(event.end - event.agentUntil >= 2 - 1e-9 && event.end - event.agentUntil <= 4 + 1e-9, event.id)
  }
  assert.deepEqual(events.map((e) => e.start), [...events.map((e) => e.start)].sort((a, b) => a - b))
})

test("most events are cleared by the agent, a few need a person", () => {
  const people = events.filter((event) => event.outcome === "person").length
  assert.ok(people >= 5 && people <= 9, `${people} people`)
  assert.ok(events.length - people > people * 1.5)
})

test("the number needing a person never goes below zero, peaks at 6 to 8 near the middle and ends at zero", () => {
  for (let t = 0; t <= DURATION; t += 0.05) assert.ok(tallyAt(events, t).needAPerson >= 0)
  const top = peak()
  assert.ok(top.count >= 6 && top.count <= 8, `peak ${top.count}`)
  assert.ok(top.at > DURATION * 0.3 && top.at < DURATION * 0.7, `peak at ${top.at}`)
  assert.equal(tallyAt(events, DURATION - CALM_HOLD).needAPerson, 0)
  assert.ok(events.every((event) => phaseAt(event, DURATION - CALM_HOLD) === "none"))
})

test("every event refers to an order that exists, once", () => {
  const known = new Set(orders.map((order) => order.orderId))
  assert.ok(events.every((event) => known.has(event.orderId)))
  assert.equal(new Set(events.map((event) => event.orderId)).size, events.length)
})

test("the four named scenarios are present with the outcomes the video shows", () => {
  for (const entry of NAMED) {
    const event = events.find((candidate) => candidate.scenario === entry.scenario)
    assert.ok(event, entry.scenario)
    assert.equal(event.reference, entry.reference)
    assert.equal(event.outcome, entry.outcome)
  }
})

test("the tallies equal the events shown", () => {
  const end = tallyAt(events, DURATION)
  assert.equal(end.agentHandled, events.filter((event) => event.outcome === "agent").length)
  assert.equal(end.personDecided, events.filter((event) => event.outcome === "person").length)
  assert.equal(end.agentHandled + end.personDecided, events.length)
  assert.deepEqual(tallyAt(events, 0), { needAPerson: 0, agentHandled: 0, personDecided: 0 })
})

test("a shorter or longer run keeps the shape", () => {
  for (const duration of [8, 30]) {
    const list = buildTimelapse(orders, 7, duration)
    assert.equal(list.length, 24)
    assert.ok(list.every((event) => event.end + FADE <= duration - CALM_HOLD + 1e-9))
    const top = peak(list, 0, duration)
    assert.ok(top.count >= 6 && top.count <= 8, `peak ${top.count} at ${duration}s`)
  }
})

test("the simulated clock runs from 09:00 to 21:00 UTC and holds on the calm frame", () => {
  assert.equal(simTimeAt(0, DURATION).toISOString(), "2026-10-21T09:00:00.000Z")
  assert.equal(simTimeAt(DURATION - CALM_HOLD, DURATION).toISOString(), "2026-10-21T21:00:00.000Z")
  assert.equal(simTimeAt(DURATION, DURATION).toISOString(), "2026-10-21T21:00:00.000Z")
})
