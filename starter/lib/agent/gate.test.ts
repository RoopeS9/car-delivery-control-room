// Approval-gate tests (PLAN.md section 7, M1). They run against the local
// database without calling a model: the rules they check are enforced in
// code, whatever the model does. Run: npm test (from starter/).

import "dotenv/config"
// These tests never call a model, even on a machine with a key.
delete process.env.OPENROUTER_API_KEY

import assert from "node:assert/strict"
import { after, before, describe, mock, test } from "node:test"
import { eq, inArray, sql } from "drizzle-orm"
import { simNow } from "@/lib/cr/clock"
import { closeCrDb, crDb } from "@/lib/cr/db"
import { effectiveOrder } from "@/lib/cr/effective"
import {
  appendEvent, createCase, createProposal, getCase, getProposal, listEffects, listEvents, listProposals, proposalsWithChangedFacts, resolveOrder, setAutonomy,
  updateCase, type CaseRow,
} from "@/lib/cr/queries"
import { crAgentRuns, crAutonomy, crCases, crEffects, crEvents, crProposals, crTelemetry } from "@/lib/cr/schema"
import { relatedRecords } from "@/lib/schema"
import type { ActionType } from "@/lib/cr/types"
import { useTestLlm } from "./client"
import { AGENT_ID } from "./config"
import { getSiteContext, loadOrderFacts, type OrderFacts } from "./context"
import { findClearance, screenDriverMessage } from "./drivability"
import {
  ApprovalRequiredError, DecisionError, checkTool, decideProposal, executeProposal, logOutcome, recordCustomerAnswer, refreshProposal,
  submitProposal, type ProposalInput,
} from "./gate"
import { withCaseLock } from "./loop"
import { tick } from "./tick"
import { ChannelError, prepareDriverMessage } from "./triggers"
import { searchTravelOptions } from "./mocks"

const created: string[] = []
let facts: OrderFacts

async function newCase(kind: CaseRow["kind"] = "VEHICLE_WARNING", order: OrderFacts = facts): Promise<CaseRow> {
  const row = await createCase({ orderId: order.id, kind, status: "AGENT_WORKING", urgency: "HIGH", title: "Gate test", channelOpened: "system", driverId: "drv-042" })
  created.push(row.id)
  return row
}

function proposal(actionType: ActionType, overrides: Partial<ProposalInput> = {}): ProposalInput {
  return {
    action_type: actionType,
    title: `Test ${actionType}`,
    rationale: "Gate test.",
    handover: { what_happened: "Test.", facts: [], agent_did: [], unknowns: [], recommendation: "Test.", alternatives: [] },
    changes: [{ label: "ETA", before: "Mon 26 Oct 10:00", after: "Tue 27 Oct 10:00" }],
    draft_message: null,
    options: [],
    evidence_refs: [],
    assumptions: [],
    proposed_window: null,
    next_step_if_approved: "Something happens.",
    next_step_if_rejected: "The agent tries something else.",
    ...overrides,
  }
}

async function travelProposal(caseRow: CaseRow, overrides: Partial<ProposalInput> = {}): Promise<ProposalInput> {
  const result = searchTravelOptions({ kind: "ferry", from: "West Baltic Vehicle Terminal", to: "South Finland Vehicle Terminal", after_utc: simNow().toISOString() })
  await appendEvent({ caseId: caseRow.id, orderId: caseRow.orderId, actorType: "agent", actorId: AGENT_ID, kind: "lookup", channel: "internal", body: "Travel quote test", data: { tool: "search_travel_options", quote_selections: result.options.map((option) => option.booking_selection) }, sourceRefs: [result.source] })
  return proposal("BOOK_TRAVEL", { booking_selection: result.options[0].booking_selection, ...overrides })
}

const customerDraft: ProposalInput["draft_message"] = { to: "customer", channel: "email", subject: "Your Bentley", body: "The car has stopped.", language: "en" }

async function effectEvents(caseId: string) {
  return (await listEvents({ caseId })).filter((event) => event.kind === "effect" || (event.actorType === "operator" && event.kind === "message"))
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
    await db.delete(crEffects).where(inArray(crEffects.caseId, created))
    await db.delete(crEvents).where(inArray(crEvents.caseId, created))
    await db.delete(crAgentRuns).where(inArray(crAgentRuns.caseId, created))
    await db.delete(crCases).where(inArray(crCases.id, created))
  }
  await db.delete(crAutonomy)
  await closeCrDb()
})

