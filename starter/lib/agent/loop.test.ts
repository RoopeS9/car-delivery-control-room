// Loop tests with a scripted stand-in for the model: they check the wiring
// (tools run through the gate, replies reach the right person, the streamed
// reply is gated, hand-over builds a decision card, a decision continues the
// case) without spending tokens. The model's judgement is tested by real
// runs saved in traces/.

import "dotenv/config"
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"
import { inArray } from "drizzle-orm"
import { closeCrDb, crDb } from "@/lib/cr/db"
import { getCase, listEvents, listProposals, resolveOrder } from "@/lib/cr/queries"
import { crAgentRuns, crCases, crEvents, crProposals } from "@/lib/cr/schema"
import { useTestLlm } from "./client"
import { decide, handleDriverMessage, handleTelemetryFault, prepareDriverMessage, runFollowUps } from "./triggers"

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
type Step = { content: Block[]; stop_reason: "end_turn" | "tool_use" | "refusal" }

/** Plays back scripted model responses in order and records what it was sent. */
function scriptedModel(steps: Step[]) {
  const requests: Record<string, unknown>[] = []
  let index = 0
  return {
    requests,
    get remaining() { return steps.length - index },
    messages: {
      stream(params: Record<string, unknown>) {
        requests.push(structuredClone(params))
        const step = steps[index++]
        if (!step) throw new Error("The script ran out of model responses")
        const listeners: ((delta: string) => void)[] = []
        return {
          on(event: string, listener: (delta: string) => void) {
            if (event === "text") listeners.push(listener)
            return this
          },
          async finalMessage() {
            for (const block of step.content) {
              if (block.type !== "text") continue
              // Stream in small pieces, like the real API.
              for (const piece of block.text.match(/[\s\S]{1,7}/g) ?? []) listeners.forEach((listener) => listener(piece))
            }
            return {
              content: step.content, stop_reason: step.stop_reason,
              usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 0, cost: 0.001 },
            }
          },
        }
      },
    },
  }
}

const tool = (id: string, name: string, input: Record<string, unknown>): Block => ({ type: "tool_use", id, name, input })
const text = (value: string): Block => ({ type: "text", text: value })
const handover = { what_happened: "The car stopped with a flashing engine light.", facts: [{ text: "Misfire codes P0300 and P0302.", sources: [{ kind: "knowledge:dtc", id: "P0300", label: "Trouble-code guide, P0300", at: "" }] }], agent_did: ["Told the driver to stop."], unknowns: ["Cause of the misfire."], recommendation: "Call the dealer about recovery.", alternatives: ["Book our own tow."] }

// A quiet moving order that no demo scenario uses, so the test can clear it first.
const ORDER = "CD-420366"
const DRIVER = "drv-034"
const touched: string[] = []

before(async () => {
  const order = (await resolveOrder(ORDER))!
  const stale = (await crDb().select({ id: crCases.id }).from(crCases).where(inArray(crCases.orderId, [order.id]))).map((row) => row.id)
  if (stale.length) {
    await crDb().delete(crProposals).where(inArray(crProposals.caseId, stale))
    await crDb().delete(crEvents).where(inArray(crEvents.caseId, stale))
    await crDb().delete(crAgentRuns).where(inArray(crAgentRuns.caseId, stale))
    await crDb().delete(crCases).where(inArray(crCases.id, stale))
  }
})

after(async () => {
  useTestLlm(null)
  const db = crDb()
  if (touched.length) {
    await db.delete(crProposals).where(inArray(crProposals.caseId, touched))
    await db.delete(crEvents).where(inArray(crEvents.caseId, touched))
    await db.delete(crAgentRuns).where(inArray(crAgentRuns.caseId, touched))
    await db.delete(crCases).where(inArray(crCases.id, touched))
  }
  await closeCrDb()
})

