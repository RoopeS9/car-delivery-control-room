// The autopilot's summary of a call: what the person said, in one sentence, and what of it may need a decision.
// Pure; the scheduler itself is exercised against the running app (PROCESS.md).

import assert from "node:assert/strict"
import { test } from "node:test"
import type { CallRecord } from "@/lib/present/call-types"
import { summarizeCall } from "./autopilot"

function record(outcome: string, slots: { slot: string; value: unknown; quote?: string }[]): CallRecord {
  return {
    id: "call-1", orderId: "ord-1", brief: null, direction: "OUTBOUND", startedAt: "2026-10-21T09:30:00Z", endedAt: "2026-10-21T09:32:00Z",
    outcome, triage: null, toolCalls: [], turns: [], retryAfter: null,
    slots: slots.map((entry, index) => ({ value: { slot: entry.slot, value: entry.value } as never, turnSeq: index + 1, quote: entry.quote ?? "" })),
  } as unknown as CallRecord
}

test("a position check that found nothing wrong reads as one calm sentence, with nothing urgent", () => {
  const { summary, urgent } = summarizeCall(record("COMPLETED", [
    { slot: "CURRENT_LOCATION", value: "Osnabrück, on the A1" }, { slot: "ETA", value: "2026-10-21T11:40:00Z" }, { slot: "DRIVER_SAFE", value: true }, { slot: "WARNING_LIGHT", value: "NONE" },
  ]))
  assert.equal(summary, "near Osnabrück, on the A1, ETA 11:40 UTC, the driver is fine, no warning light")
  assert.deepEqual(urgent, [])
})

test("a flashing light, a car that will not move or a missing release is urgent, with the person's words; a no-answer is too", () => {
  const light = summarizeCall(record("COMPLETED", [{ slot: "WARNING_LIGHT", value: "AMBER_FLASHING" }, { slot: "CAR_MOVES", value: false, quote: "It won't start again." }]))
  assert.equal(light.summary, "warning light amber flashing, the car will not move")
  assert.deepEqual(light.urgent, ["a amber flashing warning light", 'the car will not move (they said: "It won\'t start again.")'])
  const site = summarizeCall(record("COMPLETED", [{ slot: "VEHICLE_PRESENT", value: true }, { slot: "RELEASE_DOCUMENT_PRESENT", value: false }, { slot: "RELEASE_CONTACT_NAME", value: "Mika at the desk" }]))
  assert.equal(site.summary, "the car is at the site, Mika at the desk releases the car, no signed release")
  assert.deepEqual(site.urgent, ["the signed release is missing"])
  const silent = summarizeCall(record("NO_ANSWER", []))
  assert.equal(silent.summary, "no answer")
  assert.deepEqual(silent.urgent, ["no answer"])
  const early = summarizeCall(record("PARTIAL", [{ slot: "FERRY_CHECKED_IN", value: true }]))
  assert.equal(early.summary, "checked in for the ferry; the call ended early")
})

test("the extractor's slips do not become alarms: 'none' is no issue, 'near near' is near, an ETA before the call is dropped", () => {
  const { summary, urgent } = summarizeCall(record("COMPLETED", [
    { slot: "CURRENT_LOCATION", value: "near last position" }, { slot: "ETA", value: "2026-10-21T09:00:00Z" }, { slot: "ISSUE_REPORTED", value: "none" },
    { slot: "DRIVER_SAFE", value: false, quote: "No, I'm on the road right now, but everything's fine." },
  ]))
  assert.equal(summary, "near last position, the driver may not be safe")
  assert.deepEqual(urgent, ['the driver may not be safe (they said: "No, I\'m on the road right now, but everything\'s fine.")'])
})
