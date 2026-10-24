import "dotenv/config"
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { inArray } from "drizzle-orm"
import { closeCrDb, crDb } from "./db"
import { appendEvent, attachEvents, createCase, EventScopeError, getEvent } from "./queries"
import { crCases, crEvents } from "./schema"

const cases: string[] = [], events: string[] = []
after(async () => {
  if (events.length) await crDb().delete(crEvents).where(inArray(crEvents.id, events))
  if (cases.length) await crDb().delete(crCases).where(inArray(crCases.id, cases))
  await closeCrDb()
})

test("evidence attachments are atomic and cannot move between orders or cases", async () => {
  const target = await createCase({ orderId: "ord-00917", kind: "DRIVER_QUESTION", status: "AGENT_WORKING", urgency: "NORMAL", title: "Evidence scope check", channelOpened: "system" })
  const other = await createCase({ orderId: "ord-00917", kind: "DRIVER_QUESTION", status: "AGENT_WORKING", urgency: "NORMAL", title: "Separate evidence case", channelOpened: "system" })
  cases.push(target.id, other.id)
  const own = await appendEvent({ orderId: target.orderId, actorType: "driver", kind: "photo", channel: "driver_chat", body: "Own fictional photo" })
  const foreign = await appendEvent({ orderId: "ord-00584", actorType: "driver", kind: "photo", channel: "driver_chat", body: "Another order's fictional photo" })
  events.push(own.id, foreign.id)
  await assert.rejects(attachEvents([own.id, foreign.id], target.id), EventScopeError)
  assert.equal((await getEvent(own.id))?.caseId, null, "an invalid batch changes none of its evidence")
  assert.equal((await getEvent(foreign.id))?.caseId, null)
  await assert.rejects(attachEvents([own.id, "missing-evidence"], target.id), EventScopeError)
  await attachEvents([own.id, own.id], target.id)
  assert.equal((await getEvent(own.id))?.caseId, target.id)
  await assert.rejects(attachEvents([own.id], other.id), EventScopeError)
  assert.equal((await getEvent(own.id))?.caseId, target.id)
})
