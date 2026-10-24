// The call: start (urgency-first opening), each driver turn (interviewer
// reply streamed sentence by sentence, screened, spoken), silence handling,
// and the end. The HTTP routes and the text harness both use these functions.

import { randomBytes } from "node:crypto"
import type Anthropic from "@anthropic-ai/sdk"
import { clipMime, storeClip } from "./clips"
import { simNow } from "./clock"
import { TTS_DOLLARS_PER_CHAR, voiceConfig } from "./config"
import { loadCallContext, type CallContext } from "./context"
import { MAX_QUESTIONS, checklistFor, slotLabel } from "./interview/checklists"
import { runInterviewer } from "./interview/engine"
import {
  EMERGENCY_SAFETY, FILLERS, NO_RESPONSE_LINES, READBACK_ACK, REPROMPT_PREFIX, SCREEN_REPLACEMENT, SCREEN_REPLACEMENT_OTHER, goodbyeLine, nextCheckMinutes, nextStepLines, openingLine,
} from "./interview/phrases"
import { INTERVIEWER_SYSTEM, contextBlock, stepNote, type RecordInput, type Step } from "./interview/prompt"
import { SAFETY_TEMPLATES, expandSafetyTags, freeSafetyTemplate, type SafetyId } from "./interview/safety"
import { audioFormatFromMime, voiceProvider } from "./provider"
import { isMetaTalk, screenDriverUtterance } from "./screen"
import { getCall, insertCall, insertTurn, listTurns, updateCall, updateTurn, type CallRow, type TurnRow } from "./store"
import { fireTrigger } from "./triggers"
import { prepareSpeech, speak, speechAudio, speechUrl } from "./tts-cache"
import {
  SITUATIONS, URGENCY_RANK, type CallDirection, type CallPhase, type CallSlots, type CallState, type CallView, type ScreenFlag,
  type Situation, type StartCallRequest, type StartCallResponse, type TurnEvent, type TurnFlags, type Urgency,
} from "./types"

export type CallOptions = {
  /** Render speech on the server (false in the text harness). */
  speak?: boolean
  /** Interviewer model override (the harness uses Haiku). */
  model?: string
  /** Origin for the agent trigger POST; null records the trigger only. */
  origin?: string | null
}

export class CallError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = "CallError"
  }
}

const id = (prefix: string) => `${prefix}-${randomBytes(5).toString("hex")}`

// One turn at a time per call (the screen is half-duplex anyway).
const locks = ((globalThis as unknown as { __voiceLocks?: Map<string, Promise<unknown>> }).__voiceLocks ??= new Map())
async function withCallLock<T>(callId: string, run: () => Promise<T>): Promise<T> {
  const previous = locks.get(callId) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(run)
  locks.set(callId, next)
  try { return await next } finally { if (locks.get(callId) === next) locks.delete(callId) }
}

function contextFromCall(call: CallRow): CallContext {
  const firstName = call.state.driverName?.split(" ")[0] ?? null
  return {
    orderId: call.orderId, orderRef: call.state.orderRef, driverId: call.driverId, driverName: call.state.driverName, firstName,
    vehicleLabel: null, facts: call.state.context, telemetryFault: Boolean(call.state.telemetryHint?.codes?.length || call.state.telemetryHint?.milFlashing),
  }
}

/** Screen fixed lines too: every utterance is checked before it is spoken (results are cached per text). */
async function screenFixed(lines: { text: string; safetyId?: SafetyId }[], flags: TurnFlags, spend: { llm: number }): Promise<{ text: string; safetyId?: SafetyId }[]> {
  const results = await Promise.all(lines.map((line) => (line.safetyId ? null : screenDriverUtterance(line.text))))
  return lines.map((line, index) => {
    const result = results[index]
    if (!result) return line
    spend.llm += result.cost
    if (result.allowed) return line
    ;(flags.screened ??= []).push({ text: line.text, reason: result.reason, category: result.category ?? "", by: result.by === "cache" ? "pattern" : result.by, replacedWith: SCREEN_REPLACEMENT })
    return { text: SCREEN_REPLACEMENT }
  })
}

// ------------------------------------------------------------------ start

