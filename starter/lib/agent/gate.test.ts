// Approval-gate tests. They run against the local database without calling a
// model: the rules they check are enforced in code, whatever the model does.
// Run: npm test (from starter/). Each test cleans up the rows it created.

import "dotenv/config"
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"
import { eq, inArray } from "drizzle-orm"
import { closeCrDb, crDb } from "@/lib/cr/db"
import { appendEvent, createCase, getProposal, listEvents, proposalsWithChangedFacts, resolveOrder, setAutonomy, type CaseRow } from "@/lib/cr/queries"
import { crAgentRuns, crAutonomy, crCases, crEvents, crProposals } from "@/lib/cr/schema"
import type { ActionType } from "@/lib/cr/types"
import { AGENT_ID } from "./config"
import { contextFor, loadOrderFacts, type OrderFacts } from "./context"
import {
  ApprovalRequiredError, DecisionError, checkTool, decideProposal, executeProposal, findClearance, logOutcome, refreshProposal, submitProposal,
  type ProposalInput,
} from "./gate"

const created: string[] = []
let facts: OrderFacts

async function newCase(kind: CaseRow["kind"] = "VEHICLE_WARNING"): Promise<CaseRow> {
  const row = await createCase({ orderId: facts.id, kind, status: "AGENT_WORKING", urgency: "HIGH", title: "Gate test", channelOpened: "system", driverId: "drv-042" })
  created.push(row.id)
  return row
}

function proposal(actionType: ActionType, draft: ProposalInput["draft_message"] = null): ProposalInput {
  return {
    action_type: actionType,
    title: `Test ${actionType}`,
    rationale: "Gate test.",
    handover: { what_happened: "Test.", facts: [], agent_did: [], unknowns: [], recommendation: "Test.", alternatives: [] },
    changes: [{ label: "ETA", before: "Mon 26 Oct 10:00", after: "Tue 27 Oct 10:00" }],
    draft_message: draft,
    options: [],
    evidence_refs: [],
    next_step_if_approved: "Something happens.",
    next_step_if_rejected: "The agent tries something else.",
  }
}

const customerDraft: ProposalInput["draft_message"] = { to: "customer", channel: "email", subject: "Your Bentley", body: "The car has stopped.", language: "en" }

async function effects(caseId: string) {
  return (await listEvents({ caseId })).filter((event) => event.kind === "effect")
}

before(async () => {
  const order = await resolveOrder("CD-420584")
  assert.ok(order, "CD-420584 must be seeded (npm run db:seed)")
  facts = (await loadOrderFacts(order.id))!
  await crDb().delete(crAutonomy)
})

after(async () => {
  const db = crDb()
  if (created.length) {
    await db.delete(crProposals).where(inArray(crProposals.caseId, created))
    await db.delete(crEvents).where(inArray(crEvents.caseId, created))
    await db.delete(crAgentRuns).where(inArray(crAgentRuns.caseId, created))
    await db.delete(crCases).where(inArray(crCases.id, created))
  }
  await db.delete(crAutonomy)
  await closeCrDb()
})

describe("customer contact never happens without a person", () => {
  test("CONTACT_CUSTOMER waits for approval even if the autonomy table says AUTO", async () => {
    // Write AUTO straight into the table, past setAutonomy's own check.
    await crDb().insert(crAutonomy).values({ actionType: "CONTACT_CUSTOMER", level: "AUTO", locked: false })
    const caseRow = await newCase()
    const { proposal: row, executed, level } = await submitProposal({ audience: "operator", caseRow, facts }, proposal("CONTACT_CUSTOMER", customerDraft))
    assert.equal(level, "ASK_FIRST")
    assert.equal(executed, false)
    assert.equal(row.status, "PENDING")
    assert.equal((await effects(caseRow.id)).length, 0, "nothing was sent")
    await crDb().delete(crAutonomy).where(eq(crAutonomy.actionType, "CONTACT_CUSTOMER"))
  })

  test("a pending CONTACT_CUSTOMER cannot be carried out by the agent or anyone else", async () => {
    const caseRow = await newCase()
    const { proposal: row } = await submitProposal({ audience: "operator", caseRow, facts }, proposal("CONTACT_CUSTOMER", customerDraft))
    await assert.rejects(executeProposal(row.id, { by: AGENT_ID }), ApprovalRequiredError)
    await assert.rejects(executeProposal(row.id, { by: "ops-shift" }), ApprovalRequiredError)
    assert.equal((await getProposal(row.id))!.status, "PENDING")
    assert.equal((await effects(caseRow.id)).length, 0)
  })

  test("customer contact cannot be raised above ASK_FIRST", async () => {
    await assert.rejects(setAutonomy("CONTACT_CUSTOMER", "AUTO", "test"), /locked/)
    await assert.rejects(setAutonomy("CONTACT_SITE_AS_CUSTOMER", "DO_AND_TELL", "test"), /locked/)
  })

  test("any action whose draft reaches the customer waits, even at AUTO", async () => {
    await setAutonomy("UPDATE_ETA", "AUTO", "test")
    const caseRow = await newCase()
    const { executed, level } = await submitProposal({ audience: "operator", caseRow, facts }, proposal("UPDATE_ETA", customerDraft))
    assert.equal(level, "ASK_FIRST")
    assert.equal(executed, false)
    await crDb().delete(crAutonomy)
  })

  test("after approval it is carried out once, attributed to the operator, to the customer", async () => {
    const caseRow = await newCase()
    const { proposal: row } = await submitProposal({ audience: "operator", caseRow, facts }, proposal("CONTACT_CUSTOMER", customerDraft))
    const decided = await decideProposal(caseRow.id, row.id, { decision: "approve", decided_by: "ops-shift" })
    assert.equal(decided.status, "EXECUTED")
    const sent = await effects(caseRow.id)
    const toCustomer = sent.find((event) => event.recipientType === "customer")
    assert.ok(toCustomer, "a message to the customer was recorded")
    assert.equal(toCustomer.actorType, "operator")
    assert.equal(toCustomer.actorId, "ops-shift")
    assert.equal(toCustomer.recipientId, facts.customer.id)
    await assert.rejects(decideProposal(caseRow.id, row.id, { decision: "approve", decided_by: "ops-support" }), (error: unknown) => error instanceof DecisionError && error.status === 409)
    assert.equal((await effects(caseRow.id)).length, sent.length, "the second click changed nothing")
  })
})