describe("M1: a CONTACT_CUSTOMER action cannot execute without approval", () => {
  test("it waits for a person even if the autonomy table says AUTO", async () => {
    // Write AUTO straight into the table, past setAutonomy's own check.
    await crDb().insert(crAutonomy).values({ actionType: "CONTACT_CUSTOMER", level: "AUTO", locked: false })
    const caseRow = await newCase()
    const { proposal: row, executed, level } = await submitProposal({ audience: "operator", caseRow, facts }, proposal("CONTACT_CUSTOMER", { draft_message: customerDraft }))
    assert.equal(level, "ASK_FIRST")
    assert.equal(executed, false)
    assert.equal(row.status, "PENDING")
    assert.equal((await effectEvents(caseRow.id)).length, 0, "nothing was sent")
    assert.equal((await listEffects({ caseId: caseRow.id })).length, 0)
    await crDb().delete(crAutonomy).where(eq(crAutonomy.actionType, "CONTACT_CUSTOMER"))
  })

  test("a pending card cannot be carried out by the agent or by anyone else", async () => {
    const caseRow = await newCase()
    const { proposal: row } = await submitProposal({ audience: "operator", caseRow, facts }, proposal("CONTACT_CUSTOMER", { draft_message: customerDraft }))
    await assert.rejects(executeProposal(row.id, { by: AGENT_ID }), ApprovalRequiredError)
    await assert.rejects(executeProposal(row.id, { by: "ops-shift" }), ApprovalRequiredError)
    assert.equal((await getProposal(row.id))!.status, "PENDING")
    assert.equal((await listEffects({ caseId: caseRow.id })).length, 0)
  })

  test("customer contact cannot be raised above ASK_FIRST, and any draft to the customer waits", async () => {
    await assert.rejects(setAutonomy("CONTACT_CUSTOMER", "AUTO", "test"), /locked/)
    await assert.rejects(setAutonomy("CONTACT_SITE_AS_CUSTOMER", "DO_AND_TELL", "test"), /locked/)
    await setAutonomy("UPDATE_ETA", "AUTO", "test")
    const caseRow = await newCase()
    const { executed, level } = await submitProposal({ audience: "operator", caseRow, facts }, proposal("UPDATE_ETA", {
      draft_message: customerDraft, proposed_window: { start_utc: "2026-10-27T08:00:00Z", end_utc: "2026-10-27T14:00:00Z" },
    }))
    assert.equal(level, "ASK_FIRST")
    assert.equal(executed, false)
    await crDb().delete(crAutonomy)
  })

  test("after approval it runs once, as a MESSAGE_SENT effect attributed to the operator", async () => {
    const caseRow = await newCase()
    const { proposal: row } = await submitProposal({ audience: "operator", caseRow, facts }, proposal("CONTACT_CUSTOMER", { draft_message: customerDraft }))
    const decided = await decideProposal(caseRow.id, row.id, { decision: "approve", decided_by: "ops-shift" })
    assert.equal(decided.status, "EXECUTED")
    const [sent] = await listEffects({ caseId: caseRow.id, kinds: ["MESSAGE_SENT"] })
    assert.equal(sent.authority.by, "ops-shift")
    assert.equal(sent.authority.by_type, "operator")
    assert.equal(sent.value.to_id, facts.customer.id)
    const after = await getCase(caseRow.id)
    assert.equal(after?.status, "WAITING_EXTERNAL")
    assert.equal(after?.waitingFor, "customer")
    assert.ok(after?.nextCheckAt, "a next check time is set")
  })
})

describe("M1: approving CHANGE_PROMISE does not change the effective promise", () => {
  test("only the customer's recorded agreement moves the promise", async () => {
    const caseRow = await newCase()
    const original = (await effectiveOrder(facts.id)).promise!
    const window = { start_utc: "2026-10-27T08:00:00Z", end_utc: "2026-10-27T14:00:00Z" }
    const { proposal: row } = await submitProposal({ audience: "operator", caseRow, facts }, proposal("CHANGE_PROMISE", {
      draft_message: { ...customerDraft!, body: "Could we deliver on 27 Oct instead?" }, proposed_window: window,
    }))
    const decided = await decideProposal(caseRow.id, row.id, { decision: "approve", decided_by: "ops-shift" })
    assert.equal(decided.status, "EXECUTED")
    const afterApproval = (await effectiveOrder(facts.id)).promise!
    assert.equal(afterApproval.start_utc, original.start_utc, "approval alone does not move the promise")
    assert.equal(afterApproval.end_utc, original.end_utc)
    assert.equal(afterApproval.pending.length, 1, "the proposed date is pending with the customer")
    assert.equal((await getCase(caseRow.id))?.waitingFor, "customer")

    await recordCustomerAnswer(caseRow.id, { answer: "agreed", note: "Dealer agreed to 27 Oct on the phone.", logged_by: "ops-shift" })
    const agreed = (await effectiveOrder(facts.id)).promise!
    assert.equal(agreed.start_utc, window.start_utc)
    assert.equal(agreed.end_utc, window.end_utc)
    assert.match(agreed.basis, /Customer agreed/)
    assert.equal(agreed.pending.length, 0)
    // Clean the agreed promise so other tests see the dataset promise again.
    await crDb().delete(crEffects).where(eq(crEffects.caseId, caseRow.id))
  })

  test("a declined answer leaves the promise as it was", async () => {
    const caseRow = await newCase()
    const original = (await effectiveOrder(facts.id)).promise!
    const { proposal: row } = await submitProposal({ audience: "operator", caseRow, facts }, proposal("CHANGE_PROMISE", {
      draft_message: customerDraft, proposed_window: { start_utc: "2026-10-28T08:00:00Z", end_utc: "2026-10-28T14:00:00Z" },
    }))
    await decideProposal(caseRow.id, row.id, { decision: "approve", decided_by: "ops-shift" })
    await recordCustomerAnswer(caseRow.id, { answer: "declined", note: "Dealer needs the original date.", logged_by: "ops-shift" })
    assert.equal((await effectiveOrder(facts.id)).promise!.start_utc, original.start_utc)
    await crDb().delete(crEffects).where(eq(crEffects.caseId, caseRow.id))
  })
})

