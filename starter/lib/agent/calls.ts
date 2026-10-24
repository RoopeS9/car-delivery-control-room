// Voice interview -> road analyst. The call tables are the transcript of
// record; a trigger only identifies that record, it cannot supply facts.
// Acceptance is durable and fast. The route schedules analysis after sending
// its acknowledgement so the interviewer never waits for the tool loop.

import { eq } from "drizzle-orm"
import { simNow } from "@/lib/cr/clock"
import { crDb } from "@/lib/cr/db"
import { appendEvent, createCase, getCase, getEvent, listCases, listProposals, resolveOrder, transitionProposal, updateCase, type CaseRow } from "@/lib/cr/queries"
import { crEvents } from "@/lib/cr/schema"
import { OPEN_CASE_STATUSES, type CaseKind, type SourceRef, type Urgency } from "@/lib/cr/types"
import { crCalls, crCallTurns } from "@/lib/voice/schema"
import { linkedRecordsOf, loadOrderFacts } from "./context"
import { agentCouldNotFinish } from "./followup"
import { runTurn, withCaseLock, type TurnResult } from "./loop"
import { ChannelError, runFollowUps } from "./triggers"

type CallRow = typeof crCalls.$inferSelect
type TurnRow = typeof crCallTurns.$inferSelect
export type CallTriggerRequest = { trigger: "call_urgent" | "call_ended"; callId: string; orderRef: string; urgency?: string | null }
export type AcceptedCallTrigger = { caseId: string; eventId: string; callId: string; duplicate: boolean }

const URGENCY: Record<string, Urgency> = { EMERGENCY: "CRITICAL", URGENT: "HIGH", ROUTINE: "NORMAL" }
const RANK: Record<Urgency, number> = { LOW: 0, NORMAL: 1, HIGH: 2, CRITICAL: 3 }
const KINDS: Record<string, CaseKind> = { WARNING_LIGHT: "VEHICLE_WARNING", BREAKDOWN: "BREAKDOWN", ACCIDENT: "ACCIDENT", DELAY: "DELAY", KEYS_ACCESS: "KEYS_ACCESS", EXPENSE: "EXPENSE", OTHER_QUESTION: "DRIVER_QUESTION" }
const iso = (at: Date) => at.toISOString()

function turnText(turn: TurnRow): string {
  return turn.textFinal?.trim() || turn.textLive?.trim() || "(no intelligible speech recorded)"
}

export function turnSource(turn: TurnRow): SourceRef {
  const final = Boolean(turn.textFinal?.trim())
  return { kind: "cr_call_turns", id: turn.id, label: `${turn.speaker === "driver" ? "Driver" : "Interviewer"}, call turn ${turn.seq}${final ? "" : " (provisional live transcript)"}`, at: iso(turn.startedAt) }
}

/** The input quotes actual turns, and keeps extracted slots distinct from evidence. */
export function callAnalysisInput(call: CallRow, turns: TurnRow[], trigger: CallTriggerRequest["trigger"]): string {
  return [
    trigger === "call_urgent" && !call.endedAt
      ? "An urgent driver call is still in progress. Alert the operator now, then analyse the available facts. The interviewer is collecting the missing facts: do not send competing questions or duplicate its safety instructions during this call."
      : "The driver call has ended. Read its final transcript, update the case and prepare the next decision, or finish a routine question using the normal tools and gates.",
    `Call: ${call.id}; order ${call.state.orderRef}; driver ${call.state.driverName ?? "driver"}; urgency ${call.urgency ?? "not established"}; situation ${call.situation ?? "not established"}.`,
    `Interview ended: ${call.endedAt ? iso(call.endedAt) : "not yet"}; reason: ${call.endReason ?? "not recorded"}; read-back confirmed: ${call.readbackConfirmed ? "yes" : "no"}.`,
    `Urgency quote: ${call.state.urgencyQuote ?? "not recorded"}.`,
    call.nextCheckAt ? `The interviewer promised a next check by ${iso(call.nextCheckAt)}. Preserve that deadline unless an operator changes it.` : "",
    "Each source below is an attributed statement, not independently verified location, diagnosis or customer agreement. Prefer final transcript text. Provisional live text may be corrected; do not present extraction confidence as verification.",
    "# Transcript of record (speaker, spoken time, source)",
    ...turns.map((turn) => `${JSON.stringify(turnSource(turn))}\n${turn.speaker}: ${turnText(turn)}${turn.interrupted ? " [interrupted]" : ""}${turn.textLive && turn.textFinal && turn.textLive !== turn.textFinal ? ` [live transcription differed: ${turn.textLive}]` : ""}`),
    "# Interviewer's extracted claims (check against cited turns)",
    JSON.stringify(call.slots),
    "# Instructions",
    "Cite the relevant cr_call_turns IDs in proposal evidence_refs and handover facts. Use the order records and tools to check route, bookings, dates and customer authority. Do not assume the call changed a booking, cost or promise. An urgent partial-call proposal must be checked again against the finished call before execution. Refresh any pending recommendation whose assumptions changed. Keep every open case's next action, waiting party and next check explicit. Reply to operations, not into the ended voice call.",
  ].filter(Boolean).join("\n")
}

