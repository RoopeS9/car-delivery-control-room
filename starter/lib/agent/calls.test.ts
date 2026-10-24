import "dotenv/config"
delete process.env.OPENROUTER_API_KEY
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { after, before, test } from "node:test"
import { eq, inArray } from "drizzle-orm"
import { simNow } from "@/lib/cr/clock"
import { closeCrDb, crDb } from "@/lib/cr/db"
import { createProposal, getCase, getEvent, getProposal, listEvents, listProposals } from "@/lib/cr/queries"
import { crAgentRuns, crCases, crEffects, crEvents, crProposals } from "@/lib/cr/schema"
import { crCalls, crCallTurns } from "@/lib/voice/schema"
import type { CallState } from "@/lib/voice/types"
import { acceptCallTrigger, analyseCallTrigger, callAnalysisInput } from "./calls"
import { ChannelError, decide } from "./triggers"
import { withCaseLock } from "./loop"
import { DecisionError } from "./gate"
import { useTestLlm } from "./client"

const callId = `call-bridge-test-${randomUUID()}`
const orderId = "ord-00917", orderRef = "CD-420917", driverId = "drv-030"
const cases = new Set<string>()
const state: CallState = {
  orderRef, driverName: "Test driver", phase: "checklist", questions: 1, readbacks: 0, readbackTurnId: null,
  urgencyQuote: "Stopped safely, engine light flashing.", urgencyAt: simNow().toISOString(),
  context: [], telemetryHint: null, silences: 0, triggers: [], spend: { llm: 0, stt: 0, tts: 0 }, liveStt: "browser",
}
before(async () => {
  await crDb().insert(crCalls).values({ id: callId, orderId, driverId, direction: "DRIVER_INITIATED", startedAt: simNow(), urgency: "URGENT", situation: "WARNING_LIGHT", state })
  await crDb().insert(crCallTurns).values([
    { id: `${callId}-1`, callId, seq: 1, speaker: "agent", startedAt: simNow(), textLive: "Are you safe?", textFinal: "Are you safe?" },
    { id: `${callId}-2`, callId, seq: 2, speaker: "driver", startedAt: simNow(), textLive: "At north service area.", textFinal: null },
  ])
})
after(async () => {
  await crDb().delete(crCallTurns).where(eq(crCallTurns.callId, callId))
  await crDb().delete(crCalls).where(eq(crCalls.id, callId))
  if (cases.size) {
    const ids = [...cases]
    await crDb().delete(crProposals).where(inArray(crProposals.caseId, ids))
    await crDb().delete(crEffects).where(inArray(crEffects.caseId, ids))
    await crDb().delete(crEvents).where(inArray(crEvents.caseId, ids))
    await crDb().delete(crAgentRuns).where(inArray(crAgentRuns.caseId, ids))
    await crDb().delete(crCases).where(inArray(crCases.id, ids))
  }
  await closeCrDb()
})
test("reject another order and malformed triggers", async () => {
  await assert.rejects(acceptCallTrigger({ trigger: "call_urgent", callId, orderRef: "CD-420584" }), (e: unknown) => e instanceof ChannelError && e.status === 403)
  await assert.rejects(acceptCallTrigger({ trigger: "invalid", callId, orderRef } as never), (e: unknown) => e instanceof ChannelError && e.status === 400)
})
test("reject a canonical caller without an active assignment", async () => {
  await crDb().update(crCalls).set({ driverId: "drv-042" }).where(eq(crCalls.id, callId))
  try { await assert.rejects(acceptCallTrigger({ trigger: "call_urgent", callId, orderRef }), (e: unknown) => e instanceof ChannelError && e.status === 403) }
  finally { await crDb().update(crCalls).set({ driverId }).where(eq(crCalls.id, callId)) }
})
test("reject completion before the call record is finished", async () => {
  await assert.rejects(acceptCallTrigger({ trigger: "call_ended", callId, orderRef }), (e: unknown) => e instanceof ChannelError && e.status === 409)
})
test("concurrent urgent deliveries create one linked case and attributed provisional turns", async () => {
  const [first, duplicate] = await Promise.all([acceptCallTrigger({ trigger: "call_urgent", callId, orderRef }), acceptCallTrigger({ trigger: "call_urgent", callId, orderRef })])
  cases.add(first.caseId)
  assert.equal(first.caseId, duplicate.caseId)
  assert.equal(first.eventId, duplicate.eventId)
  assert.deepEqual([first.duplicate, duplicate.duplicate].sort(), [false, true])
  const [call] = await crDb().select().from(crCalls).where(eq(crCalls.id, callId))
  assert.equal(call.caseId, first.caseId)
  const row = await getCase(first.caseId)
  assert.equal(row?.status, "NEEDS_DECISION")
  assert.equal(row?.urgency, "HIGH")
  const turns = (await listEvents({ caseId: first.caseId })).filter(e => e.kind === "voice_turn")
  assert.equal(turns.length, 2)
  const driver = turns.find(e => e.actorType === "driver")!
  assert.match(driver.body, /provisional live transcript/)
  assert.equal(driver.sourceRefs[0].kind, "cr_call_turns")
  assert.equal(driver.sourceRefs[0].id, `${callId}-2`)
})
test("completion reuses the case and replaces provisional text with final transcription", async () => {
  const [call] = await crDb().select().from(crCalls).where(eq(crCalls.id, callId))
  const partial = await createProposal({ caseId: call.caseId!, orderId, actionType: "OPERATOR_DECISION", title: "Partial-call recommendation", rationale: "Uses the live transcript.", evidenceRefs: [{ kind: "cr_call_turns", id: `${callId}-2`, label: "Driver's live words" }], nextStepIfApproved: "Decide.", nextStepIfRejected: "Do nothing.", createdBy: "test" })
  await crDb().update(crCallTurns).set({ textFinal: "At south service area.", sttModel: "test-transcriber" }).where(eq(crCallTurns.id, `${callId}-2`))
  await crDb().update(crCalls).set({ endedAt: simNow(), endReason: "completed", state: { ...state, phase: "ended" } }).where(eq(crCalls.id, callId))
  const ended = await acceptCallTrigger({ trigger: "call_ended", callId, orderRef })
  cases.add(ended.caseId)
  assert.equal(ended.caseId, call.caseId)
  const turns = (await listEvents({ caseId: ended.caseId })).filter(e => e.kind === "voice_turn")
  assert.equal(turns.length, 2)
  const driver = turns.find(e => e.actorType === "driver")!
  assert.equal(driver.body, "At south service area.")
  assert.equal(driver.data.text_live, "At north service area.")
  assert.equal(driver.data.text_final, "At south service area.")
  assert.equal((await getProposal(partial.id))?.status, "OUTDATED", "partial-call cards are invalidated even without a model-authored assumption")
  const [canonical] = await crDb().select().from(crCalls).where(eq(crCalls.id, callId))
  const transcript = await crDb().select().from(crCallTurns).where(eq(crCallTurns.callId, callId))
  const input = callAnalysisInput(canonical, transcript, "call_ended")
  assert.match(input, /cr_call_turns/)
  assert.match(input, /At south service area/)
  assert.match(input, /live transcription differed: At north service area/)
})
test("an unchanged duplicate ended trigger does not invalidate a fresh recommendation", async () => {
  const [call] = await crDb().select().from(crCalls).where(eq(crCalls.id, callId))
  const fresh = await createProposal({ caseId: call.caseId!, orderId, actionType: "OPERATOR_DECISION", title: "Current-transcript recommendation", rationale: "Uses the final transcript.", nextStepIfApproved: "Decide.", nextStepIfRejected: "Do nothing.", createdBy: "test" })
  await acceptCallTrigger({ trigger: "call_ended", callId, orderRef })
  assert.equal((await getProposal(fresh.id))?.status, "PENDING")
})

