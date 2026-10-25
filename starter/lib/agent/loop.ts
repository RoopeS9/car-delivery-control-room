// One agent turn: build the case notes, call Claude in a loop with tools
// until it is done, pass every tool call through the gate, and deliver the
// final reply to whoever the turn is for. Runs are serialised per case.

import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import type Anthropic from "@anthropic-ai/sdk"
import { simNow } from "@/lib/cr/clock"
import { beginRuntimeWork } from "@/lib/cr/activity"
import { appendEvent, finishRun, getCase, listEvents, listProposals, startRun, updateCase, type CaseRow, type EventRow } from "@/lib/cr/queries"
import type { Audience, Channel, ToolCallTrace } from "@/lib/cr/types"
import { agentModel, llm, usageCost } from "./client"
import { AGENT_ID, MAX_ITERATIONS, MAX_TOKENS, deepEffort, fastEffort, type Effort } from "./config"
import { loadOrderFacts, type End, type OrderFacts } from "./context"
import { loadDriverSafetyContext, screenDriverMessage, type Screen } from "./drivability"
import { agentCouldNotFinish, ensureOpenCaseFields, replyDeadlineMinutes } from "./followup"
import { submitProposal } from "./gate"
import { localTime, relative, utcTime } from "./format"
import { systemPrompt } from "./prompts"
import { actorName, names } from "./timeline"
import { holdForClearance, idsIn, runTool, toolsFor, type FollowUp, type TurnState } from "./tools"

export type TurnTrigger = "inbound" | "telemetry" | "analysis" | "decision" | "ask" | "instruct" | "follow_up"

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
  /** Receives the reply as it streams, sentence by sentence, after the drivability screen. */
  onText?: (text: string) => void
  /** Override the effort level for this turn. */
  effort?: Effort
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
  follow_up: "Follow-up due",
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
  const release = beginRuntimeWork("agent work")
  const locks = (lockHolder.__roadDeskLocks ??= new Map())
  const previous = locks.get(caseId) ?? Promise.resolve()
  const run = previous.catch(() => undefined).then(work)
  locks.set(caseId, run)
  try {
    return await run
  } finally {
    if (locks.get(caseId) === run) locks.delete(caseId)
    release()
  }
}

/** True while a run holds this case. The watchdog leaves such cases alone. */
export function isCaseLocked(caseId: string): boolean {
  return Boolean(lockHolder.__roadDeskLocks?.has(caseId))
}

// ---------------------------------------------------------------- reply gate

const ALLOW: Screen = { allowed: true, layer: "none", reason: null, costUsd: 0 }

/**
 * Decides what of the model's text reaches the person. Text the model writes
 * before a tool call is its own narration ("the car shows speed 0, so I'll
 * ..."), not the reply, so each model call's text is held until the call
 * ends: released when the call ends the turn, kept back when it goes on to
 * call a tool. For drivers the whole reply is screened once (patterns, then
 * the classifier; one check per reply keeps false alarms rare); a reply that
 * reads as permission to drive on is held and the driver gets a fixed line
 * instead (PLAN.md 4.2, drivability screen).
 */
class ReplyGate {
  private call = ""
  private chain: Promise<void> = Promise.resolve()
  /** The last text written before a tool call, used only if the turn ends without a reply. */
  private narration = ""
  /** What reached the person. */
  text = ""
  /** Everything the model wrote as its reply, including anything held back. */
  written = ""
  blocked: { reason: string | null } | null = null
  costUsd = 0

  /** When set, a held reply sends nothing yet: the turn asks the model once to write it again (see `rewriteHeldReply`). */
  deferFallback = false

  constructor(private readonly screen: ((text: string) => Promise<Screen>) | null, private readonly emit?: (text: string) => void) {}

  /** The fixed line instead of a held reply. */
  sendFallback() {
    const fallback = `${this.text ? "\n\n" : ""}${DRIVE_ON_FALLBACK}`
    this.text += fallback
    this.emit?.(fallback)
  }

  push(delta: string) {
    this.call += delta
  }

