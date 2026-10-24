// One agent turn: build the case notes, call Claude in a loop with tools
// until it is done, pass every tool call through the gate, and deliver the
// final reply to whoever the turn is for. Runs are serialised per case.

import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import type Anthropic from "@anthropic-ai/sdk"
import { simNow } from "@/lib/cr/clock"
import { appendEvent, finishRun, getCase, listEvents, listProposals, startRun, updateCase, type CaseRow, type EventRow } from "@/lib/cr/queries"
import type { Audience, Channel, ToolCallTrace } from "@/lib/cr/types"
import { agentModel, llm, usageCost } from "./client"
import { AGENT_ID, MAX_ITERATIONS, MAX_TOKENS, deepEffort, fastEffort, type Effort } from "./config"
import { loadOrderFacts, type End, type OrderFacts } from "./context"
import { findClearance, submitProposal } from "./gate"
import { relative, utcTime } from "./format"
import { systemPrompt } from "./prompts"
import { actorName, names } from "./timeline"
import { runTool, toolsFor, type FollowUp, type TurnState } from "./tools"

export type TurnTrigger = "inbound" | "telemetry" | "analysis" | "decision" | "ask" | "instruct"

export type TurnRequest = {
  caseId: string
  audience: Audience
  trigger: TurnTrigger
  /** What this turn responds to, already stored as an event when someone wrote in. */
  input: string
  /** Who the reply goes to. */
  counterpart: { type: "driver" | "site" | "operator"; id: string | null; name: string | null }
  /** Where the final reply is delivered. */
  replyChannel: Channel
  voice?: boolean
  siteEnd?: End | null
  /** Receives the reply as it streams, sentence by sentence, after the safety gate. */
  onText?: (text: string) => void
}

export type TurnResult = {
  runId: string | null
  reply: string
  replyEventId: string | null
  heldForApproval: boolean
  followUps: FollowUp[]
  error: string | null
}

const JOB: Record<TurnTrigger, string> = {
  inbound: "Reply to a new message",
  telemetry: "The car reported a fault. Contact the driver first",
  analysis: "Prepare a decision",
  decision: "Operator decided",
  ask: "Question from an operator",
  instruct: "Instruction from an operator",
}

const OFFLINE_REPLY = {
  driver: "Thanks, we have your message. An operator will get back to you shortly.",
  site: "Thank you, we have your message. A colleague will get back to you shortly.",
  /** The car reported a fault and the driver has not written: safety first, nothing else. */
  telemetry: "Your car is reporting a warning. When it is safe, please leave the road at the next safe place and stop. An operator will contact you shortly.",
}

function offlineReply(request: TurnRequest): string {
  return request.trigger === "telemetry" ? OFFLINE_REPLY.telemetry : OFFLINE_REPLY[request.audience as "driver" | "site"]
}

const DRIVE_ON_FALLBACK = "An operator has to confirm before you drive on. Please stay where you are for now."

// ---------------------------------------------------------------- per-case lock

const lockHolder = globalThis as unknown as { __roadDeskLocks?: Map<string, Promise<unknown>> }

/** One run at a time per case. A message that arrives mid-run is stored first and seen by the next turn. */
export async function withCaseLock<T>(caseId: string, work: () => Promise<T>): Promise<T> {
  const locks = (lockHolder.__roadDeskLocks ??= new Map())
  const previous = locks.get(caseId) ?? Promise.resolve()
  const run = previous.catch(() => undefined).then(work)
  locks.set(caseId, run)
  try {
    return await run
  } finally {
    if (locks.get(caseId) === run) locks.delete(caseId)
  }
}

// ---------------------------------------------------------------- reply gate

/**
 * Lets a reply through one sentence at a time and stops before a sentence
 * that would clear the driver to drive on. Used for everything that reaches
 * a driver, so the rule holds even while the reply is streaming.
 */
class ReplyGate {
  private pending = ""
  text = ""
  blocked = false

  constructor(private readonly checkClearance: boolean, private readonly emit?: (text: string) => void) {}

  push(delta: string) {
    if (this.blocked) return
    this.pending += delta
    let match: RegExpExecArray | null
    while (!this.blocked && (match = /[.!?\n](?=\s)/.exec(this.pending))) {
      const sentence = this.pending.slice(0, match.index + 1)
      this.pending = this.pending.slice(match.index + 1)
      this.release(sentence)
    }
  }

  /** A model call ended; separate the next call's text with a blank line. */
  breakParagraph() {
    this.finish()
    if (this.text && !this.text.endsWith("\n\n")) this.pending = "\n\n"
  }