export async function startCall(request: StartCallRequest, options: CallOptions = {}): Promise<StartCallResponse> {
  const direction: CallDirection = request.direction === "DRIVER_INITIATED" ? "DRIVER_INITIATED" : "AGENT_INITIATED"
  if (!request.orderRef || !request.driverId) throw new CallError(400, "orderRef and driverId are required.")
  const context = await loadCallContext({ orderRef: request.orderRef, driverId: request.driverId, telemetryHint: request.telemetryHint })
  const callId = id("call")
  const now = simNow()
  const state: CallState = {
    orderRef: context.orderRef, driverName: context.driverName, phase: "urgency", questions: 0, readbacks: 0, readbackTurnId: null,
    urgencyQuote: null, urgencyAt: null, context: context.facts, telemetryHint: request.telemetryHint ?? null, silences: 0,
    triggers: [], spend: { llm: 0, stt: 0, tts: 0 }, liveStt: voiceConfig.liveStt(),
  }
  const flags: TurnFlags = { phase: "urgency" }
  const [opening] = await screenFixed([{ text: openingLine({ direction, ...context }) }], flags, state.spend)
  await insertCall({ id: callId, orderId: context.orderId, driverId: context.driverId, direction, startedAt: now, slots: {}, state })
  const turnId = `${callId}-0`
  await insertTurn({ id: turnId, callId, seq: 0, speaker: "agent", startedAt: now, endedAt: now, textLive: opening.text, textFinal: opening.text, flags })
  const doSpeak = options.speak !== false
  let audioUrl: string | null = null
  if (doSpeak) {
    const rendered = await speak(opening.text)
    audioUrl = rendered.audio ? speechUrl(rendered.id) : null
    if (rendered.audio) {
      void storeClip(`voice/calls/${callId}/0-agent.mp3`, rendered.audio, "audio/mpeg").then((key) => updateTurn(turnId, { audioKey: key }))
    }
  }
  const fillers = FILLERS.map((text) => {
    const prepared = doSpeak ? prepareSpeech(text) : null
    return { text, audioUrl: prepared?.spoken ? speechUrl(prepared.id) : null }
  })
  return { callId, opening: { text: opening.text, audioUrl }, fillers, driverName: context.driverName, liveStt: state.liveStt }
}

// ------------------------------------------------------------------ turn

export type DriverInput = {
  liveText: string
  audio?: { bytes: Buffer; mime: string } | null
  durationMs?: number | null
  /** The reply deadline passed with nothing said. */
  silence?: boolean
}

type Emit = (event: TurnEvent) => void

function historyMessages(turns: TurnRow[]): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: "(System) The call has connected." }]
  for (const turn of turns) {
    const text = turn.speaker === "agent"
      ? (turn.textFinal ?? turn.textLive ?? "")
      : turn.flags.silence ? `[turn ${turn.seq}] (driver silent)` : `[turn ${turn.seq}] Driver: "${turn.textFinal ?? turn.textLive ?? ""}"`
    const role = turn.speaker === "agent" ? "assistant" : "user"
    const last = messages[messages.length - 1]
    if (last.role === role) last.content = `${last.content as string}\n${text}`
    else messages.push({ role, content: text })
  }
  return messages
}

function stepFor(call: CallRow): Step {
  const { phase } = call.state
  if (phase === "urgency") return "urgency"
  if (phase === "readback") return call.state.readbacks >= 2 ? "closing" : "readback_answer"
  if (phase === "closing") return "closing"
  const urgency = call.urgency as Urgency | null
  const missing = checklistFor(urgency, call.situation as Situation | null).filter((key) => !call.slots[key])
  if (!missing.length || call.state.questions >= MAX_QUESTIONS[urgency ?? "URGENT"]) return "readback"
  return "checklist"
}

export async function driverTurn(callId: string, input: DriverInput, emit: Emit, options: CallOptions = {}): Promise<void> {
  return withCallLock(callId, () => runDriverTurn(callId, input, emit, options))
}