  /** A model call ended. Its text is the reply only if the call did not go on to use a tool. */
  endCall(stopReason: string | null) {
    const text = this.call
    this.call = ""
    if (!text.trim()) return
    if (stopReason === "tool_use") {
      this.narration = text
      return
    }
    // Some models (DeepSeek) start the reply, call a tool mid-sentence and finish the sentence after it: "Yes, please
    // go with" … "the car." A last piece that continues a sentence is joined to the text it continues.
    const continues = /^\s*[a-z,;)]/.test(text) && this.narration.trim() && !/[.!?]["')]?\s*$/.test(this.narration)
    this.release(continues ? `${this.narration.trimEnd()} ${text.trimStart()}` : text)
  }

  /** Wait until the reply has been screened and released (or held). On a failed turn the narration stays private. */
  async finish(errored = false): Promise<void> {
    this.call = ""
    // The model wrote its reply and then only closed or updated the case: send that text. Text written before a tool
    // call in a turn that then failed is the model's own notes ("let me read the records"), never a reply.
    if (!errored && !this.written.trim() && this.narration.trim()) this.release(this.narration)
    await this.chain
  }

  /** Set for a driver or a site: what reaches them is the message alone. */
  forPerson = false
  /** The person's first name, to tell the model's own note about them from the message to them. */
  personName: string | null = null