  finish() {
    if (!this.blocked && this.pending.trim()) this.release(this.pending)
    this.pending = ""
  }

  private release(chunk: string) {
    if (this.checkClearance && findClearance(this.text + chunk) && !findClearance(this.text)) {
      this.blocked = true
      const fallback = `${this.text ? " " : ""}${DRIVE_ON_FALLBACK}`
      this.text += fallback
      this.emit?.(fallback)
      return
    }
    const piece = this.text ? chunk : chunk.trimStart()
    if (!piece) return
    this.text += piece
    this.emit?.(piece)
  }
}

// ---------------------------------------------------------------- case notes

function eventLine(n: Awaited<ReturnType<typeof names>>, event: EventRow): string {
  const who = actorName(n, event.actorType, event.actorId)
  const to = event.recipientType ? ` → ${actorName(n, event.recipientType, event.recipientId)}` : ""
  const tag = event.kind === "photo" ? ` [photo, event ${event.id}]` : event.channel === "safety" ? " [safety instruction]" : ""
  return `[${utcTime(event.at)}] ${who}${to} (${event.channel.replace(/_/g, " ")})${tag}: ${event.body}`
}

async function caseNotes(request: TurnRequest, caseRow: CaseRow, facts: OrderFacts): Promise<string> {
  const n = await names()
  const events = (await listEvents({ caseId: caseRow.id })).slice(-60)
  const proposals = await listProposals({ caseId: caseRow.id })
  const pending = proposals.filter((row) => row.status === "PENDING")
  const decided = proposals.filter((row) => row.status !== "PENDING").slice(-5)
  const vehicle = facts.vehicle ? `${facts.vehicle.make} ${facts.vehicle.model}` : "vehicle not recorded"
  const route = `${String(facts.pickup.address.city ?? "?")} → ${String(facts.delivery.address.city ?? "?")}`
  const counterpart = request.counterpart
  const siteNote = request.audience === "site"
    ? (request.siteEnd === "delivery" ? facts.delivery : facts.pickup).customerSide
      ? "\nThis place belongs to the paying customer: your reply will be held as a draft for an operator to approve, not sent."
      : "\nThis place is not the customer: your reply is sent to them directly."
    : ""
  return [
    "# Case notes",
    `Job: ${JOB[request.trigger]}${request.voice ? " (voice call: one or two short spoken sentences)" : ""}`,
    `Now: ${utcTime(simNow())} (simulated clock)`,
    `Order: ${facts.reference} · ${vehicle} · ${route}`,
    `Case: ${caseRow.title} · ${caseRow.kind.toLowerCase().replace(/_/g, " ")} · ${caseRow.status.toLowerCase().replace(/_/g, " ")} · urgency ${caseRow.urgency.toLowerCase()} · opened ${relative(caseRow.openedAt)}`,
    `You are talking to: ${counterpart.name ?? counterpart.type} (${counterpart.type}) via ${request.replyChannel.replace(/_/g, " ")}${siteNote}`,
    pending.length ? `Decisions waiting for an operator:\n${pending.map((row) => `- ${row.title} (${row.actionType})`).join("\n")}` : "Decisions waiting for an operator: none",
    decided.length ? `Earlier decisions:\n${decided.map((row) => `- ${row.title}: ${row.status.toLowerCase().replace(/_/g, " ")}${row.decisionNote ? ` (${row.decisionNote})` : ""}`).join("\n")}` : "",
    "",
    "# Conversation and work on this case so far (oldest first)",
    events.length ? events.map((event) => eventLine(n, event)).join("\n") : "Nothing yet.",
    "",
    "# Now",
    request.input,
  ].filter((line) => line !== "").join("\n")
}

// ---------------------------------------------------------------- the turn

function effortFor(request: TurnRequest): Effort {
  return request.trigger === "inbound" || request.trigger === "telemetry" ? fastEffort() : deepEffort()
}

/** Hand the case to a person when the agent cannot continue (no key, an API error, a refusal, the step limit). */
async function handToPerson(caseRow: CaseRow, reason: string) {
  await appendEvent({
    caseId: caseRow.id, orderId: caseRow.orderId, actorType: "system", actorId: "road-desk", kind: "note", channel: "internal",
    body: `The agent stopped and handed this case to a person: ${reason}`,
  })
  await updateCase(caseRow.id, { status: "NEEDS_DECISION", owner: null, nextStep: `A person takes over: ${reason}` })
}

