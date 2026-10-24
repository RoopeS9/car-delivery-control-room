// Case hygiene (PLAN.md 4.2, failure handling): every open case always says
// what happens next, who or what it waits on, and when we look again; and
// when the agent cannot finish, a person gets a clear card instead of a
// silent case.

import { simNow } from "@/lib/cr/clock"
import { appendEvent, createProposal, getCase, listProposals, listRuns, updateCase, type CaseRow } from "@/lib/cr/queries"
import { OPEN_CASE_STATUSES, type SourceRef } from "@/lib/cr/types"
import { AGENT_ID } from "./config"

const MINUTE = 60000

export function isUrgent(caseRow: Pick<CaseRow, "urgency">): boolean {
  return caseRow.urgency === "CRITICAL" || caseRow.urgency === "HIGH"
}

/** How long we give a driver to answer a question (PLAN.md 4.2): 5 sim minutes when urgent, 30 otherwise. */
export function replyDeadlineMinutes(caseRow: Pick<CaseRow, "urgency">): number {
  return isUrgent(caseRow) ? 5 : 30
}

const later = (minutes: number) => new Date(simNow().getTime() + minutes * MINUTE)

/** Fill whatever an open case is missing: next action, what it waits on, when we check again. */
export async function ensureOpenCaseFields(caseId: string): Promise<CaseRow | null> {
  const row = await getCase(caseId)
  if (!row || !OPEN_CASE_STATUSES.includes(row.status)) return row
  const patch: Parameters<typeof updateCase>[1] = {}
  if (row.status === "NEEDS_DECISION") {
    if (!row.waitingOn) Object.assign(patch, { waitingOn: "an operator's decision", waitingFor: "operator" })
    if (!row.nextAction) patch.nextAction = "An operator decides on the card."
    if (!row.nextCheckAt) patch.nextCheckAt = later(isUrgent(row) ? 5 : 15)
  } else if (row.status === "AGENT_WORKING") {
    if (!row.waitingOn) Object.assign(patch, { waitingOn: "the agent", waitingFor: "agent" })
    if (!row.nextAction) patch.nextAction = "The agent is working on it."
    if (!row.nextCheckAt) patch.nextCheckAt = later(3)
  } else {
    if (!row.waitingOn) Object.assign(patch, { waitingOn: "an answer", waitingFor: "operator" })
    if (!row.nextAction) patch.nextAction = "Check whether the answer came."
    if (!row.nextCheckAt) patch.nextCheckAt = later(30)
  }
  return Object.keys(patch).length ? updateCase(caseId, patch) : row
}

/**
 * The agent stopped (error, timeout, refusal, step limit, watchdog). Move the
 * case to "Needs your decision" with what it found, what is missing, and a
 * suggested next step, as a card the operator can act on.
 */
export async function agentCouldNotFinish(caseId: string, reason: string): Promise<void> {
  const caseRow = await getCase(caseId)
  if (!caseRow) return
  const pending = await listProposals({ caseId, statuses: ["PENDING"] })
  await appendEvent({
    caseId, orderId: caseRow.orderId, actorType: "system", actorId: "road-desk", kind: "note", channel: "internal",
    body: `The agent couldn't finish: ${reason}`,
  })
  if (pending.some((proposal) => proposal.actionType === "OPERATOR_DECISION" && proposal.title.startsWith("The agent couldn't finish"))) {
    await updateCase(caseId, { status: "NEEDS_DECISION", owner: null, waitingOn: "an operator's decision", waitingFor: "operator", nextCheckAt: later(isUrgent(caseRow) ? 5 : 15) })
    return
  }
  const [lastRun] = await listRuns({ caseId, limit: 1 })
  const found = (lastRun?.toolCalls ?? []).filter((call) => !call.is_error).map((call) => call.name.replace(/_/g, " "))
  await createProposal({
    caseId, orderId: caseRow.orderId, actionType: "OPERATOR_DECISION",
    title: "The agent couldn't finish: decide the next step",
    rationale: `The agent stopped on "${caseRow.title}": ${reason}.`,
    handover: {
      what_happened: `The agent stopped on this case: ${reason}.`,
      facts: caseRow.summary ? [{ text: caseRow.summary, sources: [] }] : [],
      agent_did: found.length ? [`Last run used: ${[...new Set(found)].join(", ")}.`] : ["Nothing recorded in its last run."],
      unknowns: ["Whatever the agent was still working out. Read the timeline."],
      recommendation: caseRow.nextAction ? `Suggested next step: ${caseRow.nextAction}` : "Read the timeline, then let the agent try again or take it over.",
      alternatives: ["Take it over yourself", "Tell the agent what to do"],
    },
    options: [
      { id: "retry", label: "Let the agent try again", description: "It starts from the current facts.", recommended: true },
      { id: "take_over", label: "I'll take it from here", description: "The agent stays out of this case until you instruct it.", recommended: false },
    ],
    nextStepIfApproved: "The agent picks the case up again from the current facts.",
    nextStepIfRejected: "The case stays with you.",
    createdBy: AGENT_ID,
  })
  await updateCase(caseId, {
    status: "NEEDS_DECISION", owner: null, waitingOn: "an operator's decision", waitingFor: "operator",
    nextAction: "The agent couldn't finish: decide whether it tries again or you take over.", nextCheckAt: later(isUrgent(caseRow) ? 5 : 15),
  })
}

/**
 * A driver who has not answered, even after a reminder (scenario F). If the
 * agent could not write the escalation card itself, this one goes to a person:
 * what we know with its sources, what is missing, and one next action.
 */
export async function driverSilentCard(caseId: string, driverName: string | null, since: Date, facts: { text: string; sources: SourceRef[] }[]): Promise<void> {
  const caseRow = await getCase(caseId)
  if (!caseRow) return
  if ((await listProposals({ caseId, statuses: ["PENDING"] })).length) return
  const name = driverName ?? "the driver"
  await createProposal({
    caseId, orderId: caseRow.orderId, actionType: "OPERATOR_DECISION",
    title: `${name} is not answering: call them on their phone`,
    rationale: `No reply since ${since.toISOString().slice(11, 16)} UTC, also not after one reminder.`,
    handover: {
      what_happened: `${name} has not answered since ${since.toISOString().slice(11, 16)} UTC, also not after a reminder.`,
      facts,
      agent_did: ["Asked the driver.", "Sent one reminder."],
      unknowns: ["Whether the driver is safe", "Where the car actually is", "Whether the car is still moving"],
      recommendation: `Call ${name} on their phone.`,
      alternatives: ["Ask the pickup or delivery place whether they have heard from the driver"],
    },
    options: [],
    nextStepIfApproved: "You call the driver and log what happened.",
    nextStepIfRejected: "The case stays open with you.",
    createdBy: AGENT_ID,
  })
  await updateCase(caseId, {
    status: "NEEDS_DECISION", owner: null, waitingOn: "an operator's decision", waitingFor: "operator",
    nextAction: `Call ${name} on their phone, then log what happened.`, nextCheckAt: later(5),
  })
}