describe("autonomy levels for other actions", () => {
  test("ASK_FIRST by default; DO_AND_TELL lets the agent act and records it", async () => {
    const caseRow = await newCase()
    const first = await submitProposal({ audience: "operator", caseRow, facts }, proposal("UPDATE_ETA"))
    assert.equal(first.executed, false)
    await setAutonomy("UPDATE_ETA", "DO_AND_TELL", "test")
    const second = await submitProposal({ audience: "operator", caseRow, facts }, proposal("UPDATE_ETA"))
    assert.equal(second.executed, true)
    assert.equal(second.proposal.status, "EXECUTED")
    assert.ok((await effects(caseRow.id)).some((event) => event.actorType === "agent"))
    await crDb().delete(crAutonomy)
  })
})

describe("decisions", () => {
  test("reject needs a reason, and the reason is kept", async () => {
    const caseRow = await newCase()
    const { proposal: row } = await submitProposal({ audience: "operator", caseRow, facts }, proposal("BOOK_RECOVERY"))
    await assert.rejects(decideProposal(caseRow.id, row.id, { decision: "reject", decided_by: "ops-shift" }), (error: unknown) => error instanceof DecisionError && error.status === 400)
    const rejected = await decideProposal(caseRow.id, row.id, { decision: "reject", decided_by: "ops-shift", note: "The dealer sends their own help." })
    assert.equal(rejected.status, "REJECTED")
    assert.equal((await getProposal(row.id))!.decisionNote, "The dealer sends their own help.")
    assert.equal((await effects(caseRow.id)).length, 0)
  })

  test("I'll handle it waits for the outcome, then records it", async () => {
    const caseRow = await newCase()
    const { proposal: row } = await submitProposal({ audience: "operator", caseRow, facts }, proposal("CONTACT_CUSTOMER", { ...customerDraft!, channel: "phone_call" }))
    const handled = await decideProposal(caseRow.id, row.id, { decision: "handle", decided_by: "ops-shift" })
    assert.equal(handled.case_status, "WAITING_EXTERNAL")
    assert.equal((await effects(caseRow.id)).length, 0, "nothing happens until the outcome is logged")
    const logged = await logOutcome(caseRow.id, { text: "Dealer sends their own roadside help, ETA 11:00", logged_by: "ops-shift" })
    assert.equal(logged.status, "EXECUTED")
    const effect = (await effects(caseRow.id))[0]
    assert.equal(effect.actorId, "ops-shift")
    assert.match(effect.body, /Dealer sends their own roadside help/)
  })

  test("a card is flagged when new facts arrive after it, and only then can be refreshed", async () => {
    const caseRow = await newCase()
    const { proposal: row } = await submitProposal({ audience: "operator", caseRow, facts }, proposal("BOOK_RECOVERY"))
    // The agent's and operators' own events do not count as new facts.
    await appendEvent({ caseId: caseRow.id, orderId: facts.id, actorType: "agent", actorId: AGENT_ID, kind: "note", channel: "internal", body: "Note.", at: new Date(row.createdAt.getTime() + 1000) })
    assert.deepEqual(await proposalsWithChangedFacts(caseRow.id), [])
    await assert.rejects(refreshProposal(caseRow.id, row.id, "ops-shift"), (error: unknown) => error instanceof DecisionError && error.status === 409)
    await appendEvent({ caseId: caseRow.id, orderId: facts.id, actorType: "driver", actorId: "drv-042", kind: "message", channel: "driver_chat", body: "The car started again.", at: new Date(row.createdAt.getTime() + 2000) })
    assert.deepEqual((await proposalsWithChangedFacts(caseRow.id)).map((entry) => entry.proposalId), [row.id])
    const refreshed = await refreshProposal(caseRow.id, row.id, "ops-shift")
    assert.equal(refreshed.status, "REJECTED")
    assert.equal((await getProposal(row.id))!.decisionNote, "Set aside: facts changed since it was drafted.")
    assert.equal((await effects(caseRow.id)).length, 0)
  })

  test("an edit may change the message, not who it goes to", async () => {
    const caseRow = await newCase()
    const { proposal: row } = await submitProposal({ audience: "operator", caseRow, facts }, proposal("CONTACT_CUSTOMER", customerDraft))
    const draft = row.draftMessage!
    await assert.rejects(
      decideProposal(caseRow.id, row.id, { decision: "approve", decided_by: "ops-shift", edited_draft_message: { ...draft, to_id: "cus-999" } }),
      (error: unknown) => error instanceof DecisionError && error.status === 400,
    )
    const ok = await decideProposal(caseRow.id, row.id, { decision: "approve", decided_by: "ops-shift", edited_draft_message: { ...draft, body: "Edited text." } })
    assert.equal(ok.status, "EXECUTED")
    assert.ok((await effects(caseRow.id)).some((event) => event.body.includes("Edited text.")))
  })
})