  private release(raw: string) {
    // Some models write their own notes, a "---" line, then the message: only the message reaches a person.
    if (this.forPerson) {
      const parts = raw.split(/\n\s*(?:-{3,}|\*{3,}|_{3,})\s*(?:\n|$)/).map((part) => part.trim()).filter(Boolean)
      if (parts.length > 1) raw = parts.at(-1)!
      raw = withoutLeadingNote(raw, this.personName)
      // A phone chat shows text as written: no bold or heading marks.
      raw = raw.replace(/\*\*([^*\n]+)\*\*/g, "$1").replace(/__([^_\n]+)__/g, "$1").replace(/^#{1,6}\s+/gm, "")
    }
    const piece = this.written ? `\n\n${raw.trim()}` : raw.trim()
    this.written += piece
    const check = this.screen ? this.screen(this.written) : Promise.resolve(ALLOW)
    this.chain = this.chain.then(async () => {
      if (this.blocked) return
      const result = await check.catch((): Screen => ({ allowed: false, layer: "fail_closed", reason: "the screen failed", costUsd: 0 }))
      this.costUsd += result.costUsd
      if (!result.allowed) {
        this.blocked = { reason: result.reason }
        if (!this.deferFallback) this.sendFallback()
        return
      }
      this.text += piece
      this.emit?.(piece)
    })
  }
}

/**
 * "Now let me contact Leo — he hasn't written yet. Leo, the car has reported …": a note about the person, then the
 * message to them. When the text before the first "<Name>," reads as the model's own note (it plans, or speaks of the
 * person in the third person), only the message from "<Name>," on is sent.
 */
export function withoutLeadingNote(text: string, name: string | null): string {
  if (!name) return text
  const first = name.trim().split(/\s+/)[0]
  if (!first) return text
  const escaped = first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const vocative = new RegExp(`(^|[.!?…]\\s+|\\n\\s*)(${escaped},)`).exec(text)
  if (!vocative || vocative.index === 0 && !vocative[1]) return text
  const before = text.slice(0, vocative.index + vocative[1].length)
  // A planning opener ("Now let me …"), or the person or "the driver" spoken of in the third person.
  const note = /^(now,?\s+|first,?\s+|next,?\s+|okay,?\s+|ok,?\s+|alright,?\s+)?(let me|let's|I'll now|I will now|I need to|I should|I'm going to)\b/i.test(before.trim())
    || new RegExp(`\\b(contact|message|reach|tell|ask|write to|reply to)\\s+(${escaped}|the driver)\\b|\\b(${escaped}|the driver)\\s+(hasn't|has not|is|was|wrote|said)\\b|\\b(he|she|they) (hasn't|has not)\\b`, "i").test(before)
  return note ? text.slice(vocative.index + vocative[1].length) : text
}

/** One more call after a held driver reply: the same answer without any word on whether the car may be driven. */
async function rewriteHeldReply(client: Anthropic, call: { model: string; system: Anthropic.TextBlockParam[]; tools: Anthropic.Tool[]; messages: Anthropic.MessageParam[]; effort: Effort },
  held: ReplyGate, screen: (text: string) => Promise<Screen>, onText: ((text: string) => void) | undefined, usage: Usage): Promise<ReplyGate | null> {
  const nudge = `Your reply to the driver was held and not sent: it reads as permission to drive on${held.blocked?.reason ? ` (${held.blocked.reason})` : ""}. Only an operator can say that. Write the reply to the driver again, answering what they asked, without saying or implying that they may keep driving, that the car is drivable or fine to drive. Say an operator confirms whether they continue. Reply with the message only, no tool calls.`
  const messages: Anthropic.MessageParam[] = [...call.messages]
  const last = messages.at(-1)
  if (last?.role === "user") last.content = typeof last.content === "string" ? `${last.content}\n\n${nudge}` : [...last.content, { type: "text", text: nudge }]
  else messages.push({ role: "user", content: nudge })
  const gate = new ReplyGate(screen, onText)
  gate.deferFallback = true
  gate.forPerson = true
  try {
    const message = await callModel(client, { model: call.model, max_tokens: MAX_TOKENS, system: call.system, tools: call.tools, tool_choice: { type: "none" }, messages, output_config: { effort: call.effort } }, gate, usage)
    gate.endCall(message.stop_reason === "tool_use" ? "end_turn" : message.stop_reason)
    await gate.finish()
  } catch (error) {
    console.error("Road Desk: rewriting a held reply failed", error instanceof Error ? error.message : error)
    return null
  }
  usage.cost_usd += gate.costUsd
  return gate.blocked || !gate.text.trim() ? null : gate
}

// ---------------------------------------------------------------- one model call

type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; cost_usd: number; calls: number; attempts: number }

const MALFORMED_TOOL_HINT = "(Note from the Road Desk: your last tool call could not be read. Its input was not valid JSON, probably because parameter tags were mixed into a JSON value. Make the call again with every parameter written as plain JSON.)"

/**
 * One streamed model call. OpenRouter reports the cost in the final
 * message_delta's usage, which the SDK's message snapshot drops, so it is read
 * from the stream. If the model writes a tool call whose input is not valid
 * JSON (it sometimes mixes its own parameter tags into a nested value), the
 * call is made once more with a short note appended to the last user message.
 */
async function callModel(client: Anthropic, body: Anthropic.MessageStreamParams, gate: ReplyGate, usage: Usage): Promise<Anthropic.Message> {
  for (let tries = 0; ; tries++) {
    const stream = client.messages.stream(body, { timeout: 120000 })
    let cost = 0
    stream.on("text", (delta) => gate.push(delta))
    stream.on("streamEvent", (event) => {
      if (event.type === "message_delta") cost = usageCost(event.usage) || cost
    })
    try {
      const message = await stream.finalMessage()
      usage.calls++
      usage.input_tokens += message.usage.input_tokens
      usage.output_tokens += message.usage.output_tokens
      usage.cache_read_input_tokens += message.usage.cache_read_input_tokens ?? 0
      usage.cache_creation_input_tokens += message.usage.cache_creation_input_tokens ?? 0
      usage.cost_usd += cost || usageCost(message.usage)
      return message
    } catch (error) {
      usage.cost_usd += cost
      gate.endCall("tool_use")
      const malformed = error instanceof SyntaxError || (error instanceof Error && / in JSON at position /.test(error.message))
      if (!malformed || tries >= 1) throw error
      // In place, so the turn's history keeps the note (append-only).
      const index = body.messages.length - 1
      const last = body.messages[index]
      const content = typeof last.content === "string" ? [{ type: "text" as const, text: last.content }] : [...last.content]
      body.messages[index] = { ...last, content: [...content, { type: "text", text: MALFORMED_TOOL_HINT }] } as Anthropic.MessageParam
    }
  }
}

// ---------------------------------------------------------------- case notes

function eventLine(n: Awaited<ReturnType<typeof names>>, event: EventRow): string {
  const who = actorName(n, event.actorType, event.actorId)
  const to = event.recipientType ? ` → ${actorName(n, event.recipientType, event.recipientId)}` : ""
  const tag = event.kind === "photo" ? ` [photo, event ${event.id}]` : event.channel === "safety" ? " [safety instruction]" : ""
  return `[${utcTime(event.at)}] ${who}${to} (${event.channel.replace(/_/g, " ")})${tag}: ${event.body}`
}

/** "2026-10-21 09:02 UTC (simulated clock); local: Wed 21 Oct 11:02 CEST at pickup, ..." so the agent never has to work out offsets. */
function nowLine(facts: OrderFacts): string {
  const now = simNow().toISOString()
  const zones = [...new Set([facts.pickup.timezone, facts.delivery.timezone].filter((zone): zone is string => Boolean(zone)))]
  const local = zones.map((zone) => `${localTime(now, zone)} (${zone})`).join(", ")
  return `${utcTime(now)} (simulated clock)${local ? `; local time: ${local}` : ""}`
}

async function caseNotes(request: TurnRequest, caseRow: CaseRow, facts: OrderFacts): Promise<string> {
  const n = await names()
  const events = (await listEvents({ caseId: caseRow.id })).slice(-60)
  const proposals = await listProposals({ caseId: caseRow.id })
  const pending = proposals.filter((row) => row.status === "PENDING")
  const decided = proposals.filter((row) => row.status !== "PENDING").slice(-5)
  const outdatedLine = (row: (typeof proposals)[number]) => {
    const checks = (row.executionResult?.outdated ?? []) as { assumption: { label: string }; now: string }[]
    return checks.length ? ` (what changed: ${checks.map((check) => `${check.assumption.label}, now ${check.now}`).join("; ")})` : ""
  }
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
    `Now: ${nowLine(facts)}`,
    `Order: ${facts.reference} · ${vehicle} · ${route}`,
    `Case: ${caseRow.title} · ${caseRow.kind.toLowerCase().replace(/_/g, " ")} · ${caseRow.status.toLowerCase().replace(/_/g, " ")} · urgency ${caseRow.urgency.toLowerCase()} · opened ${relative(caseRow.openedAt)}`,
    `You are talking to: ${counterpart.name ?? counterpart.type} (${counterpart.type}) via ${request.replyChannel.replace(/_/g, " ")}${siteNote}`,
    caseRow.waitingOn ? `Waiting on: ${caseRow.waitingOn}${caseRow.waitingSince ? ` since ${utcTime(caseRow.waitingSince)}` : ""}${caseRow.nextCheckAt ? `, next check ${utcTime(caseRow.nextCheckAt)}` : ""}${caseRow.followUps ? `, reminders sent: ${caseRow.followUps}` : ""}` : "",
    caseRow.nextAction ? `Next action on record: ${caseRow.nextAction}` : "",
    pending.length ? `Decisions waiting for an operator:\n${pending.map((row) => `- ${row.title} (${row.actionType})`).join("\n")}` : "Decisions waiting for an operator: none",
    decided.length ? `Earlier decisions:\n${decided.map((row) => `- ${row.title} (revision ${row.revision}): ${row.status.toLowerCase().replace(/_/g, " ")}${row.decisionNote ? ` (${row.decisionNote})` : ""}${row.status === "OUTDATED" ? outdatedLine(row) : ""}`).join("\n")}` : "",
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
  if (request.effort) return request.effort
  // An operator waiting at the Ask box is a person waiting too: a read-only answer runs at the fast effort.
  return request.trigger === "inbound" || request.trigger === "telemetry" || request.trigger === "ask" ? fastEffort() : deepEffort()
}

async function deliver(request: TurnRequest, caseRow: CaseRow, facts: OrderFacts, reply: string, extra: Record<string, unknown> = {}): Promise<{ eventId: string | null; held: boolean }> {
  const text = reply.trim()
  if (!text || text === "NO_MESSAGE") return { eventId: null, held: false }
  if (request.audience === "site") {
    const endpoint = request.siteEnd === "delivery" ? facts.delivery : facts.pickup
    if (endpoint.customerSide) {
      // The customer rule covers replies too: draft it, a person approves it. A preamble the model wrote for the
      // operator ("here is the draft…", then a rule) is not part of the message.
      const name = String(endpoint.site?.name ?? endpoint.address.name ?? "the site")
      const body = text.replace(/^[^\n]*(?:draft|held for|approval)[^\n]*:?\s*\n+(?:-{3,}\s*\n+)?/i, "").replace(/\n+-{3,}[\s\S]*$/, "").trim() || text
      await submitProposal({ audience: "operator", caseRow, facts }, {
        action_type: "CONTACT_SITE_AS_CUSTOMER",
        title: `Reply to ${name}`,
        rationale: `${name} belongs to the customer, so the agent drafted the reply and a person approves it before it is sent.`,
        handover: { what_happened: `${request.counterpart.name ?? name} wrote in about ${facts.reference}.`, facts: [], agent_did: ["Drafted a reply from the order records."], unknowns: [], recommendation: "Send the drafted reply.", alternatives: ["Edit it first", "Reply yourself"] },
        changes: [],
        draft_message: { to: endpoint.end === "pickup" ? "pickup_site" : "delivery_site", channel: "app_chat", subject: "", body, language: "" },
        options: [],
        evidence_refs: [],
        assumptions: [],
        proposed_window: null,
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
      channel: request.replyChannel, recipientType: "driver", recipientId: request.counterpart.id, body: text,
      data: { ...extra, ...(request.trigger === "telemetry" ? { call: true } : {}) },
    })
    return { eventId: event.id, held: false }
  }
  const event = await appendEvent({
    caseId: caseRow.id, orderId: caseRow.orderId, actorType: "agent", actorId: AGENT_ID, kind: request.trigger === "ask" ? "message" : "note",
    channel: request.replyChannel, recipientType: "operator", recipientId: request.counterpart.id, body: text, data: extra,
  })
  return { eventId: event.id, held: false }
}

/**
 * Where the case stands after a turn that did not decide it: wait for the
 * driver's (or site's) answer with a deadline, or, if the agent left nothing
 * to wait on, put it in front of a person. Never left in AGENT_WORKING.
 */
async function settleCase(request: TurnRequest, state: TurnState, spokeToDriver: boolean, reply = "") {
  const row = await getCase(state.caseRow.id)
  if (!row || state.closed || state.waitSet || row.status !== "AGENT_WORKING" || state.followUps.length > 0 || request.trigger === "ask") return
  // A site's question answered from the records, with nothing asked back, is done: waiting for "the site's reply"
  // would bring an operator a case with nothing in it half an hour later.
  if (request.audience === "site" && reply.trim() && !reply.includes("?") && !SERIOUS.has(row.kind)
    && !(request.siteEnd === "delivery" ? state.facts.delivery : state.facts.pickup).customerSide) {
    await updateCase(row.id, { status: "HANDLED_BY_AGENT", owner: "agent", nextAction: null, waitingFor: null, waitingOn: null, nextCheckAt: null })
    await appendEvent({
      caseId: row.id, orderId: row.orderId, actorType: "agent", actorId: AGENT_ID, kind: "note", channel: "internal",
      body: `Handled by the agent: answered ${request.counterpart.name ?? "the site"} from the order records; nothing was asked back.`,
    })
    return
  }
  if (request.audience === "driver" || spokeToDriver) {
    await updateCase(row.id, {
      status: "WAITING_EXTERNAL", owner: "agent", waitingFor: "driver", waitingOn: "the driver's reply",
      nextAction: "If the driver does not answer in time, the agent sends one reminder, then hands the case to a person.",
      nextCheckAt: new Date(simNow().getTime() + replyDeadlineMinutes(row) * 60000),
    })
  } else if (request.audience === "site") {
    await updateCase(row.id, {
      status: "WAITING_EXTERNAL", owner: "agent", waitingFor: "site", waitingOn: "the site's reply",
      nextAction: "If the site does not answer, the case goes to a person.", nextCheckAt: new Date(simNow().getTime() + 30 * 60000),
    })
  } else if ((await listProposals({ caseId: row.id, statuses: ["PENDING"] })).length) {
    await updateCase(row.id, { status: "NEEDS_DECISION", owner: null, waitingFor: "operator", waitingOn: "an operator's decision", nextAction: "An operator decides on the card waiting on this case." })
  } else {
    await updateCase(row.id, {
      status: "NEEDS_DECISION", owner: null, waitingFor: "operator", waitingOn: "an operator",
      nextAction: "The agent finished without a next step. Read the case and decide, or tell the agent what to do.",
    })
  }
}

const SERIOUS = new Set(["VEHICLE_WARNING", "BREAKDOWN", "ACCIDENT", "DELAY", "MISSED_CONNECTION"])

/** Run one turn. Callers hold the case lock (see `withCaseLock`). */
export async function runTurn(request: TurnRequest): Promise<TurnResult> {
  const caseRow = await getCase(request.caseId)
  if (!caseRow) throw new Error("Case not found")
  const facts = await loadOrderFacts(caseRow.orderId)
  if (!facts) throw new Error("Order not found")
  const toPerson = request.audience !== "operator"
  const holdsReply = request.audience === "site" && (request.siteEnd === "delivery" ? facts.delivery : facts.pickup).customerSide
  const asking = request.trigger === "ask"
  const screen = request.audience === "driver" ? async (text: string) => screenDriverMessage(text, { driverSaid: request.input, safety: await loadDriverSafetyContext(facts, caseRow) }) : null

  const client = llm()
  if (!client) {
    // Stub mode: no model key. A fixed acknowledgement, and a person takes the case.
    if (asking) return { runId: null, reply: "The agent is offline right now (no model key is configured).", replyEventId: null, heldForApproval: false, followUps: [], error: "offline" }
    await agentCouldNotFinish(caseRow.id, "the agent is offline (no model key configured)")
    if (!toPerson || holdsReply) return { runId: null, reply: "", replyEventId: null, heldForApproval: false, followUps: [], error: "offline" }
    const reply = offlineReply(request)
    request.onText?.(reply)
    const delivered = await deliver(request, caseRow, facts, reply, { canned: true })
    return { runId: null, reply, replyEventId: delivered.eventId, heldForApproval: false, followUps: [], error: "offline" }
  }

  const model = agentModel()
  const effort = effortFor(request)
  const turnStartedAt = simNow()
  const notes = await caseNotes(request, caseRow, facts)
  const run = await startRun({ caseId: caseRow.id, orderId: caseRow.orderId, audience: request.audience, model, effort, input: request.input })
  await updateCase(caseRow.id, { lastRunStatus: "RUNNING", lastRunAt: simNow() })
  const state: TurnState = {
    audience: request.audience, caseRow, facts, readOnly: asking, turnStartedAt,
    runId: run.id,
    driverId: caseRow.driverId,
    driverName: caseRow.driverId ? facts.driverNames.get(caseRow.driverId) ?? null : null,
    siteEnd: request.siteEnd ?? null,
    followUps: [],
    traces: [] as ToolCallTrace[],
    closed: false,
    costUsd: 0,
    sideEffects: false,
    waitSet: false,
    seenIds: new Set(idsIn(notes)),
  }
  const tools = toolsFor(request.audience, asking)
  const system: Anthropic.TextBlockParam[] = [{ type: "text", text: systemPrompt(request.audience), cache_control: { type: "ephemeral" } }]
  const usage: Usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost_usd: 0, calls: 0, attempts: 0 }
  let messages: Anthropic.MessageParam[] = []
  let gate = new ReplyGate(screen, holdsReply ? undefined : request.onText)
  gate.deferFallback = request.audience === "driver"
  gate.forPerson = request.audience !== "operator"
  gate.personName = request.counterpart.name ?? null
  let stopReason: string | null = null
  let error: string | null = null

  // One retry, only when nothing reached anyone and nothing changed in the failed attempt.
  for (let attempt = 0; attempt < 2; attempt++) {
    usage.attempts = attempt + 1
    messages = [{ role: "user", content: notes }]
    let cutOff = false
    error = null
    try {
      for (let iteration = 0; ; iteration++) {
        if (iteration >= MAX_ITERATIONS) {
          error = `the agent reached its step limit of ${MAX_ITERATIONS} model calls`
          break
        }
        const message = await callModel(client, { model, max_tokens: MAX_TOKENS, system, tools, messages, output_config: { effort } }, gate, usage)
        gate.endCall(message.stop_reason)
        stopReason = message.stop_reason
        if (message.stop_reason === "refusal") {
          error = "the model declined to continue"
          break
        }
        if (message.stop_reason === "max_tokens" && !cutOff && !message.content.some((block) => block.type === "tool_use")) {
          // A reasoning model can spend the whole output budget thinking and stop before any tool call or reply; ending
          // the turn there leaves the case without a next step. Once per turn, ask again for the next step directly
          // (the cut-off answer is dropped: a half-written thinking block cannot be sent back).
          cutOff = true
          const last = messages.at(-1)!
          const nudge = "Your previous answer was cut off at the length limit before you acted. Keep your reasoning short and take the next step now with a tool call."
          last.content = typeof last.content === "string" ? `${last.content}\n\n${nudge}` : [...last.content, { type: "text", text: nudge }]
          continue
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
    }
    await gate.finish(Boolean(error))
    const nothingHappened = !state.sideEffects && !gate.text.trim()
    if (!error || attempt === 1 || !nothingHappened || error.includes("step limit")) break
    await appendEvent({
      caseId: caseRow.id, orderId: caseRow.orderId, actorType: "system", actorId: "road-desk", kind: "note", channel: "internal",
      body: `The agent hit a problem (${error}) before anything was sent or changed; trying once more.`,
    })
    gate = new ReplyGate(screen, holdsReply ? undefined : request.onText)
    gate.deferFallback = request.audience === "driver"
    gate.forPerson = request.audience !== "operator"
    gate.personName = request.counterpart.name ?? null
  }
  usage.cost_usd += gate.costUsd + state.costUsd

  if (gate.blocked && !error && request.audience === "driver") {
    // The driver asked something and the reply also read as permission to drive on. Ask once for the same reply
    // without that; only if it is held again does the driver get the fixed line and an operator a clearance card.
    const again = await rewriteHeldReply(client, { model, system, tools, messages, effort }, gate, screen!, request.onText, usage)
    await appendEvent({
      caseId: caseRow.id, orderId: caseRow.orderId, actorType: "system", actorId: "gate", kind: "tool_call", channel: "internal",
      body: again
        ? `Drivability screen held back a reply that read as permission to drive on (${gate.blocked.reason ?? "screen"}); the agent wrote it again without that, and the new reply was sent.`
        : `Drivability screen held back a reply that read as permission to drive on (${gate.blocked.reason ?? "screen"}); the rewrite was held too.`,
      data: { refused: true, rule: "drivability_screen", text: gate.written.trim(), rewritten: Boolean(again) },
    })
    if (again) gate = again
    else { gate.sendFallback(); await holdForClearance(state, gate.written.trim(), gate.blocked.reason) }
  } else if (gate.blocked && !error) {
    gate.sendFallback()
    await holdForClearance(state, gate.written.trim(), gate.blocked.reason)
  }

  let reply = gate.text
  if (error && toPerson && !reply.trim() && !holdsReply) {
    reply = offlineReply(request)
    request.onText?.(reply)
  }
  const delivered = await deliver(request, state.caseRow, facts, reply)
  const spokeToDriver = request.audience === "driver" || state.traces.some((trace) => ["message_driver", "request_photo", "safety_instruction"].includes(trace.name) && !trace.is_error)

  if (error && !asking) await agentCouldNotFinish(caseRow.id, error)
  else await settleCase(request, state, spokeToDriver, reply)
  await updateCase(caseRow.id, { lastRunStatus: error ? "ERROR" : "DONE", lastRunAt: simNow() })
  await ensureOpenCaseFields(caseRow.id)

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