async function loadCall(callId: string): Promise<CallRow | null> {
  const [call] = await crDb().select().from(crCalls).where(eq(crCalls.id, callId)).limit(1)
  return call ?? null
}

async function turnsFor(callId: string): Promise<TurnRow[]> {
  const turns = await crDb().select().from(crCallTurns).where(eq(crCallTurns.callId, callId))
  return turns.sort((a, b) => a.seq - b.seq)
}

type DriverChange = { source: SourceRef; receivedAt: Date }

/** Even a card with no model-authored assumptions must be rechecked when
 * new driver evidence changes the transcript it could have relied on. */
async function invalidatePendingDecisions(caseId: string, changes: DriverChange[]): Promise<void> {
  if (!changes.length) return
  for (const proposal of await listProposals({ caseId, statuses: ["PENDING"] })) {
    const newer = changes.filter((change) => change.receivedAt > proposal.createdAt)
    if (!newer.length) continue
    const checks = newer.map(({ source }) => ({
      assumption: { kind: "no_new_message" as const, from: "driver" as const, after: proposal.createdAt.toISOString(), label: "The driver's call transcript has not changed since this card was drafted" },
      holds: false, now: `New or corrected evidence is available: ${source.label}.`,
    }))
    const updated = await transitionProposal(proposal.id, ["PENDING"], { status: "OUTDATED", executionResult: { outdated: checks }, nextStep: "Refresh this card using the updated call transcript before approving it." })
    if (!updated) continue
    await appendEvent({
      caseId, orderId: proposal.orderId, actorType: "system", actorId: "voice-analyst", kind: "note", channel: "internal",
      body: `Nothing was carried out: new or corrected driver-call evidence made "${proposal.title}" outdated. Refresh it before approving.`,
      data: { proposal_id: proposal.id, outdated: true, checks }, sourceRefs: newer.map(change => change.source),
    })
  }
}

async function storeTranscript(call: CallRow, caseId: string, turns: TurnRow[]): Promise<void> {
  const changes: DriverChange[] = []
  for (const turn of turns) {
    const id = `voice-turn-${turn.id}`
    const previous = await getEvent(id)
    const body = `${turnText(turn)}${turn.textFinal?.trim() ? "" : " (provisional live transcript)"}`
    // The event time is when this evidence reached the case. A later final
    // correction is a new fact for stale-approval checks; the source retains
    // the original spoken time.
    if (previous?.body === body) continue
    const value = {
      caseId, orderId: call.orderId, at: simNow(), actorType: turn.speaker === "driver" ? "driver" as const : "agent" as const,
      actorId: turn.speaker === "driver" ? call.driverId : "voice-interviewer", kind: "voice_turn" as const, channel: "driver_voice" as const,
      body, data: { call_id: call.id, turn_id: turn.id, seq: turn.seq, text_live: turn.textLive, text_final: turn.textFinal, stt_model: turn.sttModel, interrupted: turn.interrupted },
      sourceRefs: [turnSource(turn)],
    }
    await crDb().insert(crEvents).values({ id, ...value }).onConflictDoUpdate({ target: crEvents.id, set: value })
    if (turn.speaker === "driver") changes.push({ source: turnSource(turn), receivedAt: value.at })
  }
  await invalidatePendingDecisions(caseId, changes)
}