describe("who the agent may reach and what it may see", () => {
  test("ask_site is refused for a site the customer owns, allowed for the seller's pickup desk", async () => {
    const caseRow = await newCase()
    assert.equal(facts.delivery.customerSide, true)
    assert.equal(facts.pickup.customerSide, false)
    assert.equal(checkTool({ audience: "operator", caseRow, facts }, "ask_site", { end: "delivery", text: "Hi" }).ok, false)
    assert.equal(checkTool({ audience: "operator", caseRow, facts }, "ask_site", { end: "pickup", text: "Hi" }).ok, true)
  })

  test("tools are limited per audience, and drivers and sites stay on their own order", async () => {
    const caseRow = await newCase()
    assert.equal(checkTool({ audience: "site", caseRow, facts }, "propose_action", {}).ok, false)
    assert.equal(checkTool({ audience: "site", caseRow, facts }, "get_timeline", { order_ref: "" }).ok, false)
    assert.equal(checkTool({ audience: "driver", caseRow, facts }, "get_order_context", { order_ref: "CD-420299" }).ok, false)
    assert.equal(checkTool({ audience: "driver", caseRow, facts }, "get_order_context", { order_ref: "CD-420584" }).ok, true)
    assert.equal(checkTool({ audience: "operator", caseRow, facts }, "get_order_context", { order_ref: "CD-420299" }).ok, true)
  })

  test("the Ask box only reads", async () => {
    const caseRow = await newCase()
    const ctx = { audience: "operator" as const, caseRow, facts, readOnly: true }
    assert.equal(checkTool(ctx, "get_order_context", { order_ref: "" }).ok, true)
    for (const tool of ["message_driver", "propose_action", "safety_instruction", "update_case", "close_case"]) {
      assert.equal(checkTool(ctx, tool, {}).ok, false, tool)
    }
  })

  test("a site sees its own end only: no customer, no prices, no internal records", async () => {
    const view = JSON.stringify(await contextFor("site", facts, { siteEnd: "pickup" }))
    assert.ok(!view.includes(facts.customer.name), "customer name hidden")
    assert.ok(!/€|EUR|fee/i.test(view), "no prices")
    assert.ok(!view.includes("open_records") && !view.includes("expense"), "no internal records")
    assert.ok(view.includes(facts.reference))
  })

  test("serious cases cannot be closed by the agent", async () => {
    const warning = await newCase("VEHICLE_WARNING")
    const question = await newCase("DRIVER_QUESTION")
    assert.equal(checkTool({ audience: "driver", caseRow: warning, facts }, "close_case", { summary: "x" }).ok, false)
    assert.equal(checkTool({ audience: "driver", caseRow: question, facts }, "close_case", { summary: "x" }).ok, true)
  })
})

describe("never clear a driver to drive on", () => {
  const clears = [
    "You can keep driving to the next exit.",
    "It's safe to continue now.",
    "You're fine to drive on.",
    "Feel free to carry on towards Hamburg.",
    "The light is amber, so you may continue.",
  ]
  const safe = [
    "Please stop at the next safe place and switch the engine off.",
    "It is not safe to drive the car any further.",
    "Do not drive on until an operator confirms you can continue.",
    "An operator will decide whether you can drive on.",
    "Nobody has cleared onward driving yet.",
    "Please wait; we will tell you once you can continue.",
  ]
  for (const text of clears) test(`blocks: ${text}`, () => assert.ok(findClearance(text)))
  for (const text of safe) test(`allows: ${text}`, () => assert.equal(findClearance(text), null))

  test("safety_instruction refuses a clearance", async () => {
    const caseRow = await newCase()
    assert.equal(checkTool({ audience: "driver", caseRow, facts }, "safety_instruction", { text: "You can continue driving slowly." }).ok, false)
    assert.equal(checkTool({ audience: "driver", caseRow, facts }, "safety_instruction", { text: "Stop at the next safe place and switch off." }).ok, true)
  })
})
