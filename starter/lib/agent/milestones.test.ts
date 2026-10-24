// The delivery's steps reported in the driver app: who may report them, in which order, how the snapshot reads after
// them, and that a handover brings operations the customer's confirmation as a card (never a sent message).
// Needs a seeded database (npm run db:seed).

import "dotenv/config"
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"
import { eq, inArray } from "drizzle-orm"
import { closeCrDb, crDb } from "@/lib/cr/db"
import { lifecycleOf, nextMilestone, overlayStatus, syntheticEvents } from "@/lib/cr/lifecycle"
import { listEffects, listProposals, resolveOrder } from "@/lib/cr/queries"
import { crCases, crEvents, crProposals } from "@/lib/cr/schema"
import { loadOrderFacts } from "./context"
import { recordMilestone } from "./milestones"

const ORDER = "CD-420442"
const DRIVER = "drv-165"
let orderId = ""

async function clear() {
  const db = crDb()
  const cases = (await db.select({ id: crCases.id }).from(crCases).where(eq(crCases.orderId, orderId))).map((row) => row.id)
  if (cases.length) await db.delete(crProposals).where(inArray(crProposals.caseId, cases))
  await db.delete(crEvents).where(eq(crEvents.orderId, orderId))
  await db.delete(crCases).where(eq(crCases.orderId, orderId))
}

before(async () => {
  orderId = (await resolveOrder(ORDER))!.id
  await clear()
})

after(async () => {
  await clear()
  await closeCrDb()
})

describe("delivery steps reported in the driver app", () => {
  test("only the assigned driver reports, and steps go in order", async () => {
    await assert.rejects(recordMilestone({ orderRef: ORDER, driverId: "drv-042", milestone: "ARRIVED_PICKUP" }), /not on an active assignment/)
    await assert.rejects(recordMilestone({ orderRef: ORDER, driverId: DRIVER, milestone: "DELIVERED", receiverName: "Someone" }), /collection first/)
  })

  test("a collection puts the order on the road for every reader", async () => {
    const result = await recordMilestone({ orderRef: ORDER, driverId: DRIVER, milestone: "COLLECTED", keys: 2 })
    assert.equal(result.next, "CHECKED_IN", "the trip has a booked ferry")
    await assert.rejects(recordMilestone({ orderRef: ORDER, driverId: DRIVER, milestone: "COLLECTED" }), /already recorded/)
    await assert.rejects(recordMilestone({ orderRef: ORDER, driverId: DRIVER, milestone: "ARRIVED_PICKUP" }), /later step/)
    const facts = (await loadOrderFacts(orderId))!
    assert.equal(facts.status, "IN_TRANSIT")
    assert.equal(facts.assignments.find((row) => row.driver_id === DRIVER)?.status, "IN_PROGRESS")
  })

  test("a check-in reads as the ferry's simulated gate scan", async () => {
    await recordMilestone({ orderRef: ORDER, driverId: DRIVER, milestone: "CHECKED_IN" })
    const facts = (await loadOrderFacts(orderId))!
    const ferry = facts.reservations.find((row) => row.kind === "FERRY" && row.status === "BOOKED")
    assert.equal(ferry?.check_in_confirmation, "CONFIRMED_BY_GATE_SCAN")
    assert.match(String(ferry?.check_in_source), /simulated/)
  })

  test("a handover needs the receiver and brings a confirmation card, nothing sent", async () => {
    await assert.rejects(recordMilestone({ orderRef: ORDER, driverId: DRIVER, milestone: "DELIVERED" }), /who took the car/)
    const result = await recordMilestone({ orderRef: ORDER, driverId: DRIVER, milestone: "DELIVERED", receiverName: "Mikko Rautio", keys: 2 })
    assert.equal(result.next, null)
    assert.ok(result.caseId)
    const [card] = await listProposals({ caseId: result.caseId!, statuses: ["PENDING"] })
    assert.equal(card.actionType, "CONTACT_CUSTOMER")
    assert.match(card.draftMessage!.body, /Mikko Rautio/)
    assert.equal((await listEffects({ caseId: result.caseId! })).length, 0, "nothing reached the customer")
    assert.equal((await loadOrderFacts(orderId))!.status, "DELIVERED")
  })

  test("the overlay speaks the dataset's own event language", async () => {
    const lifecycle = await lifecycleOf(orderId)
    assert.equal(overlayStatus("WAITING_FOR_PICKUP", lifecycle), "DELIVERED")
    assert.equal(nextMilestone(lifecycle, true), null)
    const events = syntheticEvents(orderId, lifecycle, [{ id: "p1", role: "PICKUP" }, { id: "p2", role: "DELIVERY" }], "seg-1", "WAITING_FOR_PICKUP")
    assert.deepEqual(events.map((row) => row.command), ["assignment.started", "vehicle.picked_up", "order.status_changed", "vehicle.delivered", "assignment.completed", "order.status_changed"])
    assert.ok(events.every((row) => row.simulated === true))
  })
})