test("offline analysis escalates to an operator and redelivery cannot repeat effects", async () => {
  const accepted = await acceptCallTrigger({ trigger: "call_ended", callId, orderRef })
  const result = await analyseCallTrigger(accepted)
  assert.equal(result?.error, "offline")
  assert.equal((await getEvent(accepted.eventId))?.data.analysis_status, "FAILED")
  assert.equal((await getCase(accepted.caseId))?.status, "NEEDS_DECISION")
  const proposals = await listProposals({ caseId: accepted.caseId })
  assert.ok(proposals.some(p => p.actionType === "OPERATOR_DECISION"))
  assert.equal(await analyseCallTrigger(accepted), null)
  assert.equal((await listProposals({ caseId: accepted.caseId })).length, proposals.length)
})


test("a transcript correction during urgent analysis invalidates a card drafted from its older snapshot", async () => {
  await crDb().update(crCalls).set({ urgency: "EMERGENCY" }).where(eq(crCalls.id, callId))
  const accepted = await acceptCallTrigger({ trigger: "call_urgent", callId, orderRef })
  let proposalId = ""
  useTestLlm({ messages: {
    stream() {
      let emit: ((text: string) => void) | undefined
      return {
        on(_event: string, callback: (text: string) => void) { emit = callback; return this },
        async finalMessage() {
          const proposal = await createProposal({ caseId: accepted.caseId, orderId, actionType: "OPERATOR_DECISION", title: "Card based on the earlier snapshot", rationale: "Test concurrent transcript correction.", nextStepIfApproved: "Decide.", nextStepIfRejected: "Do nothing.", createdBy: "test" })
          proposalId = proposal.id
          await crDb().update(crCallTurns).set({ textFinal: "Correction: the car is on the carriageway." }).where(eq(crCallTurns.id, `${callId}-2`))
          emit?.("Please review the call.")
          return { content: [{ type: "text", text: "Please review the call." }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }
        },
      }
    },
  } })
  try {
    const result = await analyseCallTrigger(accepted)
    assert.equal(result?.error, null)
    assert.ok(proposalId)
    assert.equal((await getProposal(proposalId))?.status, "OUTDATED")
  } finally { useTestLlm(null) }
})


test("an operator decision waits until a running analyst releases the case lock", async () => {
  const [call] = await crDb().select().from(crCalls).where(eq(crCalls.id, callId))
  assert.ok(call.caseId)
  let unlock!: () => void
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const blocked = new Promise<void>(resolve => { unlock = resolve })
  const order: string[] = []
  const running = withCaseLock(call.caseId, async () => { started(); await blocked; order.push("analyst finished") })
  await ready
  let settled = false
  const decision = decide(call.caseId, "missing-proposal-for-serialization-test", { decision: "approve", decided_by: "ops-shift" })
    .catch((error: unknown) => error).finally(() => { settled = true; order.push("decision finished") })
  try {
    await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal(settled, false, "the operator must not decide while analysis still owns this case")
  } finally { unlock(); await running }
  const error = await decision
  assert.ok(error instanceof DecisionError && error.status === 404, "the queued mutation ran only after release")
  assert.deepEqual(order, ["analyst finished", "decision finished"])
})