async function deliver(request: TurnRequest, caseRow: CaseRow, facts: OrderFacts, reply: string, extra: Record<string, unknown> = {}): Promise<{ eventId: string | null; held: boolean }> {
  const text = reply.trim()
  if (!text || text === "NO_MESSAGE") return { eventId: null, held: false }
  if (request.audience === "site") {
    const endpoint = request.siteEnd === "delivery" ? facts.delivery : facts.pickup
    if (endpoint.customerSide) {
      // The customer rule covers replies too: draft it, a person approves it.
      const name = String(endpoint.site?.name ?? endpoint.address.name ?? "the site")
      await submitProposal({ audience: "operator", caseRow, facts }, {
        action_type: "CONTACT_SITE_AS_CUSTOMER",
        title: `Reply to ${name}`,
        rationale: `${name} belongs to the customer, so the agent drafted the reply and a person approves it before it is sent.`,
        handover: { what_happened: `${request.counterpart.name ?? name} wrote in about ${facts.reference}.`, facts: [], agent_did: ["Drafted a reply from the order records."], unknowns: [], recommendation: "Send the drafted reply.", alternatives: ["Edit it first", "Reply yourself"] },
        changes: [],
        draft_message: { to: endpoint.end === "pickup" ? "pickup_site" : "delivery_site", channel: "app_chat", subject: "", body: text, language: "" },
        options: [],
        evidence_refs: [],
        next_step_if_approved: `The reply goes to ${name}.`,
        next_step_if_rejected: "Nothing is sent; reply to them yourself.",
      })
      return { eventId: null, held: true }
    }
    const event = await appendEvent({
      caseId: caseRow.id, orderId: caseRow.orderId, actorType: "agent", actorId: AGENT_ID, kind: "message", channel: "site_chat",
      recipientType: "site", recipientId: request.counterpart.id, body: text, data: { name: request.counterpart.name, ...extra },
    })
    return { eventId: event.id, held: false }
  }
  if (request.audience === "driver") {
    const event = await appendEvent({
      caseId: caseRow.id, orderId: caseRow.orderId, actorType: "agent", actorId: AGENT_ID, kind: request.voice ? "voice_turn" : "message",
      channel: request.replyChannel, recipientType: "driver", recipientId: request.counterpart.id, body: text, data: extra,
    })
    return { eventId: event.id, held: false }
  }
  const event = await appendEvent({
    caseId: caseRow.id, orderId: caseRow.orderId, actorType: "agent", actorId: AGENT_ID, kind: request.trigger === "ask" ? "message" : "note",
    channel: request.replyChannel, recipientType: "operator", recipientId: request.counterpart.id, body: text, data: extra,
  })
  return { eventId: event.id, held: false }
}