describe("M1: an OUTDATED proposal does not execute", () => {
  test("a changed record makes the card outdated at approval; nothing runs", async () => {
    const caseRow = await newCase()
    const ferry = facts.reservations[0]
    const { proposal: row } = await submitProposal({ audience: "operator", caseRow, facts }, await travelProposal(caseRow, {
      assumptions: [{ kind: "record", table: "travel_reservations", id: String(ferry.id), field: "status", expected: "CANCELLED", label: "The original ferry booking is cancelled" }],
    }))
    const decided = await decideProposal(caseRow.id, row.id, { decision: "approve", decided_by: "ops-shift" })
    assert.equal(decided.status, "OUTDATED")
    assert.equal(decided.outdated?.[0]?.now, "booked", "plain words for the card")
    assert.equal((await listEffects({ caseId: caseRow.id })).length, 0, "nothing was booked")
    await assert.rejects(decideProposal(caseRow.id, row.id, { decision: "reject", decided_by: "ops-shift", note: "x" }), DecisionError)
    assert.equal((await getCase(caseRow.id))?.status, "AGENT_WORKING", "the agent redrafts")
  })

  test("a new driver message after the card was drafted outdates it", async () => {
    const caseRow = await newCase()
    const { proposal: row } = await submitProposal({ audience: "operator", caseRow, facts }, proposal("CONTACT_CUSTOMER", {
      draft_message: customerDraft,
      assumptions: [{ kind: "no_new_message", from: "driver", after: simNow().toISOString(), label: "No new driver message" }],
    }))
    await appendEvent({ caseId: caseRow.id, orderId: facts.id, actorType: "driver", actorId: "drv-042", kind: "message", channel: "driver_chat", body: "The car started again.", at: new Date(row.createdAt.getTime() + 2000) })
    const decided = await decideProposal(caseRow.id, row.id, { decision: "approve", decided_by: "ops-shift" })
    assert.equal(decided.status, "OUTDATED")
    assert.equal((await listEffects({ caseId: caseRow.id })).length, 0)
  })

  test("a message the agent had already read is not new, even at minute precision", async () => {
    const caseRow = await newCase()
    const read = await appendEvent({ caseId: caseRow.id, orderId: facts.id, actorType: "driver", actorId: "drv-042", kind: "message", channel: "driver_chat", body: "I'm safe, engine off.", at: new Date(simNow().getTime() - 1000) })
    // The agent saw "09:02 UTC" in its notes and wrote the minute, which is earlier than the message itself.
    const minute = new Date(Math.floor(read.at.getTime() / 60000) * 60000 - 60000).toISOString()
    const { proposal: row } = await submitProposal({ audience: "operator", caseRow, facts, turnStartedAt: simNow() }, proposal("CONTACT_CUSTOMER", {
      draft_message: { ...customerDraft!, channel: "phone_call" },
      assumptions: [{ kind: "no_new_message", from: "driver", after: minute, label: "No new driver message after the one I read" }],
    }))
    const stored = row.assumptions[0] as { after: string }
    assert.equal(stored.after, read.at.toISOString(), "the cut-off moved up to the message the agent read")
    const decided = await decideProposal(caseRow.id, row.id, { decision: "handle", decided_by: "ops-shift" })
    assert.equal(decided.status, "APPROVED", "I'll handle it is not blocked by a message the agent had already read")
  })

  test("the redraft becomes the next revision of the card", async () => {
    const caseRow = await newCase()
    const { proposal: first } = await submitProposal({ audience: "operator", caseRow, facts }, await travelProposal(caseRow, {
      assumptions: [{ kind: "car_codes", codes: ["P0420"], label: "Car reports P0420" }],
    }))
    // The dongle now reports no codes, so the card's assumption no longer holds (no dongle at all is not checkable).
    const sampleId = `gate-test-obd-${caseRow.id}`
    await crDb().insert(crTelemetry).values({ id: sampleId, orderId: facts.id, at: simNow(), source: "OBD", data: { dtcs: [] } })
    try { await decideProposal(caseRow.id, first.id, { decision: "approve", decided_by: "ops-shift" }) }
    finally { await crDb().delete(crTelemetry).where(eq(crTelemetry.id, sampleId)) }
    const { proposal: second } = await submitProposal({ audience: "operator", caseRow, facts }, await travelProposal(caseRow))
    assert.equal(second.revision, 2)
    assert.equal(second.revisesProposalId, first.id)
  })
})

describe("M1: a double approval executes once", () => {
  test("a second click returns the first result and records nothing new", async () => {
    const caseRow = await newCase()
    const { proposal: row } = await submitProposal({ audience: "operator", caseRow, facts }, proposal("BOOK_RECOVERY", {
      options: [{ id: "tow", label: "Lindenau recovery (fictional)", description: "", recommended: true }],
    }))
    const clicks = await Promise.allSettled([
      decideProposal(caseRow.id, row.id, { decision: "approve", decided_by: "ops-shift" }),
      decideProposal(caseRow.id, row.id, { decision: "approve", decided_by: "ops-shift" }),
    ])
    // Whichever click wins carries it out; the other is told it was decided, or sees the card approved or executed.
    const won = clicks.filter((click) => click.status === "fulfilled" && click.value.status === "EXECUTED")
    assert.ok(won.length >= 1, "one click carried it out")
    for (const click of clicks) {
      if (click.status === "rejected") assert.ok(click.reason instanceof DecisionError && click.reason.status === 409)
      else assert.ok(["APPROVED", "EXECUTED"].includes(click.value.status))
    }
    const third = await decideProposal(caseRow.id, row.id, { decision: "approve", decided_by: "ops-shift" })
    assert.equal(third.status, "EXECUTED", "a later retry returns the first result")
    assert.equal((await listEffects({ caseId: caseRow.id, kinds: ["BOOKING"] })).length, 1, "one booking, not two")
    const again = await executeProposal(row.id, { by: "ops-shift" })
    assert.equal(again.status, "EXECUTED")
    assert.equal((await listEffects({ caseId: caseRow.id, kinds: ["BOOKING"] })).length, 1)
    assert.equal((await getProposal(row.id))!.executionKey, `${row.id}:1`)
  })
})