async function runDriverTurn(callId: string, input: DriverInput, emit: Emit, options: CallOptions): Promise<void> {
  const call = await getCall(callId)
  if (!call) throw new CallError(404, "No such call.")
  if (call.endedAt) throw new CallError(409, "This call has ended.")
  const turns = await listTurns(callId)
  const seq = (turns[turns.length - 1]?.seq ?? -1) + 1
  const endedAt = simNow()
  const startedAt = new Date(endedAt.getTime() - Math.max(0, input.durationMs ?? 0))
  const driverTurnId = `${callId}-${seq}`
  const doSpeak = options.speak !== false
  const state: CallState = { ...call.state, spend: { ...call.state.spend } }
  const turnStart = Date.now()
  let firstSentenceMs: number | null = null

  // Store the driver's audio and transcribe it (text of record), beside the live text.
  let liveText = (input.liveText ?? "").trim()
  await insertTurn({
    id: driverTurnId, callId, seq, speaker: "driver", startedAt, endedAt, textLive: liveText || null,
    textFinal: input.audio ? null : liveText || null, sttModel: input.audio ? null : liveText ? "live-only" : null, flags: input.silence ? { silence: true } : {},
  })
  const transcript = input.audio && !input.silence ? transcribeTurn(callId, driverTurnId, seq, input.audio, state) : null
  if (!liveText && transcript && !input.silence) liveText = (await transcript) ?? ""

  if (input.silence || !liveText) {
    if (!input.silence) await updateTurn(driverTurnId, { flags: { silence: true } })
    await handleSilence(call, turns, seq + 1, state, emit, options)
    await transcript
    return
  }
  state.silences = 0
  emit({ event: "driver", data: { turnId: driverTurnId, seq, text: liveText } })

  // The interviewer's reply, screened sentence by sentence before it is spoken.
  const step = stepFor(call)
  const flags: TurnFlags = { phase: step === "readback_answer" ? "readback" : (step as CallPhase), safetyTemplates: [], screened: [] }
  const spoken: string[] = []
  const speechIds: string[] = []
  let index = 0
  let replaced = false
  let chain: Promise<void> = Promise.resolve()
  // A safety template said in the last two agent turns is not repeated.
  const recentSafety = new Set(turns.filter((turn) => turn.speaker === "agent").slice(-2).flatMap((turn) => turn.flags.safetyTemplates ?? []))
  // After a read-back, hold the reply until we know whether the driver confirmed it.
  const held: { text: string; safetyId?: SafetyId }[] | null = step === "readback_answer" ? [] : null

  const say = (text: string, safetyId?: SafetyId, force = false) => {
    if (safetyId) {
      if (flags.safetyTemplates!.includes(safetyId) || (!force && recentSafety.has(safetyId))) return
      flags.safetyTemplates!.push(safetyId)
    }
    let audioUrl: string | null = null
    if (doSpeak) {
      const prepared = prepareSpeech(text)
      if (prepared.spoken) { audioUrl = speechUrl(prepared.id); speechIds.push(prepared.id) }
    }
    if (!safetyId && !SAFETY_ID_TEXTS.has(text)) state.spend.tts += doSpeak ? text.length * TTS_DOLLARS_PER_CHAR : 0
    spoken.push(text)
    firstSentenceMs ??= Date.now() - turnStart
    emit({ event: "sentence", data: { index: index++, text, audioUrl } })
  }

  const screenFree = async (text: string): Promise<{ text: string; safetyId?: SafetyId } | null> => {
    if (isMetaTalk(text)) {
      flags.screened!.push({ text, reason: "the model described its own reasoning; not spoken", category: "META", by: "pattern", replacedWith: null })
      return null
    }
    const template = freeSafetyTemplate(text)
    if (template) {
      flags.screened!.push({ text, reason: "safety instruction in free wording; spoken as its template", category: "SAFETY_TEMPLATE", by: "pattern", replacedWith: SAFETY_TEMPLATES[template] })
      return { text: SAFETY_TEMPLATES[template], safetyId: template }
    }
    if (doSpeak) prepareSpeech(text) // speculative: render while the screen runs
    const result = await screenDriverUtterance(text)
    state.spend.llm += result.cost
    if (result.allowed) return { text }
    const replacement = result.category === "DRIVABILITY" ? SCREEN_REPLACEMENT : SCREEN_REPLACEMENT_OTHER
    const flag: ScreenFlag = { text, reason: result.reason, category: result.category ?? "", by: result.by === "cache" ? "pattern" : result.by, replacedWith: replaced ? null : replacement }
    flags.screened!.push(flag)
    if (replaced) return null
    replaced = true
    return { text: replacement }
  }

  const onSentence = (raw: string) => {
    const jobs = expandSafetyTags(raw).map((part) => (part.kind === "safety" ? Promise.resolve({ text: part.text, safetyId: part.id }) : screenFree(part.text)))
    chain = chain.then(async () => {
      for (const job of jobs) {
        const line = await job
        if (!line) continue
        if (held) held.push(line)
        else say(line.text, line.safetyId)
      }
    })
  }

  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: INTERVIEWER_SYSTEM, cache_control: { type: "ephemeral" } },
    { type: "text", text: contextBlock(contextFromCall(call)) },
  ]
  const messages = historyMessages([...turns, { ...turns[0], id: driverTurnId, seq, speaker: "driver", textLive: liveText, textFinal: liveText, flags: {} }])
  const note = stepNote({
    step, urgency: call.urgency as Urgency | null, urgencyQuote: state.urgencyQuote, situation: call.situation as Situation | null,
    slots: call.slots, questions: state.questions, context: contextFromCall(call),
  })
  const last = messages[messages.length - 1]
  last.content = `${last.content as string}\n\n(System note, not said by the driver)\n${note}`

  // After a read-back, "Thanks, that's noted." fits both a yes and a correction, so say it at once.
  if (held) say(READBACK_ACK)
  const engineStart = Date.now()
  let engine
  let engineFailed = false
  try {
    engine = await runInterviewer({ system, messages, model: options.model, onSentence })
  } catch (error) {
    await chain
    engineFailed = true
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[voice] interviewer failed: ${message}`)
    flags.engineError = message.slice(0, 300)
    // Keep the call alive with a neutral line and stay on the same step; the turn is still on record.
    if (!spoken.length) say("Sorry, I didn't catch that. Could you say it again?")
    engine = { text: "", record: null, cost: 0, model: options.model ?? voiceConfig.interviewModel(), ms: 0, firstTextMs: null }
  }
  await chain
  state.spend.llm += engine.cost
  flags.rawText = engine.text
  flags.timing = {
    modelFirstText: engine.firstTextMs === null ? null : engineStart - turnStart + engine.firstTextMs,
    firstSentence: firstSentenceMs, total: Date.now() - turnStart, model: engine.model,
  }
  // Confirmed: nothing more, the system closes. Corrected: the corrected read-back.
  if (held && engine.record?.readback_answer === "CORRECTED" && engine.record.did_readback) {
    for (const line of held) say(line.text, line.safetyId)
  }
  if (!spoken.length && step !== "closing") say("Sorry, could you tell me a little more about what's happening?")

  // Apply what the interviewer recorded.
  const turnIdFor = (turnNumber: number) => {
    const match = [...turns, { seq, speaker: "driver", id: driverTurnId }].find((turn) => turn.seq === turnNumber && turn.speaker === "driver")
    return match?.id ?? driverTurnId
  }
  const patch: Partial<CallRow> = {}
  const slots: CallSlots = { ...call.slots }
  let urgency = call.urgency as Urgency | null
  let situation = call.situation as Situation | null
  const record: RecordInput | null = engine.record
  const before = urgency
  if (record) {
    if (record.urgency !== "UNKNOWN" && (!urgency || URGENCY_RANK[record.urgency] > URGENCY_RANK[urgency])) {
      urgency = record.urgency
      patch.urgency = urgency
      patch.urgencyTurnId = turnIdFor(record.urgency_turn)
      state.urgencyQuote = record.urgency_quote || liveText
      state.urgencyAt = simNow().toISOString()
    }
    if (record.situation !== "UNKNOWN" && (SITUATIONS as readonly string[]).includes(record.situation)) situation = record.situation
    for (const slot of record.slots ?? []) {
      if (!slot.value?.trim()) continue
      slots[slot.key] = { value: slot.value.trim(), turn_id: turnIdFor(slot.turn), quote: slot.quote, confidence: Math.max(0, Math.min(1, Number(slot.confidence) || 0)) }
    }
  }
  if (!urgency && step === "urgency" && turns.filter((turn) => turn.speaker === "driver").length >= 1) {
    // Two answers without a clear urgency: treat as urgent so a person looks.
    urgency = "URGENT"
    patch.urgency = urgency
    patch.urgencyTurnId = driverTurnId
    state.urgencyQuote = "(not stated; treated as urgent)"
    state.urgencyAt = simNow().toISOString()
  }
  if (urgency === "EMERGENCY" && before !== "EMERGENCY" && !flags.safetyTemplates!.includes("CALL_112")) {
    for (const safetyId of EMERGENCY_SAFETY) say(SAFETY_TEMPLATES[safetyId], safetyId, true)
  }

  // Move the interview on.
  const reply = spoken.join(" ")
  const asked = reply.trim().endsWith("?")
  // A read-back the model forgot to flag still counts: a recap of several facts ending "Is that right?".
  const didReadback = Boolean(record?.did_readback) || (/\bis that (right|correct)\?$/i.test(reply.trim()) && reply.split(",").length >= 3)
  let phase: CallPhase = state.phase
  if (engineFailed) {
    // Nothing was decided this turn: ask again on the same step.
  } else if (step === "urgency") {
    if (urgency) phase = didReadback ? "readback" : "checklist"
    if (asked && phase === "checklist") state.questions += 1
  } else if (step === "checklist") {
    if (didReadback) phase = "readback"
    else if (asked) state.questions += 1
  } else if (step === "readback") {
    phase = "readback"
  } else if (step === "readback_answer") {
    if (record?.readback_answer === "CONFIRMED") { patch.readbackConfirmed = true; phase = "closing" }
    else if (record?.readback_answer === "CORRECTED" && didReadback) phase = "readback"
    else phase = "closing"
  } else {
    phase = "closing"
  }
  if (phase === "readback" && (step !== "readback_answer" || didReadback)) {
    state.readbacks += 1
    state.readbackTurnId = `${callId}-${seq + 1}`
    flags.phase = "readback"
  }
  let ended = false
  if (phase === "closing") {
    const closing = await screenFixed([...nextStepLines(urgency, situation), { text: goodbyeLine(urgency) }], flags, state.spend)
    for (const line of closing) say(line.text, line.safetyId)
    const minutes = nextCheckMinutes(urgency)
    if (minutes) patch.nextCheckAt = new Date(simNow().getTime() + minutes * 60_000)
    phase = "ended"
    flags.phase = "closing"
    ended = true
  }
  state.phase = phase

  const agentTurnId = `${callId}-${seq + 1}`
  const text = spoken.join(" ")
  const at = simNow()
  await insertTurn({ id: agentTurnId, callId, seq: seq + 1, speaker: "agent", startedAt: at, endedAt: at, textLive: text, textFinal: text, flags })

  if (urgency && urgency !== "ROUTINE" && before !== urgency && (!before || before === "ROUTINE")) {
    state.triggers.push(await fireTrigger({ trigger: "call_urgent", callId, orderRef: state.orderRef, urgency, origin: options.origin ?? null }))
  }
  await updateCall(callId, { ...patch, slots, situation, state })
  emit({ event: "state", data: { urgency, urgencyQuote: state.urgencyQuote, situation, phase } })
  if (ended) await endCall(callId, "completed", options)
  emit({ event: "done", data: { agentTurnId, phase, ended } })

  await transcript
  if (doSpeak && speechIds.length) await storeAgentClip(callId, agentTurnId, seq + 1, speechIds)
}

const SAFETY_ID_TEXTS = new Set<string>(Object.values(SAFETY_TEMPLATES))

async function transcribeTurn(callId: string, turnId: string, seq: number, audio: { bytes: Buffer; mime: string }, state: CallState): Promise<string | null> {
  const format = audioFormatFromMime(audio.mime)
  try {
    const key = await storeClip(`voice/calls/${callId}/${seq}-driver.${format}`, audio.bytes, clipMime(`x.${format}`))
    await updateTurn(turnId, { audioKey: key })
    const result = await voiceProvider().transcribe(audio.bytes, format)
    if (!result) return null
    state.spend.stt += result.cost
    await updateTurn(turnId, { textFinal: result.text, sttModel: result.model })
    return result.text
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[voice] transcription failed: ${message}`)
    await updateTurn(turnId, { flags: { sttError: message.slice(0, 200) } })
    return null
  }
}