/** Run one turn. Callers hold the case lock (see `withCaseLock`). */
export async function runTurn(request: TurnRequest): Promise<TurnResult> {
  let caseRow = await getCase(request.caseId)
  if (!caseRow) throw new Error("Case not found")
  const facts = await loadOrderFacts(caseRow.orderId)
  if (!facts) throw new Error("Order not found")
  const toPerson = request.audience !== "operator"
  const holdsReply = request.audience === "site" && (request.siteEnd === "delivery" ? facts.delivery : facts.pickup).customerSide
  const gate = new ReplyGate(request.audience === "driver", holdsReply ? undefined : request.onText)

  const asking = request.trigger === "ask"
  const client = llm()
  if (!client) {
    // Stub mode: no model key. A fixed acknowledgement, and a person takes the case.
    if (asking) return { runId: null, reply: "The agent is offline right now (no model key is configured).", replyEventId: null, heldForApproval: false, followUps: [], error: "offline" }
    await handToPerson(caseRow, "the agent is offline (no model key configured)")
    if (!toPerson || holdsReply) return { runId: null, reply: "", replyEventId: null, heldForApproval: false, followUps: [], error: "offline" }
    const reply = offlineReply(request)
    gate.push(reply)
    gate.finish()
    const delivered = await deliver(request, caseRow, facts, gate.text, { canned: true })
    return { runId: null, reply: gate.text, replyEventId: delivered.eventId, heldForApproval: false, followUps: [], error: "offline" }
  }

  const model = agentModel()
  const effort = effortFor(request)
  const notes = await caseNotes(request, caseRow, facts)
  const run = await startRun({ caseId: caseRow.id, orderId: caseRow.orderId, audience: request.audience, model, effort, input: request.input })
  const state: TurnState = {
    audience: request.audience, caseRow, facts, readOnly: request.trigger === "ask",
    runId: run.id,
    driverId: caseRow.driverId,
    driverName: caseRow.driverId ? facts.driverNames.get(caseRow.driverId) ?? null : null,
    siteEnd: request.siteEnd ?? null,
    followUps: [],
    traces: [] as ToolCallTrace[],
    closed: false,
  }
  const tools = toolsFor(request.audience, request.trigger === "ask")
  const system: Anthropic.TextBlockParam[] = [{ type: "text", text: systemPrompt(request.audience), cache_control: { type: "ephemeral" } }]
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: notes }]
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost_usd: 0, calls: 0 }
  let stopReason: string | null = null
  let error: string | null = null

  try {
    for (let iteration = 0; ; iteration++) {
      if (iteration >= MAX_ITERATIONS) {
        error = "step limit reached"
        if (!asking) await handToPerson(state.caseRow, `the agent reached its step limit of ${MAX_ITERATIONS} model calls`)
        break
      }
      const stream = client.messages.stream({ model, max_tokens: MAX_TOKENS, system, tools, messages, output_config: { effort } })
      stream.on("text", (delta) => gate.push(delta))
      const message = await stream.finalMessage()
      gate.breakParagraph()
      usage.calls++
      usage.input_tokens += message.usage.input_tokens
      usage.output_tokens += message.usage.output_tokens
      usage.cache_read_input_tokens += message.usage.cache_read_input_tokens ?? 0
      usage.cache_creation_input_tokens += message.usage.cache_creation_input_tokens ?? 0
      usage.cost_usd += usageCost(message.usage)
      stopReason = message.stop_reason

      if (message.stop_reason === "refusal") {
        error = "the model declined"
        if (!asking) await handToPerson(state.caseRow, "the model declined to continue this case")
        break
      }
      messages.push({ role: "assistant", content: message.content })
      if (message.stop_reason === "pause_turn") continue
      if (message.stop_reason !== "tool_use") break

      const results: Anthropic.ToolResultBlockParam[] = []
      for (const block of message.content) {
        if (block.type !== "tool_use") continue
        const outcome = await runTool(state, block.name, block.input)
        results.push({ type: "tool_result", tool_use_id: block.id, content: outcome.content, is_error: outcome.isError || undefined })
      }
      messages.push({ role: "user", content: results })
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
    if (!asking) await handToPerson(state.caseRow, `the agent hit an error (${error})`)
  }

  gate.finish()
  if (gate.blocked) {
    await appendEvent({
      caseId: state.caseRow.id, orderId: state.caseRow.orderId, actorType: "system", actorId: "gate", kind: "tool_call", channel: "internal",
      body: "Approval gate held back a sentence that would have cleared the driver to drive on; the driver was told an operator must confirm.",
      data: { refused: true, rule: "no_drive_on_clearance" },
    })
  }

  let reply = gate.text
  if (error && toPerson && !reply.trim() && !holdsReply) {
    reply = offlineReply(request)
    request.onText?.(reply)
  }
  const delivered = await deliver(request, state.caseRow, facts, reply)

  // A driver-facing turn that ends without a decision path keeps the case visible.
  caseRow = (await getCase(state.caseRow.id)) ?? state.caseRow
  if (!error && !state.closed && caseRow.status === "AGENT_WORKING" && state.followUps.length === 0 && request.trigger !== "ask") {
    const waitingOnDriver = request.audience === "driver" || request.trigger === "telemetry"
    await updateCase(caseRow.id, { status: "WAITING_EXTERNAL", waitingOn: waitingOnDriver ? "the driver's reply" : request.audience === "site" ? "the site's reply" : null, owner: "agent" })
  }

  const finished = await finishRun(run.id, {
    status: error ? "ERROR" : "DONE", toolCalls: state.traces, output: reply, stopReason, usage, error,
  })
  writeTrace(finished ?? run, { system: request.audience, notes, messages })
  return { runId: run.id, reply, replyEventId: delivered.eventId, heldForApproval: delivered.held, followUps: state.followUps, error }
}

/** With AGENT_TRACE_DIR set, every run is also written to disk as JSON for judges and debugging. */
function writeTrace(run: Awaited<ReturnType<typeof startRun>>, extra: { system: Audience; notes: string; messages: Anthropic.MessageParam[] }) {
  const dir = process.env.AGENT_TRACE_DIR
  if (!dir) return
  const scrub = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(scrub)
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>
      if (record.type === "base64" && typeof record.data === "string") return { ...record, data: `[${record.data.length} base64 characters]` }
      return Object.fromEntries(Object.entries(record).map(([key, inner]) => [key, scrub(inner)]))
    }
    return value
  }
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${run.startedAt.toISOString().replace(/[:.]/g, "-")}-${run.id}.json`)
  writeFileSync(file, JSON.stringify(scrub({ run, system_prompt: `systemPrompt("${extra.system}")`, case_notes: extra.notes, messages: extra.messages }), null, 2))
}
