// Loop tests with a scripted stand-in for the model: they check the wiring
// (tools run through the gate, replies reach the right person, the streamed
// reply passes the drivability screen, hand-over builds a decision card, a
// decision continues the case, a failed call is retried once) without
// spending tokens. The model's judgement is tested by real runs in traces/.

import "dotenv/config"
delete process.env.OPENROUTER_API_KEY

import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"
import { inArray } from "drizzle-orm"
import { closeCrDb, crDb } from "@/lib/cr/db"
import { getCase, listEffects, listEvents, listProposals, resolveOrder } from "@/lib/cr/queries"
import { crAgentRuns, crCases, crEffects, crEvents, crProposals } from "@/lib/cr/schema"
import { useTestLlm } from "./client"
import { decide, handleDriverMessage, handleTelemetryFault, outcome, prepareDriverMessage, runFollowUps } from "./triggers"

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
type Step = { content: Block[]; stop_reason: "end_turn" | "tool_use" | "refusal" } | { throws: string }

/**
 * Plays back scripted model responses in order and records what it was sent.
 * The drivability classifier (messages.create) answers BLOCK for any text
 * containing one of `blockPhrases`, ALLOW otherwise.
 */
function scriptedModel(steps: Step[], blockPhrases: string[] = []) {
  const requests: Record<string, unknown>[] = []
  const screened: string[] = []
  let index = 0
  return {
    requests,
    screened,
    get remaining() { return steps.length - index },
    messages: {
      async create(params: { messages: { content: string }[] }) {
        const content = params.messages[0].content
        screened.push(content)
        const block = blockPhrases.some((phrase) => content.split("Message to the driver:")[1]?.includes(phrase))
        return { content: [{ type: "text", text: block ? "BLOCK" : "ALLOW" }], usage: { cost: 0.00001 } }
      },
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
            if ("throws" in step) throw new Error(step.throws)
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

async function clearOrder() {
  const order = (await resolveOrder(ORDER))!
  const stale = (await crDb().select({ id: crCases.id }).from(crCases).where(inArray(crCases.orderId, [order.id]))).map((row) => row.id)
  touched.push(...stale)
  if (stale.length) {
    await crDb().delete(crProposals).where(inArray(crProposals.caseId, stale))
    await crDb().delete(crEffects).where(inArray(crEffects.caseId, stale))
    await crDb().delete(crEvents).where(inArray(crEvents.caseId, stale))
    await crDb().delete(crAgentRuns).where(inArray(crAgentRuns.caseId, stale))
    await crDb().delete(crCases).where(inArray(crCases.id, stale))
  }
}

before(clearOrder)

after(async () => {
  useTestLlm(null)
  await clearOrder()
  await closeCrDb()
})

describe("scenario A wiring", () => {
  let caseId = ""

  test("a fault opens a case and the agent contacts the driver first, with a reply deadline", async () => {
    const model = scriptedModel([
      { stop_reason: "tool_use", content: [
        tool("t1", "safety_instruction", { template_id: "stop_when_safe" }),
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
    assert.equal(safety?.recipientId, DRIVER)
    assert.match(safety!.body, /^Sofia, please slow down and stop at the next safe place/, "the template, with the driver's name filled in by the server")
    const reply = events.find((event) => event.id === result.replyEventId)
    assert.equal(reply?.recipientType, "driver")
    assert.equal(reply?.data.call, true, "proactive fault outreach rings the driver call surface")
    assert.match(reply!.body, /Are you safe/)
    assert.ok(model.screened.some((entry) => entry.includes("Are you safe")), "the reply passed the classifier")

    const row = await getCase(caseId)
    assert.equal(row?.kind, "VEHICLE_WARNING")
    assert.equal(row?.status, "WAITING_EXTERNAL")
    assert.equal(row?.waitingFor, "driver")
    const minutes = (row!.nextCheckAt!.getTime() - row!.updatedAt.getTime()) / 60000
    assert.ok(minutes > 4 && minutes <= 5.1, "an urgent case gives the driver 5 minutes to answer")
    assert.equal(row?.lastRunStatus, "DONE")

    const request = model.requests[0] as { system: { cache_control?: unknown }[]; messages: { content: string }[]; tools: { name: string; strict?: boolean }[] }
    assert.ok(request.system[0].cache_control)
    assert.match(request.messages[0].content, new RegExp(ORDER))
    assert.ok(request.tools.every((entry) => entry.strict === true))
    assert.ok(!request.tools.some((entry) => entry.name === "propose_action"), "driver turns cannot propose")
  })

  test("the streamed reply never clears the driver to drive on; it becomes a card", async () => {
    useTestLlm(scriptedModel([
      { stop_reason: "end_turn", content: [text("Thanks for stopping. The light is amber now, so you can continue driving slowly. Keep me posted.")] },
    ]))
    const streamed: string[] = []
    const prepared = await prepareDriverMessage({ orderRef: ORDER, driverId: DRIVER, text: "The light changed to amber. Can I go on?", mode: "chat" })
    const { result } = await handleDriverMessage(prepared, (piece) => streamed.push(piece))
    const all = streamed.join("")
    assert.ok(!/can continue|amber/i.test(all), "nothing of the held reply reached the driver")
    assert.match(all, /^An operator has to confirm/)
    assert.equal(result.reply, all)
    const [card] = await listProposals({ caseId, statuses: ["PENDING"] })
    assert.equal(card.actionType, "CLEAR_TO_CONTINUE")
    assert.match(card.draftMessage!.body, /you can continue driving/)
    assert.equal((await getCase(caseId))?.status, "NEEDS_DECISION")
    await decide(caseId, card.id, { decision: "reject", decided_by: "ops-shift", note: "Keep the car stopped." })
  })

  test("the classifier catches a clearance the patterns miss", async () => {
    const model = scriptedModel([
      { stop_reason: "end_turn", content: [text("Good to hear. The amber light is nothing to worry about, head to the ferry.")] },
    ], ["head to the ferry"])
    useTestLlm(model)
    const prepared = await prepareDriverMessage({ orderRef: ORDER, driverId: DRIVER, text: "It's amber now.", mode: "chat" })
    const { result } = await handleDriverMessage(prepared)
    assert.ok(!/ferry/.test(result.reply))
    assert.match(result.reply, /An operator has to confirm/)
    // The operator rejected clearing this driver in the previous test, but the driver has written since: a new fact,
    // so the held message becomes a new card rather than a silent note.
    const cards = await listProposals({ caseId, statuses: ["PENDING"] })
    assert.ok(cards.some((card) => card.actionType === "CLEAR_TO_CONTINUE" && /head to the ferry/.test(card.draftMessage!.body)))
    for (const card of cards) await decide(caseId, card.id, { decision: "reject", decided_by: "ops-shift", note: "Keep the car stopped." })
  })

  test("after a rejection with nothing new, a held clearance is noted without a second card", async () => {
    const { holdForClearance } = await import("./tools")
    const { loadOrderFacts } = await import("./context")
    const caseRow = (await getCase(caseId))!
    const facts = (await loadOrderFacts(caseRow.orderId))!
    assert.equal(await holdForClearance({ audience: "operator", caseRow, facts }, "You can drive on to the terminal now.", "test"), "noted")
    assert.equal((await listProposals({ caseId, statuses: ["PENDING"] })).filter((card) => card.actionType === "CLEAR_TO_CONTINUE").length, 0)
  })

  test("a failed model call is retried once when nothing was sent", async () => {
    const model = scriptedModel([
      { throws: "upstream timeout" },
      { stop_reason: "end_turn", content: [text("Thanks. Please stay with the car.")] },
    ])
    useTestLlm(model)
    const prepared = await prepareDriverMessage({ orderRef: ORDER, driverId: DRIVER, text: "I'm parked.", mode: "chat" })
    const { result } = await handleDriverMessage(prepared)
    assert.equal(result.error, null)
    assert.match(result.reply, /stay with the car/)
    assert.ok((await listEvents({ caseId })).some((event) => /trying once more/.test(event.body)))
  })

  test("text written before a tool call is the model's narration and never reaches the driver", async () => {
    const model = scriptedModel([
      { stop_reason: "tool_use", content: [text("The car shows speed 0 at a service area, so I'll add the engine-off instruction."), tool("s1", "safety_instruction", { template_id: "engine_off" })] },
      { stop_reason: "end_turn", content: [text("Thanks. Please keep the engine off and stay near the car.")] },
      // A reply written before a last bookkeeping call, with nothing after it, is still the reply.
      { stop_reason: "tool_use", content: [text("Noted, thanks. Stay with the car."), tool("u1", "update_case", { title: "Flashing engine light", summary: "Driver parked, engine off.", kind: "VEHICLE_WARNING", urgency: "CRITICAL" })] },
      { stop_reason: "end_turn", content: [] },
    ])
    useTestLlm(model)
    const first = await handleDriverMessage(await prepareDriverMessage({ orderRef: ORDER, driverId: DRIVER, text: "I'm parked at a service area.", mode: "chat" }))
    assert.ok(!/speed 0|I'll add/.test(first.result.reply), "the narration was not sent")
    assert.match(first.result.reply, /keep the engine off/)
    assert.ok(!model.screened.some((entry) => entry.includes("speed 0")))
    const second = await handleDriverMessage(await prepareDriverMessage({ orderRef: ORDER, driverId: DRIVER, text: "OK.", mode: "chat" }))
    assert.equal(second.result.reply, "Noted, thanks. Stay with the car.")
  })

  test("a reply split around a tool call mid-sentence reaches the driver whole", async () => {
    useTestLlm(scriptedModel([
      { stop_reason: "tool_use", content: [text("Yes, please go with the truck and stay with"), tool("u2", "update_case", { title: "Car on the tow truck", summary: "Collected.", kind: "VEHICLE_WARNING", urgency: "HIGH" })] },
      { stop_reason: "end_turn", content: [text("the car.")] },
    ]))
    const { result } = await handleDriverMessage(await prepareDriverMessage({ orderRef: ORDER, driverId: DRIVER, text: "The truck is here. Do I go with them?", mode: "chat" }))
    assert.equal(result.reply, "Yes, please go with the truck and stay with the car.")
  })

  test("a tool call with broken JSON is made once more with a note, without restarting the turn", async () => {
    const model = scriptedModel([
      { throws: "Expected ',' or '}' after property value in JSON at position 435 (line 1 column 436)" },
      { stop_reason: "end_turn", content: [text("Thanks, noted. Please stay with the car.")] },
    ])
    useTestLlm(model)
    const restarts = async () => (await listEvents({ caseId })).filter((event) => /trying once more/.test(event.body)).length
    const before = await restarts()
    const { result } = await handleDriverMessage(await prepareDriverMessage({ orderRef: ORDER, driverId: DRIVER, text: "Still here.", mode: "chat" }))
    assert.equal(result.error, null)
    assert.match(result.reply, /stay with the car/)
    assert.match(JSON.stringify(model.requests[1]), /could not be read/)
    assert.equal(await restarts(), before)
  })

  test("hand-over builds a decision card in a separate turn", async () => {
    const model = scriptedModel([
      { stop_reason: "tool_use", content: [tool("t1", "hand_over", { reason: "Recovery is the owner's decision." })] },
      { stop_reason: "end_turn", content: [text("Thanks. Stay with the car; an operator is contacting the owner now.")] },
      // The analysis turn:
      { stop_reason: "tool_use", content: [tool("t2", "propose_action", {
        action_type: "CONTACT_CUSTOMER", title: "Call the dealer about recovery", rationale: "The car cannot be driven on; recovery is the owner's call.",
        ...handover, changes: [],
        draft_to: "customer", draft_channel: "phone_call", draft_subject: "", draft_body: "The car has stopped with a misfire. Your own roadside help, or should we arrange a tow?", draft_language: "en",
        options: [{ id: "own", label: "Dealer's own roadside help", description: "", recommended: true }, { id: "tow", label: "We arrange a tow", description: "", recommended: false }],
        evidence_refs: handover.facts[0].sources, assumptions: [{ kind: "car_codes", codes: ["P0300", "P0302"], label: "Car still reports P0300 and P0302" }], window_start_utc: "", window_end_utc: "",
        next_step_if_approved: "The operator calls the dealer.", next_step_if_rejected: "The agent asks what to do instead.",
      })] },
      { stop_reason: "end_turn", content: [text("Decision card ready: call the dealer about recovery.")] },
    ])
    useTestLlm(model)
    const prepared = await prepareDriverMessage({ orderRef: ORDER, driverId: DRIVER, text: "I'm at a service area, engine off.", mode: "chat" })
    const { result } = await handleDriverMessage(prepared)
    assert.equal(result.followUps.length, 1)
    await runFollowUps(result.followUps)
    const [card] = await listProposals({ caseId, statuses: ["PENDING"] })
    assert.equal(card.draftMessage?.to_type, "customer")
    assert.equal(card.assumptions.length, 1)
    assert.equal((await getCase(caseId))?.status, "NEEDS_DECISION")
    assert.ok((model.requests[2] as { tools: { name: string }[] }).tools.some((entry) => entry.name === "propose_action"))
  })

  test("I'll handle it, then the logged outcome lets the agent continue, and the case waits with a check time", async () => {
    // The car must still report the codes the card relied on.
    const { insertTelemetry } = await import("@/lib/cr/queries")
    const order = (await resolveOrder(ORDER))!
    await insertTelemetry([{ orderId: order.id, source: "OBD", data: { mil: "FLASHING", dtcs: ["P0300", "P0302"] } }])

    const [card] = await listProposals({ caseId, statuses: ["PENDING"] })
    const handled = await decide(caseId, card.id, { decision: "handle", decided_by: "ops-shift", option_id: "own" })
    assert.equal(handled.followUps.length, 0, "nothing runs until the outcome is logged")
    const waiting = await getCase(caseId)
    assert.equal(waiting?.waitingOn, "the shift lead to log what happened")
    assert.ok(!/ops-/.test(`${waiting?.waitingOn} ${waiting?.nextAction}`), "operator-facing text uses desk titles, not ids")

    const model = scriptedModel([
      { stop_reason: "tool_use", content: [
        tool("t1", "message_driver", { text: "The dealer is sending their own roadside help, expected around 11:00. Please stay with the car." }),
        tool("t2", "wait_for", { waiting_for: "provider", waiting_on: "the dealer's roadside help (ETA 11:00)", next_action: "Check at 11:15 that help arrived, then the ferry cutoff.", check_in_minutes: 75 }),
      ] },
      { stop_reason: "end_turn", content: [text("Driver told. Waiting on roadside help; next check 11:15.")] },
    ])
    useTestLlm(model)
    const logged = await outcome(caseId, { text: "Dealer sends their own roadside help, ETA 11:00", logged_by: "ops-shift" })
    await runFollowUps(logged.followUps)
    const events = await listEvents({ caseId })
    assert.ok((await listEffects({ caseId, kinds: ["OUTCOME_LOGGED"] })).some((effect) => /roadside help/.test(String(effect.value.text))))
    assert.ok(events.some((event) => event.actorType === "agent" && event.recipientType === "driver" && /roadside help/.test(event.body)))
    const row = await getCase(caseId)
    assert.equal(row?.status, "WAITING_EXTERNAL")
    assert.equal(row?.waitingFor, "provider")
    assert.ok(row?.nextCheckAt && row.nextAction, "the case waits with a next check time")
    assert.match((model.requests[0] as { messages: { content: string }[] }).messages[0].content, /logged an outcome/i)
  })
})