describe("unknown outcomes are reconciled, never retried blindly", () => {
  test("a write failure after claiming a booking stays uncertain and is never sent twice", async () => {
    const caseRow = await newCase("MISSED_CONNECTION")
    const input = await travelProposal(caseRow)
    const row = (await submitProposal({ audience: "operator", caseRow, facts }, input)).proposal
    const db = crDb()
    const insert = db.insert.bind(db)
    let failOnce = true
    const spy = mock.method(db, "insert", ((table: Parameters<typeof db.insert>[0]) => {
      if (table === crEffects && failOnce) { failOnce = false; throw new Error("Injected booking effect write failure") }
      return insert(table)
    }) as typeof db.insert)
    try {
      const result = await decideProposal(caseRow.id, row.id, { decision: "approve", decided_by: "ops-travel" })
      assert.equal(result.status, "UNKNOWN_OUTCOME")
      assert.equal((await getCase(caseRow.id))?.status, "NEEDS_DECISION")
      assert.equal((await getProposal(row.id))?.executionKey, `${row.id}:${row.revision}`)
      const [attempt] = await listEffects({ caseId: caseRow.id, kinds: ["BOOKING"] })
      assert.equal(attempt.state, "UNCONFIRMED")
      assert.equal(attempt.value.reference, null, "no provider reference is invented after a failed write")
      assert.deepEqual(attempt.value.booking_selection, input.booking_selection)
      await executeProposal(row.id, { by: "ops-travel" })
      assert.equal((await listEffects({ caseId: caseRow.id, kinds: ["BOOKING"] })).length, 1)
      await logOutcome(caseRow.id, { proposal_id: row.id, text: "Provider confirms the selected service exists; reference not yet supplied", logged_by: "ops-travel", confirmed: true })
      const confirmed = (await listEffects({ caseId: caseRow.id, kinds: ["BOOKING"] })).find((effect) => effect.state === "RECORDED")
      assert.ok(confirmed)
      assert.equal(confirmed.value.reference, null)
      assert.deepEqual(confirmed.value.booking_selection, input.booking_selection)
    } finally { spy.mock.restore() }
  })

  test("a missing booking record cannot become executed through a free-text confirmation", async () => {
    const caseRow = await newCase("MISSED_CONNECTION")
    const row = await createProposal({ caseId: caseRow.id, orderId: facts.id, actionType: "BOOK_RECOVERY", title: "Unrecorded recovery attempt", rationale: "Execution failed before the booking record was saved", nextStepIfApproved: "Reconcile", nextStepIfRejected: "Wait", createdBy: AGENT_ID, status: "UNKNOWN_OUTCOME", executionKey: "already-claimed" })
    await assert.rejects(logOutcome(caseRow.id, { proposal_id: row.id, text: "It exists", logged_by: "ops-travel", confirmed: true }), /No booking record/)
    assert.equal((await getProposal(row.id))?.status, "UNKNOWN_OUTCOME")
    assert.equal((await listEffects({ caseId: caseRow.id, kinds: ["BOOKING"] })).length, 0)
    await logOutcome(caseRow.id, { proposal_id: row.id, text: "Provider checked and confirms nothing exists", logged_by: "ops-travel", confirmed: false })
    assert.equal((await getProposal(row.id))?.status, "FAILED")
  })

  test("a non-booking execution failure is handed over without claiming success or releasing its key", async () => {
    const caseRow = await newCase()
    const row = (await submitProposal({ audience: "operator", caseRow, facts }, proposal("CONTACT_CUSTOMER", { draft_message: customerDraft }))).proposal
    const db = crDb()
    const insert = db.insert.bind(db)
    let failOnce = true
    const spy = mock.method(db, "insert", ((table: Parameters<typeof db.insert>[0]) => {
      if (table === crEffects && failOnce) { failOnce = false; throw new Error("Injected message effect write failure") }
      return insert(table)
    }) as typeof db.insert)
    try {
      const result = await decideProposal(caseRow.id, row.id, { decision: "approve", decided_by: "ops-shift" })
      assert.equal(result.status, "FAILED")
      assert.match(result.next_step, /Check the timeline/)
      assert.equal(result.followUp, null)
      assert.equal((await getCase(caseRow.id))?.status, "NEEDS_DECISION")
      assert.equal((await getProposal(row.id))?.executionKey, `${row.id}:${row.revision}`)
    } finally { spy.mock.restore() }
  })

  test("a booking that timed out waits for a person to check it", async () => {
    const order = await resolveOrder("CD-420299")
    const other = (await loadOrderFacts(order!.id))!
    const caseRow = await newCase("MISSED_CONNECTION", other)
    const { proposal: row } = await submitProposal({ audience: "operator", caseRow, facts: other }, await travelProposal(caseRow))
    const decided = await decideProposal(caseRow.id, row.id, { decision: "approve", decided_by: "ops-travel" })
    assert.equal(decided.status, "UNKNOWN_OUTCOME")
    const [booking] = await listEffects({ caseId: caseRow.id, kinds: ["BOOKING"] })
    assert.equal(booking.state, "UNCONFIRMED")
    assert.equal((await getCase(caseRow.id))?.status, "NEEDS_DECISION")
    await assert.rejects(logOutcome(caseRow.id, { text: "Checked", logged_by: "ops-travel" }), DecisionError)
    const reconciled = await logOutcome(caseRow.id, { text: "Ferry line has no such booking.", logged_by: "ops-travel", confirmed: false })
    assert.equal(reconciled.status, "FAILED")
  })

  test("an unresolved booking blocks new cards and old approvals across cases on the same order", async () => {
    const firstCase = await newCase("MISSED_CONNECTION")
    const otherCase = await newCase("MISSED_CONNECTION")
    const travelInput = await travelProposal(otherCase)
    const travel = (await submitProposal({ audience: "operator", caseRow: otherCase, facts }, travelInput)).proposal
    const recovery = (await submitProposal({ audience: "operator", caseRow: otherCase, facts }, proposal("BOOK_RECOVERY"))).proposal
    const first = (await submitProposal({ audience: "operator", caseRow: firstCase, facts }, proposal("BOOK_RECOVERY"))).proposal
    const previousTimeout = process.env.MOCK_PROVIDER_TIMEOUT
    process.env.MOCK_PROVIDER_TIMEOUT = "1"
    try {
      const attempted = await decideProposal(firstCase.id, first.id, { decision: "approve", decided_by: "ops-travel" })
      assert.equal(attempted.status, "UNKNOWN_OUTCOME")
      for (const input of [travelInput, proposal("BOOK_RECOVERY")]) {
        await assert.rejects(submitProposal({ audience: "operator", caseRow: otherCase, facts }, input), /unknown outcome/)
      }
      for (const row of [travel, recovery]) {
        await assert.rejects(decideProposal(otherCase.id, row.id, { decision: "approve", decided_by: "ops-travel" }), /unknown outcome/)
        assert.equal((await getProposal(row.id))?.status, "PENDING")
        assert.equal((await getProposal(row.id))?.executionKey, null)
      }
      // Execution itself repeats the order-level check, including a card
      // approved before the uncertain result was recorded on another case.
      await crDb().update(crProposals).set({ status: "APPROVED", decidedBy: "ops-travel", decidedRevision: recovery.revision }).where(eq(crProposals.id, recovery.id))
      await assert.rejects(executeProposal(recovery.id, { by: "ops-travel" }), /unknown outcome/)
      assert.equal((await getProposal(recovery.id))?.executionKey, null)
      assert.equal((await listEffects({ caseId: otherCase.id, kinds: ["BOOKING"] })).length, 0)

      const customer = await submitProposal({ audience: "operator", caseRow: otherCase, facts }, proposal("CONTACT_CUSTOMER", { draft_message: customerDraft }))
      assert.equal(customer.proposal.status, "PENDING", "unrelated customer drafts remain available")
      await logOutcome(firstCase.id, { proposal_id: first.id, text: "Provider confirms no booking was created", logged_by: "ops-travel", confirmed: false })
      const next = await submitProposal({ audience: "operator", caseRow: otherCase, facts }, proposal("BOOK_RECOVERY"))
      assert.equal(next.proposal.status, "PENDING", "reconciliation permits a fresh booking proposal")
    } finally {
      if (previousTimeout === undefined) delete process.env.MOCK_PROVIDER_TIMEOUT
      else process.env.MOCK_PROVIDER_TIMEOUT = previousTimeout
    }
  })

  test("concurrent approvals on different cases make only one uncertain booking request", async () => {
    const firstCase = await newCase("MISSED_CONNECTION")
    const secondCase = await newCase("MISSED_CONNECTION")
    const first = (await submitProposal({ audience: "operator", caseRow: firstCase, facts }, proposal("BOOK_RECOVERY"))).proposal
    const second = (await submitProposal({ audience: "operator", caseRow: secondCase, facts }, await travelProposal(secondCase))).proposal
    const previousTimeout = process.env.MOCK_PROVIDER_TIMEOUT
    process.env.MOCK_PROVIDER_TIMEOUT = "1"
    try {
      const results = await Promise.allSettled([
        decideProposal(firstCase.id, first.id, { decision: "approve", decided_by: "ops-travel" }),
        decideProposal(secondCase.id, second.id, { decision: "approve", decided_by: "ops-travel" }),
      ])
      const completed = results.filter((result) => result.status === "fulfilled")
      const refused = results.filter((result) => result.status === "rejected")
      assert.equal(completed.length, 1)
      assert.equal(refused.length, 1)
      assert.equal(completed[0].value.status, "UNKNOWN_OUTCOME")
      assert.match(String(refused[0].reason), /unknown outcome/)
      const rows = await Promise.all([getProposal(first.id), getProposal(second.id)])
      const pending = rows.find((row) => row?.status === "PENDING")
      assert.ok(pending, "the refused approval stays pending")
      assert.equal(pending.executionKey, null, "the refused approval never claimed execution")
      const effects = [...await listEffects({ caseId: firstCase.id, kinds: ["BOOKING"] }), ...await listEffects({ caseId: secondCase.id, kinds: ["BOOKING"] })]
      assert.equal(effects.length, 1, "only one provider request was made")
    } finally {
      if (previousTimeout === undefined) delete process.env.MOCK_PROVIDER_TIMEOUT
      else process.env.MOCK_PROVIDER_TIMEOUT = previousTimeout
      for (const kase of [firstCase, secondCase]) {
        const unknown = (await listProposals({ caseId: kase.id, statuses: ["UNKNOWN_OUTCOME"] }))[0]
        if (unknown) await logOutcome(kase.id, { proposal_id: unknown.id, text: "Provider confirms no booking exists", logged_by: "ops-travel", confirmed: false })
      }
    }
  })
})