function driverRevision(turns: TurnRow[]): string {
  return JSON.stringify(turns.filter(turn => turn.speaker === "driver").map(turn => [turn.id, turn.textFinal, turn.textLive]))
}

export async function acceptCallTrigger(request: CallTriggerRequest): Promise<AcceptedCallTrigger> {
  if (!request || !["call_urgent", "call_ended"].includes(request.trigger) || typeof request.callId !== "string" || !request.callId.trim() || typeof request.orderRef !== "string" || !request.orderRef.trim()) {
    throw new ChannelError(400, "trigger, callId and orderRef are required.")
  }
  const initial = await loadCall(request.callId)
  if (!initial) throw new ChannelError(404, "No such driver call.")
  const order = await resolveOrder(request.orderRef)
  if (!order || order.id !== initial.orderId) throw new ChannelError(403, "This call does not belong to that order.")
  const facts = await loadOrderFacts(order.id)
  if (!facts || !facts.assignments.some((assignment) => assignment.driver_id === initial.driverId && ["ASSIGNED", "IN_PROGRESS"].includes(String(assignment.status)))) {
    throw new ChannelError(403, "The caller is not on an active assignment for this order.")
  }
  // Serialise initial linking too: two urgent requests must not create two
  // cases before either one obtains the per-case analysis lock.
  return withCaseLock(`voice-link:${order.id}:${initial.driverId}`, async () => {
    const call = (await loadCall(request.callId))!
    if (request.trigger === "call_urgent" && !["URGENT", "EMERGENCY"].includes(call.urgency ?? "")) throw new ChannelError(409, "The recorded call is not classified as urgent.")
    if (request.trigger === "call_ended" && !call.endedAt) throw new ChannelError(409, "The recorded call has not ended yet.")
    const eventId = `voice-trigger-${call.id}-${request.trigger}${request.trigger === "call_urgent" ? `-${call.urgency}` : ""}`
    const prior = await getEvent(eventId)
    if (prior?.caseId) return { caseId: prior.caseId, callId: call.id, eventId, duplicate: true }
    let caseRow: CaseRow | null = call.caseId ? await getCase(call.caseId) : null
    if (caseRow && (caseRow.orderId !== order.id || caseRow.driverId && caseRow.driverId !== call.driverId)) throw new ChannelError(409, "The call has an inconsistent case link.")
    if (!caseRow) caseRow = (await listCases({ orderId: order.id, statuses: [...OPEN_CASE_STATUSES] })).find((row) => row.driverId === call.driverId && row.kind !== "SITE_QUESTION") ?? null
    const urgency = URGENCY[call.urgency ?? ""] ?? "NORMAL"
    const summary = call.state.urgencyQuote || `Driver call about ${String(call.situation ?? "a question").toLowerCase().replace(/_/g, " ")}.`
    const fields = {
      kind: KINDS[call.situation ?? ""] ?? "DRIVER_QUESTION", urgency,
      summary, nextCheckAt: call.nextCheckAt ?? new Date(simNow().getTime() + (urgency === "CRITICAL" ? 1 : urgency === "HIGH" ? 5 : 15) * 60000),
      waitingFor: request.trigger === "call_urgent" ? "operator" as const : "agent" as const,
      waitingOn: request.trigger === "call_urgent" ? "an operator to review the urgent call" : "the agent to analyse the finished call",
      nextAction: request.trigger === "call_urgent" ? "An operator reviews the urgent call while the interviewer gathers the remaining facts." : "The agent checks the transcript and prepares the next decision.",
    }
    if (!caseRow) caseRow = await createCase({ ...fields, orderId: order.id, driverId: call.driverId, channelOpened: "driver_voice", title: `${call.urgency === "EMERGENCY" ? "Emergency" : call.urgency === "URGENT" ? "Urgent" : "Driver"} call from ${call.state.driverName ?? "the driver"}`, status: request.trigger === "call_urgent" ? "NEEDS_DECISION" : "AGENT_WORKING", owner: "agent", linkedRecords: linkedRecordsOf(facts) })
    else caseRow = (await updateCase(caseRow.id, {
      ...fields, kind: call.situation ? fields.kind : caseRow.kind, urgency: RANK[caseRow.urgency] > RANK[urgency] ? caseRow.urgency : urgency,
      status: request.trigger === "call_urgent" || caseRow.status === "NEEDS_DECISION" ? "NEEDS_DECISION" : "AGENT_WORKING",
      resolvedAt: null,
    }))!
    await crDb().update(crCalls).set({ caseId: caseRow.id }).where(eq(crCalls.id, call.id))
    const turns = await turnsFor(call.id)
    await storeTranscript(call, caseRow.id, turns)
    await crDb().insert(crEvents).values({
      id: eventId, caseId: caseRow.id, orderId: order.id, at: simNow(), actorType: "system", actorId: "voice-interviewer", kind: "note", channel: "internal",
      body: request.trigger === "call_urgent" ? `Urgent driver call: ${summary}` : `Driver call ended (${call.endReason ?? "reason not recorded"}); transcript sent to the road agent.`,
      data: { call_id: call.id, trigger: request.trigger, analysis_status: "QUEUED" },
      sourceRefs: turns.map(turnSource),
    }).onConflictDoNothing()
    return { caseId: caseRow.id, callId: call.id, eventId, duplicate: false }
  })
}