async function storeAgentClip(callId: string, turnId: string, seq: number, ids: string[]): Promise<void> {
  const parts = await Promise.all(ids.map((speechId) => speechAudio(speechId)))
  if (parts.some((part) => !part)) return
  const key = await storeClip(`voice/calls/${callId}/${seq}-agent.mp3`, Buffer.concat(parts as Buffer[]), "audio/mpeg")
  await updateTurn(turnId, { audioKey: key })
}

/** Reply deadline passed: ask once more, then end politely with "no_response". */
async function handleSilence(call: CallRow, turns: TurnRow[], agentSeq: number, state: CallState, emit: Emit, options: CallOptions): Promise<void> {
  state.silences += 1
  const flags: TurnFlags = { phase: state.phase }
  const lastAgent = [...turns].reverse().find((turn) => turn.speaker === "agent")
  const lastQuestion = (lastAgent?.textFinal ?? "").match(/[^.!?]*\?/g)?.pop()?.trim()
  const final = state.silences >= 2
  const lines = final ? NO_RESPONSE_LINES.map((text) => ({ text })) : [{ text: REPROMPT_PREFIX }, { text: lastQuestion || "Are you still there?" }]
  const screened = await screenFixed(lines, flags, state.spend)
  const agentTurnId = `${call.id}-${agentSeq}`
  const at = simNow()
  const text = screened.map((line) => line.text).join(" ")
  await insertTurn({ id: agentTurnId, callId: call.id, seq: agentSeq, speaker: "agent", startedAt: at, endedAt: at, textLive: text, textFinal: text, flags })
  const ids: string[] = []
  screened.forEach((line, index) => {
    let audioUrl: string | null = null
    if (options.speak !== false) {
      const prepared = prepareSpeech(line.text)
      if (prepared.spoken) { audioUrl = speechUrl(prepared.id); ids.push(prepared.id) }
    }
    emit({ event: "sentence", data: { index, text: line.text, audioUrl } })
  })
  if (final) state.phase = "ended"
  await updateCall(call.id, { state })
  emit({ event: "state", data: { urgency: call.urgency as Urgency | null, urgencyQuote: state.urgencyQuote, situation: call.situation, phase: state.phase } })
  if (final) await endCall(call.id, "no_response", options)
  emit({ event: "done", data: { agentTurnId, phase: state.phase, ended: final } })
  if (ids.length) await storeAgentClip(call.id, agentTurnId, agentSeq, ids)
}