describe("structured travel booking selection", () => {
  test("approval preserves the exact quote and replaces the original only after confirmation", async () => {
    const caseRow = await newCase("MISSED_CONNECTION")
    const input = await travelProposal(caseRow)
    const original = facts.reservations[0]
    assert.ok(original)
    input.booking_selection!.replaces_reservation_id = String(original.id)
    const { proposal: row } = await submitProposal({ audience: "operator", caseRow, facts }, input)
    assert.deepEqual(row.bookingSelection, input.booking_selection)
    assert.ok((await effectiveOrder(facts.id)).bookings.some((booking) => booking.source.id === original.id), "a proposal does not replace a reservation")
    await decideProposal(caseRow.id, row.id, { decision: "approve", decided_by: "ops-travel" })
    const [effect] = await listEffects({ caseId: caseRow.id, kinds: ["BOOKING"] })
    assert.equal(effect.state, "RECORDED")
    assert.equal(effect.value.kind, "ferry")
    assert.deepEqual(effect.value.booking_selection, input.booking_selection)
    assert.equal(effect.value.departure_at, input.booking_selection!.departure_at)
    assert.equal(effect.value.price_amount, input.booking_selection!.price_amount)
    const current = await effectiveOrder(facts.id)
    assert.ok(!current.bookings.some((booking) => booking.source.id === original.id))
    assert.equal(current.bookings.find((booking) => booking.source.id === effect.id)?.selection?.quote_id, input.booking_selection!.quote_id)
    await crDb().delete(crEffects).where(eq(crEffects.caseId, caseRow.id))
  })

  test("missing, invented, tampered and another case's quotes cannot be proposed", async () => {
    const caseRow = await newCase("MISSED_CONNECTION")
    await assert.rejects(submitProposal({ audience: "operator", caseRow, facts }, proposal("BOOK_TRAVEL")), /selected structured quote/)
    const input = await travelProposal(caseRow)
    const selection = input.booking_selection!
    await assert.rejects(submitProposal({ audience: "operator", caseRow, facts }, { ...input, booking_selection: { ...selection, quote_id: "made-up" } }), /not recorded/)
    await assert.rejects(submitProposal({ audience: "operator", caseRow, facts }, { ...input, booking_selection: { ...selection, price_amount: selection.price_amount + 1 } }), /differs from the recorded quote/)
    await assert.rejects(submitProposal({ audience: "operator", caseRow, facts }, { ...input, booking_selection: { ...selection, arrival_at: selection.departure_at } }), /ordered departure and arrival/)
    const other = await newCase("MISSED_CONNECTION")
    await assert.rejects(submitProposal({ audience: "operator", caseRow: other, facts }, input), /not recorded/)
    assert.equal((await listEffects({ caseId: caseRow.id, kinds: ["BOOKING"] })).length, 0)
  })

  test("a legacy travel card without a selected quote fails clearly instead of inventing dates", async () => {
    const caseRow = await newCase("MISSED_CONNECTION")
    const row = await createProposal({ caseId: caseRow.id, orderId: facts.id, actionType: "BOOK_TRAVEL", title: "Old ferry card", rationale: "Legacy proposal", nextStepIfApproved: "Book it", nextStepIfRejected: "Wait", createdBy: AGENT_ID, status: "APPROVED", decidedBy: "ops-travel", decidedRevision: 1 })
    await assert.rejects(executeProposal(row.id, { by: "ops-travel" }), /selected structured quote/)
    assert.equal((await listEffects({ caseId: caseRow.id })).length, 0)
    assert.equal((await getProposal(row.id))?.executionKey, null)
  })

  test("a second pending card cannot replace an original that was already replaced", async () => {
    const caseRow = await newCase("MISSED_CONNECTION")
    const input = await travelProposal(caseRow)
    input.booking_selection!.replaces_reservation_id = String(facts.reservations[0].id)
    const first = (await submitProposal({ audience: "operator", caseRow, facts }, input)).proposal
    // A differently worded card: the same card twice is reused, not stored again.
    const second = (await submitProposal({ audience: "operator", caseRow, facts }, { ...input, title: "Test BOOK_TRAVEL, another sailing" })).proposal
    assert.notEqual(second.id, first.id)
    await decideProposal(caseRow.id, first.id, { decision: "approve", decided_by: "ops-travel" })
    await assert.rejects(decideProposal(caseRow.id, second.id, { decision: "approve", decided_by: "ops-travel" }), /not a current confirmed booking/)
    const unchanged = await getProposal(second.id)
    assert.equal(unchanged?.status, "PENDING", "the operator can reject or redraft this card")
    assert.equal(unchanged?.executionKey, null, "validation does not consume the execution claim")
    assert.equal((await listEffects({ caseId: caseRow.id, kinds: ["BOOKING"] })).length, 1)
    await crDb().delete(crEffects).where(eq(crEffects.caseId, caseRow.id))
  })

  test("a cancelled reservation cannot be selected for replacement, and travel cannot be handled through prose", async () => {
    const caseRow = await newCase("MISSED_CONNECTION")
    const input = await travelProposal(caseRow)
    const cancelledId = `cancelled-${caseRow.id}`
    await crDb().insert(relatedRecords).values({ id: cancelledId, collection: "travel_reservations", orderId: facts.id, details: { id: cancelledId, order_id: facts.id, kind: "FERRY", status: "CANCELLED", booking_reference: "CANCELLED-TEST" } })
    try {
      input.booking_selection!.replaces_reservation_id = cancelledId
      await assert.rejects(submitProposal({ audience: "operator", caseRow, facts }, input), /not a current confirmed booking/)
      input.booking_selection!.replaces_reservation_id = null
      const row = (await submitProposal({ audience: "operator", caseRow, facts }, input)).proposal
      await assert.rejects(decideProposal(caseRow.id, row.id, { decision: "handle", decided_by: "ops-travel" }), /Approve the selected quote/)
      assert.equal((await getProposal(row.id))?.status, "PENDING")
      assert.equal((await listEffects({ caseId: caseRow.id, kinds: ["BOOKING"] })).length, 0)
    } finally {
      await crDb().delete(relatedRecords).where(eq(relatedRecords.id, cancelledId))
    }
  })

  for (const confirmed of [true, false]) test(`an unknown replacement preserves the original until reconciliation (${confirmed})`, async () => {
    const other = facts
    const caseRow = await newCase("MISSED_CONNECTION", other)
    const previousTimeout = process.env.MOCK_PROVIDER_TIMEOUT
    process.env.MOCK_PROVIDER_TIMEOUT = "1"
    try {
    const input = await travelProposal(caseRow)
    const original = other.reservations.find((row) => String(row.kind).toLowerCase() === "ferry")!
    input.booking_selection!.replaces_reservation_id = String(original.id)
    const { proposal: row } = await submitProposal({ audience: "operator", caseRow, facts: other }, input)
    await decideProposal(caseRow.id, row.id, { decision: "approve", decided_by: "ops-travel" })
    const unknown = await effectiveOrder(other.id)
    assert.ok(unknown.bookings.some((booking) => booking.source.id === original.id))
    assert.equal(unknown.bookings.filter((booking) => booking.selection?.quote_id === input.booking_selection!.quote_id).length, 1)
    await logOutcome(caseRow.id, { proposal_id: row.id, text: confirmed ? "Carrier confirms this sailing and price" : "Carrier confirms no booking exists", logged_by: "ops-travel", confirmed })
    const current = await effectiveOrder(other.id)
    assert.equal(current.bookings.some((booking) => booking.source.id === original.id), !confirmed)
    const selected = current.bookings.filter((booking) => booking.selection?.quote_id === input.booking_selection!.quote_id)
    assert.equal(selected.length, confirmed ? 1 : 0)
    if (confirmed) assert.deepEqual(selected[0].selection, input.booking_selection)
    assert.equal((await listEffects({ caseId: caseRow.id, kinds: ["BOOKING"] })).length, confirmed ? 2 : 1, "all attempted and reconciled evidence remains")
    } finally {
      if (previousTimeout === undefined) delete process.env.MOCK_PROVIDER_TIMEOUT
      else process.env.MOCK_PROVIDER_TIMEOUT = previousTimeout
      await crDb().delete(crEffects).where(eq(crEffects.caseId, caseRow.id))
    }
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
    assert.equal((await listEffects({ caseId: caseRow.id })).length, 0)
  })

  test("a phone call is handled by a person: it waits for the logged outcome", async () => {
    const caseRow = await newCase()
    const { proposal: row } = await submitProposal({ audience: "operator", caseRow, facts }, proposal("CONTACT_CUSTOMER", { draft_message: { ...customerDraft!, channel: "phone_call" } }))
    const handled = await decideProposal(caseRow.id, row.id, { decision: "approve", decided_by: "ops-shift" })
    assert.equal(handled.case_status, "WAITING_EXTERNAL")
    assert.equal((await getCase(caseRow.id))?.waitingOn, "the shift lead to log what happened")
    assert.equal((await listEffects({ caseId: caseRow.id })).length, 0, "nothing happens until the outcome is logged")
    const logged = await logOutcome(caseRow.id, { text: "Dealer sends their own roadside help, ETA 11:00", logged_by: "ops-shift" })
    assert.equal(logged.status, "EXECUTED")
    const [outcome] = await listEffects({ caseId: caseRow.id, kinds: ["OUTCOME_LOGGED"] })
    assert.match(String(outcome.value.text), /roadside help/)
    assert.match(outcome.authority.basis, /outside the system/)
  })

  test("I'll handle it records no option unless the operator picked one; approving goes with the recommendation", async () => {
    const options = [
      { id: "tow", label: "We book the tow", description: "", recommended: true },
      { id: "own", label: "Owner's roadside assistance", description: "", recommended: false },
    ]
    const call = proposal("CONTACT_CUSTOMER", { draft_message: { ...customerDraft!, channel: "phone_call" }, options })
    const untouched = await newCase()
    const { proposal: first } = await submitProposal({ audience: "operator", caseRow: untouched, facts }, call)
    await decideProposal(untouched.id, first.id, { decision: "handle", decided_by: "ops-shift" })
    assert.equal((await getProposal(first.id))!.chosenOptionId, null, "phoning the owner is not choosing to book the recommended tow")
    const events = await listEvents({ caseId: untouched.id })
    const decision = events.find((event) => event.kind === "decision")!
    assert.doesNotMatch(decision.body, /We book the tow/, "the record does not claim a choice nobody made")

    const picked = await newCase()
    const { proposal: second } = await submitProposal({ audience: "operator", caseRow: picked, facts }, call)
    await decideProposal(picked.id, second.id, { decision: "handle", decided_by: "ops-shift", option_id: "own" })
    assert.equal((await getProposal(second.id))!.chosenOptionId, "own", "an explicit pick is kept")

    const approved = await newCase()
    const { proposal: third } = await submitProposal({ audience: "operator", caseRow: approved, facts }, proposal("BOOK_RECOVERY", { options }))
    await decideProposal(approved.id, third.id, { decision: "approve", decided_by: "ops-shift" })
    assert.equal((await getProposal(third.id))!.chosenOptionId, "tow", "approving without picking goes with the recommendation")
  })

  test("an edit may change the message, not who it goes to", async () => {
    const caseRow = await newCase()
    const { proposal: row } = await submitProposal({ audience: "operator", caseRow, facts }, proposal("CONTACT_CUSTOMER", { draft_message: customerDraft }))
    const draft = row.draftMessage!
    await assert.rejects(decideProposal(caseRow.id, row.id, { decision: "approve", decided_by: "ops-shift", edited_draft_message: { ...draft, to_id: "cus-999" } }), DecisionError)
    const ok = await decideProposal(caseRow.id, row.id, { decision: "approve", decided_by: "ops-shift", edited_draft_message: { ...draft, body: "Edited text." } })
    assert.equal(ok.status, "EXECUTED")
    assert.equal((await listEffects({ caseId: caseRow.id, kinds: ["MESSAGE_SENT"] }))[0].value.body, "Edited text.")
  })

  test("a card can be refreshed only when new facts arrived after it", async () => {
    const caseRow = await newCase()
    const { proposal: row } = await submitProposal({ audience: "operator", caseRow, facts }, proposal("BOOK_RECOVERY"))
    await appendEvent({ caseId: caseRow.id, orderId: facts.id, actorType: "agent", actorId: AGENT_ID, kind: "note", channel: "internal", body: "Note.", at: new Date(row.createdAt.getTime() + 1000) })
    await assert.rejects(refreshProposal(caseRow.id, row.id, "ops-shift"), (error: unknown) => error instanceof DecisionError && error.status === 409)
    await appendEvent({ caseId: caseRow.id, orderId: facts.id, actorType: "driver", actorId: "drv-042", kind: "message", channel: "driver_chat", body: "It started again.", at: new Date(row.createdAt.getTime() + 2000) })
    assert.deepEqual((await proposalsWithChangedFacts(caseRow.id)).map((entry) => entry.proposalId), [row.id])
    assert.equal((await refreshProposal(caseRow.id, row.id, "ops-shift")).status, "OUTDATED")
  })
})