/** Runs only after acceptance. A repeated HTTP delivery cannot run it twice. */
export async function analyseCallTrigger(accepted: AcceptedCallTrigger): Promise<TurnResult | null> {
  const result = await withCaseLock(accepted.caseId, async () => {
    const event = await getEvent(accepted.eventId)
    if (!event || event.data.analysis_status !== "QUEUED") return null
    await crDb().update(crEvents).set({ data: { ...event.data, analysis_status: "RUNNING" } }).where(eq(crEvents.id, event.id))
    try {
      const call = await loadCall(accepted.callId)
      if (!call || call.caseId !== accepted.caseId) throw new Error("The call's case link changed before analysis.")
      const turns = await turnsFor(call.id)
      await storeTranscript(call, accepted.caseId, turns)
      const result = await runTurn({
        caseId: accepted.caseId, audience: "operator", trigger: "analysis",
        input: callAnalysisInput(call, turns, event.data.trigger as CallTriggerRequest["trigger"]),
        counterpart: { type: "operator", id: null, name: "Operations" }, replyChannel: "internal",
      })
      // A completed-call delivery can arrive while the urgent analyst is
      // running. It must also invalidate cards drafted after that ingestion
      // from the analyst's older snapshot, before the case lock is released.
      const latest = await turnsFor(call.id)
      if (driverRevision(latest) !== driverRevision(turns)) {
        await storeTranscript(call, accepted.caseId, latest)
        await invalidatePendingDecisions(accepted.caseId, latest.filter(turn => turn.speaker === "driver").map(turn => ({ source: turnSource(turn), receivedAt: simNow() })))
      }
      await crDb().update(crEvents).set({ data: { ...event.data, analysis_status: result.error ? "FAILED" : "COMPLETED", run_id: result.runId, error: result.error } }).where(eq(crEvents.id, event.id))
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await crDb().update(crEvents).set({ data: { ...event.data, analysis_status: "FAILED", error: message } }).where(eq(crEvents.id, event.id))
      await agentCouldNotFinish(accepted.caseId, "the road agent could not analyse the driver call")
      return null
    }
  })
  // Follow-ups acquire their own case locks. Await them after releasing ours.
  if (result?.followUps.length) await runFollowUps(result.followUps)
  return result
}