describe("scenario A wiring", () => {
  let caseId = ""

  test("a fault opens a case and the agent contacts the driver first", async () => {
    const model = scriptedModel([
      { stop_reason: "tool_use", content: [
        tool("t1", "safety_instruction", { text: "Please slow down and stop at the next safe place, then switch the engine off." }),
        tool("t2", "update_case", { title: "Flashing engine light", summary: "Car reports misfire codes; driver told to stop.", kind: "VEHICLE_WARNING", urgency: "CRITICAL" }),
      ] },
      { stop_reason: "end_turn", content: [text("Hi Sofia, the car is reporting a serious engine fault. Are you safe, and where are you now?")] },
    ])
    useTestLlm(model)
    const { caseId: id, result } = await handleTelemetryFault({ orderRef: ORDER, codes: ["P0300", "P0302"], mil: "FLASHING", note: "reduced power message" })
    caseId = id
    touched.push(id)
    assert.equal(result.error, null)
    assert.equal(model.remaining, 0)

    const events = await listEvents({ caseId })
    assert.ok(events.some((event) => event.kind === "dtc" && event.actorType === "obd"))
    const safety = events.find((event) => event.channel === "safety")
    assert.ok(safety && safety.recipientId === DRIVER, "safety instruction went to the driver")
    const reply = events.find((event) => event.id === result.replyEventId)
    assert.equal(reply?.recipientType, "driver")
    assert.match(reply!.body, /Are you safe/)
    const row = await getCase(caseId)
    assert.equal(row?.kind, "VEHICLE_WARNING")
    assert.equal(row?.urgency, "CRITICAL")
    assert.equal(row?.status, "WAITING_EXTERNAL", "waits for the driver's answer")

    // The stable system prompt is cached; the case notes carry the volatile part.
    const request = model.requests[0] as { system: { cache_control?: unknown }[]; messages: { content: string }[]; tools: { name: string; strict?: boolean }[] }
    assert.ok(request.system[0].cache_control)
    assert.match(request.messages[0].content, new RegExp(ORDER))
    assert.ok(request.tools.every((entry) => entry.strict === true))
    assert.ok(!request.tools.some((entry) => entry.name === "propose_action"), "driver turns cannot propose")
  })

  test("the streamed reply never clears the driver to drive on", async () => {
    const model = scriptedModel([
      { stop_reason: "end_turn", content: [text("Thanks for stopping. The light is amber now, so you can continue driving slowly. Keep me posted.")] },
    ])
    useTestLlm(model)
    const streamed: string[] = []
    const prepared = await prepareDriverMessage({ orderRef: ORDER, driverId: DRIVER, text: "The light changed to amber. Can I go on?", mode: "chat" })
    const { result } = await handleDriverMessage(prepared, (piece) => streamed.push(piece))
    const all = streamed.join("")
    assert.ok(!/can continue/i.test(all), "the clearance never reached the driver")
    assert.match(all, /Thanks for stopping\./)
    assert.match(all, /An operator has to confirm/)
    assert.equal(result.reply, all)
    const events = await listEvents({ caseId })
    assert.ok(events.some((event) => event.actorId === "gate" && /held back a sentence/.test(event.body)))
  })

  test("hand-over builds a decision card in a separate turn", async () => {
    const model = scriptedModel([
      { stop_reason: "tool_use", content: [tool("t1", "hand_over", { reason: "Recovery is the owner's decision." })] },
      { stop_reason: "end_turn", content: [text("Thanks. Stay with the car; an operator is contacting the owner now.")] },
      // The analysis turn:
      { stop_reason: "tool_use", content: [tool("t2", "propose_action", {
        action_type: "CONTACT_CUSTOMER", title: "Call the dealer about recovery", rationale: "The car cannot be driven on; recovery is the owner's call.",
        handover, changes: [], draft_message: { to: "customer", channel: "phone_call", subject: "", body: "The Bentley has stopped with a misfire. Your own roadside help, or should we book a tow?", language: "en" },
        options: [{ id: "own", label: "Dealer's own roadside help", description: "", recommended: true }, { id: "tow", label: "We book a tow", description: "", recommended: false }],
        evidence_refs: handover.facts[0].sources, next_step_if_approved: "The operator calls the dealer.", next_step_if_rejected: "The agent asks what to do instead.",
      })] },
      { stop_reason: "end_turn", content: [text("Decision card ready: call the dealer about recovery.")] },
    ])
    useTestLlm(model)
    const prepared = await prepareDriverMessage({ orderRef: ORDER, driverId: DRIVER, text: "I'm at a service area, engine off.", mode: "voice" })
    const { result } = await handleDriverMessage(prepared)
    assert.equal(result.followUps.length, 1)
    assert.equal((await getCase(caseId))?.status, "AGENT_WORKING")
    await runFollowUps(result.followUps)
    const pending = await listProposals({ caseId, statuses: ["PENDING"] })
    assert.equal(pending.length, 1)
    assert.equal(pending[0].draftMessage?.to_type, "customer")
    assert.equal((await getCase(caseId))?.status, "NEEDS_DECISION")
    const analysis = model.requests[2] as { tools: { name: string }[] }
    assert.ok(analysis.tools.some((entry) => entry.name === "propose_action"))
  })

  test("I'll handle it, then the logged outcome lets the agent continue", async () => {
    const [card] = await listProposals({ caseId, statuses: ["PENDING"] })
    const handled = await decide(caseId, card.id, { decision: "handle", decided_by: "ops-shift", option_id: "own" })
    assert.equal(handled.followUps.length, 0, "nothing runs until the outcome is logged")
    const waiting = await getCase(caseId)
    assert.equal(waiting?.waitingOn, "the shift lead to log what happened")
    assert.ok(!/ops-/.test(`${waiting?.waitingOn} ${waiting?.nextStep}`), "operator-facing text uses desk titles, not ids")

    const model = scriptedModel([
      { stop_reason: "tool_use", content: [tool("t1", "message_driver", { text: "The dealer is sending their own roadside help, expected around 11:00. Please stay with the car." })] },
      { stop_reason: "end_turn", content: [text("Driver told. Next: the 17:30 ferry is at risk.")] },
    ])
    useTestLlm(model)
    const { outcome } = await import("./triggers")
    const logged = await outcome(caseId, { text: "Dealer sends their own roadside help, ETA 11:00", logged_by: "ops-shift" })
    await runFollowUps(logged.followUps)
    const events = await listEvents({ caseId })
    assert.ok(events.some((event) => event.kind === "effect" && /roadside help/.test(event.body)))
    assert.ok(events.some((event) => event.actorType === "agent" && event.recipientType === "driver" && /roadside help/.test(event.body)))
    const notes = (model.requests[0] as { messages: { content: string }[] }).messages[0].content
    assert.match(notes, /logged an outcome/i)
  })
})