describe("M1: a site context contains no customer details; channels are scoped", () => {
  test("a site sees its own end only: no customer, no prices, no conversations", async () => {
    for (const end of ["pickup", "delivery"] as const) {
      const view = JSON.stringify(await getSiteContext(facts, end))
      assert.ok(!view.includes(facts.customer.name), "no customer name")
      assert.ok(!view.includes(facts.customer.id), "no customer id")
      assert.ok(!/€|\bEUR\b|\bfee\b|\bprice|\bcost/i.test(view.replace(/may_not_share[^}]*/, "")), "no prices")
      assert.ok(!/conversation|open_records|expense|alert/i.test(view.replace(/may_not_share[^}]*/, "")), "no internal records")
      assert.ok(view.includes(facts.reference))
    }
  })

  test("ask_site is refused for a site the customer owns", async () => {
    const caseRow = await newCase()
    assert.equal(checkTool({ audience: "operator", caseRow, facts }, "ask_site", { end: "delivery", text: "Hi" }).ok, false)
    assert.equal(checkTool({ audience: "operator", caseRow, facts }, "ask_site", { end: "pickup", text: "Hi" }).ok, true)
  })

  test("tools are limited per audience; the Ask box only reads", async () => {
    const caseRow = await newCase()
    assert.equal(checkTool({ audience: "site", caseRow, facts }, "propose_action", {}).ok, false)
    assert.equal(checkTool({ audience: "driver", caseRow, facts }, "get_order_context", { order_ref: "CD-420299" }).ok, false)
    assert.equal(checkTool({ audience: "operator", caseRow, facts }, "get_order_context", { order_ref: "CD-420299" }).ok, true)
    const ask = { audience: "operator" as const, caseRow, facts, readOnly: true }
    for (const tool of ["message_driver", "propose_action", "safety_instruction", "update_case", "close_case", "wait_for"]) assert.equal(checkTool(ask, tool, {}).ok, false, tool)
  })

  test("a driver must be on an active assignment for the order (rule 8)", async () => {
    await assert.rejects(prepareDriverMessage({ orderRef: "CD-420584", driverId: "drv-130", text: "hi", mode: "chat" }), (error: unknown) => error instanceof ChannelError && error.status === 403)
    const [done] = (await crDb().execute(sql`SELECT order_id, details->>'driver_id' AS driver_id FROM related_records WHERE collection = 'work_assignments' AND details->>'status' = 'COMPLETED' LIMIT 1`)) as unknown as { order_id: string; driver_id: string }[]
    await assert.rejects(prepareDriverMessage({ orderRef: done.order_id, driverId: done.driver_id, text: "hi", mode: "chat" }), (error: unknown) => error instanceof ChannelError && error.status === 403)
    assert.ok(await prepareDriverMessage({ orderRef: "CD-420584", driverId: "drv-042", text: "hi", mode: "chat" }))
  })

  test("serious cases cannot be closed by the agent", async () => {
    assert.equal(checkTool({ audience: "driver", caseRow: await newCase("VEHICLE_WARNING"), facts }, "close_case", { summary: "x" }).ok, false)
    assert.equal(checkTool({ audience: "driver", caseRow: await newCase("DRIVER_QUESTION"), facts }, "close_case", { summary: "x" }).ok, true)
  })
})