// ------------------------------------------------------------------ end

export async function endCall(callId: string, reason: string, options: CallOptions = {}): Promise<{ transcriptUrl: string; alreadyEnded: boolean }> {
  const call = await getCall(callId)
  if (!call) throw new CallError(404, "No such call.")
  const transcriptUrl = `/api/voice/calls/${callId}`
  if (call.endedAt) return { transcriptUrl, alreadyEnded: true }
  const state: CallState = { ...call.state, phase: "ended" }
  const trigger = await fireTrigger({ trigger: "call_ended", callId, orderRef: state.orderRef, urgency: call.urgency as Urgency | null, origin: options.origin ?? null })
  state.triggers = [...state.triggers, trigger]
  await updateCall(callId, { endedAt: simNow(), endReason: (reason || "hang_up").slice(0, 40), state })
  return { transcriptUrl, alreadyEnded: false }
}

// ------------------------------------------------------------------ view

export async function getCallView(callId: string): Promise<CallView | null> {
  const call = await getCall(callId)
  if (!call) return null
  const turns = await listTurns(callId)
  const urgency = call.urgency as Urgency | null
  const checklist = checklistFor(urgency, call.situation as Situation | null)
  const slotKeys = new Set([...Object.keys(call.slots), ...checklist])
  return {
    id: call.id, caseId: call.caseId, orderId: call.orderId, orderRef: call.state.orderRef, driverId: call.driverId, driverName: call.state.driverName,
    direction: call.direction as CallDirection, startedAt: call.startedAt.toISOString(), endedAt: call.endedAt?.toISOString() ?? null,
    urgency, urgencyTurnId: call.urgencyTurnId, urgencyQuote: call.state.urgencyQuote,
    situation: call.situation, slots: call.slots, slotLabels: Object.fromEntries([...slotKeys].map((key) => [key, slotLabel(key)])),
    missing: checklist.filter((key) => !call.slots[key]).map((key) => ({ key, label: slotLabel(key) })),
    readbackConfirmed: call.readbackConfirmed, endReason: call.endReason, recordingKey: call.recordingKey, nextCheckAt: call.nextCheckAt?.toISOString() ?? null,
    phase: call.state.phase, context: call.state.context, triggers: call.state.triggers, spend: call.state.spend,
    turns: turns.map((turn) => ({
      id: turn.id, seq: turn.seq, speaker: turn.speaker as "agent" | "driver", startedAt: turn.startedAt.toISOString(), endedAt: turn.endedAt?.toISOString() ?? null,
      textLive: turn.textLive, textFinal: turn.textFinal, sttModel: turn.sttModel,
      audioUrl: turn.audioKey ? `/api/voice/calls/${callId}/audio/${turn.id}` : null, interrupted: turn.interrupted, flags: turn.flags,
    })),
  }
}