describe("M1: the drivability screen blocks \"you can keep driving\"", () => {
  const clears = [
    "You can keep driving.",
    "You can keep driving to the next exit.",
    "It's safe to continue now.",
    "You're fine to drive on.",
    "Feel free to carry on towards Hamburg.",
    "The light is amber, so you may continue.",
    "It's usually not critical and the car can keep going, but fuel use may rise.",
    "Your car is still drivable.",
  ]
  const safe = [
    "Please stop at the next safe place and switch the engine off.",
    "It is not safe to drive the car any further.",
    "Do not drive on until an operator confirms you can continue.",
    "An operator will decide whether you can drive on.",
    "Nobody has cleared onward driving yet.",
    "An operator confirms whether the car can continue.",
    "The car cannot keep going with this light.",
    "It is not safe to drive.",
  ]
  for (const text of clears) test(`blocks: ${text}`, async () => assert.equal((await screenDriverMessage(text)).allowed, false))
  for (const text of safe) test(`allows: ${text}`, () => assert.equal(findClearance(text), null))

  test("if the classifier fails, a message about driving is held (fail closed)", async () => {
    useTestLlm({ messages: { create: async () => { throw new Error("classifier down") } } })
    try {
      const held = await screenDriverMessage("Head to the ferry when you're ready.")
      assert.equal(held.allowed, false)
      assert.equal(held.layer, "fail_closed")
      const fine = await screenDriverMessage("Please send a photo of the dashboard.")
      assert.equal(fine.allowed, true, "a message that does not mention driving still goes out")
    } finally {
      useTestLlm(null)
    }
  })

  test("the classifier catches what the patterns miss", async () => {
    useTestLlm({ messages: { create: async () => ({ content: [{ type: "text", text: "BLOCK" }], usage: { cost: 0.00001 } }) } })
    try {
      const screen = await screenDriverMessage("The amber light is nothing to worry about, head to the ferry.")
      assert.equal(screen.allowed, false)
      assert.equal(screen.layer, "classifier")
    } finally {
      useTestLlm(null)
    }
  })

  test("safety instructions come only from the templates", async () => {
    const caseRow = await newCase()
    assert.equal(checkTool({ audience: "driver", caseRow, facts }, "safety_instruction", { template_id: "stop_when_safe" }).ok, true)
    assert.equal(checkTool({ audience: "driver", caseRow, facts }, "safety_instruction", { template_id: "you_may_continue" }).ok, false)
    assert.equal(checkTool({ audience: "driver", caseRow, facts }, "safety_instruction", { text: "You can drive on." }).ok, false)
  })
})

describe("follow-ups and the watchdog (tick)", () => {
  test("a silent driver gets one reminder, then the case goes to a person with a card", async () => {
    const caseRow = await newCase()
    const since = new Date(simNow().getTime() - 20 * 60000)
    await updateCase(caseRow.id, { status: "WAITING_EXTERNAL", waitingFor: "driver", waitingOn: "the driver's reply", waitingSince: since, nextCheckAt: new Date(simNow().getTime() - 60000) })
    const first = await tick()
    assert.ok(first.followed_up.includes(caseRow.id))
    await withCaseLock(caseRow.id, async () => undefined)
    const reminded = await getCase(caseRow.id)
    assert.equal(reminded?.followUps, 1)
    assert.ok((await listEvents({ caseId: caseRow.id })).some((event) => event.recipientType === "driver" && event.data.reminder === true))

    await updateCase(caseRow.id, { nextCheckAt: new Date(simNow().getTime() - 60000) })
    const second = await tick()
    assert.ok(second.escalated.includes(caseRow.id))
    await withCaseLock(caseRow.id, async () => undefined)
    const escalated = await getCase(caseRow.id)
    assert.equal(escalated?.status, "NEEDS_DECISION")
    const [card] = await listProposals({ caseId: caseRow.id, statuses: ["PENDING"] })
    assert.match(card.title, /not answering/)
    assert.ok(card.handover?.unknowns.some((text) => /safe/.test(text)))
  })

  test("a case stuck in AGENT_WORKING goes to a person", async () => {
    const caseRow = await newCase()
    await crDb().update(crCases).set({ updatedAt: new Date(simNow().getTime() - 5 * 60000) }).where(eq(crCases.id, caseRow.id))
    const result = await tick()
    assert.ok(result.escalated.includes(caseRow.id))
    const row = await getCase(caseRow.id)
    assert.equal(row?.status, "NEEDS_DECISION")
    assert.ok(row?.nextAction && row.waitingOn && row.nextCheckAt, "an open case always has next action, waiting on and next check")
    const [card] = await listProposals({ caseId: caseRow.id, statuses: ["PENDING"] })
    assert.match(card.title, /couldn't finish/)
  })
})
