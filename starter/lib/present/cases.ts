// Our cases, decision cards and the merged timeline, read out for the control
// room. Like the rest of lib/present this only reads: the cr_ rows are written
// by the agent (lib/agent) and the simulator (lib/sim). Every line keeps the
// source it came from, so a quote never reads as a booking and a driver message
// never reads as a verified fact.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { CaseRow, EventRow as CrEventRow, ProposalRow } from "@/lib/cr/queries"
import {
  LOCKED_ACTIONS, OPEN_CASE_STATUSES,
  type ActionType, type AssumptionCheck, type DraftMessage, type GpsData, type ObdData, type PhotoData, type SourceRef,
} from "@/lib/cr/types"
import { describeEvent } from "./events"
import { type Bundle, str } from "./bundle"
import { label } from "./labels"
import { plainTokens } from "./text"
import { fmtClock, fmtDateTime, fmtRange, minutesBetween, relativeTo } from "./time"
import type { AttentionItem, CallTranscriptView, CaseView, DecisionCardView, DraftView, PromiseView, SourceChip, TelemetryStripView, TimelineEntry, Tone } from "./types"

export const AGENT_NAME = "Road agent"

const iso = (value: Date | string | null | undefined): string | null =>
  value instanceof Date ? value.toISOString() : value ? String(value) : null

// ---------------------------------------------------------------- labels

export const CASE_KIND_LABELS: Record<string, string> = {
  VEHICLE_WARNING: "Warning light", BREAKDOWN: "Breakdown", ACCIDENT: "Accident", DELAY: "Delay",
  MISSED_CONNECTION: "Missed ferry or train", KEYS_ACCESS: "Keys or access", EXPENSE: "Expense",
  DRIVER_QUESTION: "Driver question", SITE_QUESTION: "Site question", OPERATOR_QUESTION: "Operator question", HANDOVER: "Delivered",
}

const URGENCY_LABELS: Record<string, string> = { CRITICAL: "Critical", HIGH: "Urgent", NORMAL: "Normal", LOW: "Low" }
const URGENCY_RANK: Record<string, number> = { CRITICAL: 0, HIGH: 1, NORMAL: 2, LOW: 3 }

export function urgencyRank(urgency: string | null | undefined): number {
  return URGENCY_RANK[urgency ?? ""] ?? 4
}

export function urgencyLabel(urgency: string | null | undefined): string {
  return URGENCY_LABELS[urgency ?? ""] ?? label(urgency)
}

/** A decision on an urgent case is red; a normal one orange; a low one teal. */
export function urgencyTone(urgency: string | null | undefined): Tone {
  return urgency === "CRITICAL" || urgency === "HIGH" ? "danger" : urgency === "LOW" ? "accent" : "warn"
}

export function caseStatusLabel(row: Pick<CaseRow, "status" | "waitingOn">): string {
  switch (row.status) {
    case "NEEDS_DECISION": return "Needs your decision"
    case "AGENT_WORKING": return "Agent working"
    case "WAITING_EXTERNAL": return row.waitingOn ? `Waiting on ${row.waitingOn}` : "Waiting on someone outside"
    case "HANDLED_BY_AGENT": return "Handled by the agent"
    case "RESOLVED": return "Resolved"
    default: return label(row.status)
  }
}

function caseTone(row: CaseRow, pending: number): Tone {
  if (pending > 0 || row.status === "NEEDS_DECISION") return urgencyTone(row.urgency)
  if (row.status === "AGENT_WORKING") return "accent"
  if (row.status === "HANDLED_BY_AGENT" || row.status === "RESOLVED") return "ok"
  return "neutral"
}

export const ACTION_LABELS: Record<string, string> = {
  CONTACT_CUSTOMER: "Contact the customer",
  UPDATE_ETA: "Update the ETA",
  CHANGE_PROMISE: "Change the delivery promise",
  BOOK_RECOVERY: "Book recovery",
  BOOK_TRAVEL: "Book travel",
  APPROVE_EXPENSE: "Approve an expense",
  REASSIGN_DRIVER: "Reassign the driver",
  CLEAR_TO_CONTINUE: "Clear the driver to drive on",
  CONTACT_SITE_AS_CUSTOMER: "Contact the site (counts as the customer)",
  OPERATOR_DECISION: "Your call",
}

export function statusIs(proposal: { status: string }, status: "OUTDATED" | "UNKNOWN_OUTCOME"): boolean {
  return proposal.status === status
}

const PROPOSAL_STATUS: Record<string, { label: string; tone: Tone }> = {
  PENDING: { label: "Waiting for your decision", tone: "warn" },
  OUTDATED: { label: "Out of date", tone: "warn" },
  UNKNOWN_OUTCOME: { label: "Outcome unknown", tone: "danger" },
  APPROVED: { label: "Approved", tone: "ok" },
  EDITED_AND_APPROVED: { label: "Approved with changes", tone: "ok" },
  REJECTED: { label: "Rejected", tone: "neutral" },
  EXECUTED: { label: "Done", tone: "ok" },
  FAILED: { label: "Failed", tone: "danger" },
}

export const CHANNEL_LABELS: Record<string, string> = {
  driver_chat: "Driver app chat", driver_voice: "Voice call", site_chat: "Site chat", operator_chat: "Ask the agent",
  customer_email: "Email to customer", internal: "Internal note", telemetry: "Telemetry, simulated", system: "Control room",
  safety: "Safety instruction",
}

const DRAFT_CHANNELS: Record<string, string> = { email: "Email", phone_call: "Phone call", app_chat: "App chat", sms: "SMS" }
const DRAFT_ROLES: Record<string, string> = { customer: "customer", site: "pickup or delivery site", driver: "driver" }

function approvalRule(actionType: string): string {
  if (LOCKED_ACTIONS.includes(actionType as ActionType)) {
    return "Customer contact always needs a person. This can never be switched to automatic."
  }
  if (actionType === "CHANGE_PROMISE") return "Approving sends the proposal to the customer. The promise changes only when the customer agrees."
  if (actionType === "CLEAR_TO_CONTINUE") return "The agent may never tell a driver to keep driving. Only a person can, on purpose."
  if (actionType === "OPERATOR_DECISION") return "The agent needs a person to choose."
  return "Ask first: the agent needs a yes before this kind of change. Levels are on the agent page."
}

// ---------------------------------------------------------------- sources

const DATASET_SOURCE_LABELS: Record<string, string> = {
  messages: "Message", alerts: "Alert", time_windows: "Time window", work_items: "Work item", incidents: "Incident",
  operational_events: "Event log", tracking_observations: "Tracking", travel_reservations: "Booking",
  travel_options: "Quote", order_endpoint_details: "Endpoint details", work_assignments: "Assignment",
}

/** A chip for a source reference. Lines that are on this page link to their timeline entry. */
export function sourceChip(ref: SourceRef): SourceChip {
  const onPage = ["messages", "cr_events", "operational_events", "alerts"].includes(ref.kind)
  return {
    kind: ref.kind, id: ref.id,
    label: ref.label || DATASET_SOURCE_LABELS[ref.kind] || label(ref.kind.replace(/^[a-z]+:/, "")),
    at: ref.at ?? null,
    href: ref.kind === "cr_call_turns" ? `#call-turn-${ref.id}` : ref.kind === "cr_calls" ? `#call-${ref.id}` : onPage ? `#t-${ref.id}` : null,
  }
}

/** Keep recorded speech distinct from extracted slots and the analyst's conclusions. */
export function callTranscriptViews(bundle: Bundle): CallTranscriptView[] {
  return [...bundle.cr.calls].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime()).map((call) => {
    const driverName = bundle.dir.driverName(call.driverId) ?? "Driver"
    const urgency = call.urgency
    return {
      id: call.id, caseId: call.caseId, driverName, startedAt: call.startedAt.toISOString(), endedAt: iso(call.endedAt),
      directionLabel: call.direction === "AGENT_INITIATED" ? "Agent called driver" : "Driver called Road Desk",
      urgencyLabel: urgency === "EMERGENCY" ? "Emergency" : urgency === "URGENT" ? "Urgent" : urgency === "ROUTINE" ? "Routine" : null,
      tone: urgency === "EMERGENCY" ? "danger" : urgency === "URGENT" ? "warn" : "neutral",
      urgencyQuote: call.state.urgencyQuote ?? null, urgencyTurnId: call.urgencyTurnId, readbackConfirmed: call.readbackConfirmed,
      turns: bundle.cr.callTurns.filter((turn) => turn.callId === call.id).sort((a, b) => a.seq - b.seq).map((turn) => {
        const driver = turn.speaker === "driver"
        const recorded = turn.textFinal?.trim() || null
        const live = turn.textLive?.trim() || null
        return {
          id: turn.id, speaker: driver ? "driver" : "agent", speakerName: driver ? driverName : "Road Desk interviewer",
          at: turn.startedAt.toISOString(), text: recorded ?? live ?? "No words recorded.",
          liveText: recorded && live && recorded !== live ? live : null,
          transcriptLabel: driver ? recorded ? "Transcript of recording" : turn.flags.sttError ? "Live transcript; recording transcription unavailable" : "Live transcript; recording transcription pending" : "Agent's spoken words",
          // Recordings of the retired in-app interviewer are not served any more; the transcript of record stays.
          audioUrl: null,
          interrupted: turn.interrupted,
        }
      }),
    }
  })
}

// ---------------------------------------------------------------- attention

/**
 * What our cases add to "needs a person". A waiting decision card is the item;
 * an open case without a card says who is on it. Resolved and handled cases add
 * nothing.
 */
export function caseAttention(bundle: Bundle): AttentionItem[] {
  const { cases, proposals } = bundle.cr
  const items: AttentionItem[] = []
  const pending = proposals.filter((proposal) => proposal.status === "PENDING")
  const casesById = new Map(cases.map((row) => [row.id, row]))
  for (const proposal of pending) {
    const parent = casesById.get(proposal.caseId)
    items.push({
      kind: "decision", tone: urgencyTone(parent?.urgency), title: `Decision waiting: ${proposal.title}`,
      short: `Decide: ${proposal.title}`, detail: parent?.title ?? proposal.rationale, owner: null,
      at: iso(proposal.createdAt), atLabel: "proposed", section: "case", recordId: proposal.id,
    })
  }
  for (const proposal of proposals.filter((row) => statusIs(row, "UNKNOWN_OUTCOME"))) {
    items.push({
      kind: "decision", tone: "danger", title: `Outcome unknown: ${proposal.title}`, short: "Outcome unknown, check before retrying",
      detail: "The action may or may not have happened. Check with the other side before anything is retried.", owner: null,
      at: iso(proposal.executedAt ?? proposal.decidedAt ?? proposal.createdAt), atLabel: "attempted", section: "case", recordId: proposal.id,
    })
  }
  for (const row of cases) {
    if (!OPEN_CASE_STATUSES.includes(row.status)) continue
    if (pending.some((proposal) => proposal.caseId === row.id)) continue
    const kindLabel = CASE_KIND_LABELS[row.kind] ?? label(row.kind)
    const checkAt = iso(row.nextCheckAt)
    if (row.status === "WAITING_EXTERNAL" && checkAt && checkAt < bundle.cr.now) {
      items.push({
        kind: "decision", tone: "warn", title: plainText(bundle, `Overdue: ${row.waitingOn ? `waiting on ${row.waitingOn}` : row.title}`),
        short: "Follow-up overdue", detail: plainText(bundle, row.nextAction ?? row.title), owner: ownerName(bundle, row.owner),
        at: checkAt, atLabel: "check was due", section: "case", recordId: row.id,
      })
      continue
    }
    if (row.status === "NEEDS_DECISION") {
      items.push({
        kind: "decision", tone: urgencyTone(row.urgency), title: `The agent needs a person: ${row.title}`, short: `Needs a person: ${row.title}`,
        detail: row.summary || null, owner: null, at: iso(row.updatedAt), atLabel: "handed over", section: "case", recordId: row.id,
      })
    } else if (row.status === "AGENT_WORKING") {
      items.push({
        kind: "case", tone: "accent", title: `Agent working: ${row.title}`, short: `Agent working: ${kindLabel.toLowerCase()}`,
        detail: row.summary || null, owner: AGENT_NAME, at: iso(row.updatedAt), atLabel: "updated", section: "case", recordId: row.id,
      })
    } else {
      items.push({
        kind: "case", tone: "neutral", title: plainText(bundle, `${caseStatusLabel(row)}: ${row.title}`), short: plainText(bundle, caseStatusLabel(row)),
        detail: plainText(bundle, row.nextAction ?? (row.summary || null)), owner: ownerName(bundle, row.owner), at: iso(row.updatedAt), atLabel: "updated",
        section: "case", recordId: row.id,
      })
    }
  }
  return items
}

/** Free text from the agent or the gate may carry a desk id ("ops-shift"); operators read the desk's title. */
export { plainTokens }

export function plainText(bundle: Bundle, text: string): string
export function plainText(bundle: Bundle, text: string | null): string | null
export function plainText(bundle: Bundle, text: string | null): string | null {
  if (!text) return text
  const words = plainTokens(text)
  return words
    .replace(/\bops-[a-z]+\b/g, (id, offset: number) => {
      const title = bundle.dir.title(id) ?? id
      // "Shift lead does this…" at the start; "waiting on the shift lead" mid-sentence.
      return offset === 0 || /[.!?]\s*$/.test(words.slice(0, offset)) ? title : `the ${title.toLowerCase()}`
    })
    .replace(/\broad-agent\b/g, AGENT_NAME)
}

export function ownerName(bundle: Bundle, owner: string | null | undefined): string | null {
  if (!owner) return null
  if (owner === "agent" || owner === "road-agent") return AGENT_NAME
  return bundle.dir.title(owner)
}

// ---------------------------------------------------------------- cases and cards

function draftView(draft: DraftMessage | null | undefined, bodyOverride?: string | null): DraftView | null {
  if (!draft) return null
  return {
    original: draft, toName: draft.to_name, toRole: DRAFT_ROLES[draft.to_type] ?? draft.to_type, isCustomer: draft.to_type === "customer",
    channelLabel: DRAFT_CHANNELS[draft.channel] ?? label(draft.channel), subject: draft.subject ?? null,
    // A preamble the model wrote for the operator ("here is the draft…", a rule) is not part of the message.
    body: (bodyOverride ?? draft.body).replace(/^[^\n]*(?:draft|held for|approval)[^\n]*:?\s*\n+(?:-{3,}\s*\n+)?/i, "").replace(/\n+-{3,}[\s\S]*$/, "").trim() || (bodyOverride ?? draft.body),
  }
}

function deciderName(bundle: Bundle, id: string | null): string {
  if (!id) return "A person"
  return ownerName(bundle, id) ?? id
}

export function decisionCardView(bundle: Bundle, proposal: ProposalRow): DecisionCardView {
  const status = PROPOSAL_STATUS[proposal.status] ?? { label: label(proposal.status), tone: "neutral" as Tone }
  const handover = proposal.handover
  const chosen = proposal.chosenOptionId ? proposal.options.find((option) => option.id === proposal.chosenOptionId) : null
  const decided = proposal.status !== "PENDING"
  const execution = proposal.executionResult ?? {}
  const outcome = typeof execution.outcome === "string" && execution.outcome ? execution.outcome : null
  // The decision event says which button was used (lib/agent/gate.ts records it).
  const decisionEvent = bundle.cr.events.find((event) => event.kind === "decision" && event.data?.proposal_id === proposal.id)
  const button = typeof decisionEvent?.data?.decision === "string" ? decisionEvent.data.decision : null
  // "I'll handle it" leaves the card approved and not yet carried out until the outcome is logged.
  const awaitingOutcome = (proposal.status === "APPROVED" || proposal.status === "EDITED_AND_APPROVED") && !proposal.executedAt
  const mode = button === "handle" || awaitingOutcome || outcome ? "operator" : button === "instruct" ? "instruction" : button === "refresh" ? "refresh" : null
  const reconcile = bundle.cr.events.find((event) => event.data?.proposal_id === proposal.id && typeof event.data?.booking_exists === "boolean")
  const reconciled = reconcile ? reconcile.data.booking_exists === true : null
  const selected = proposal.bookingSelection
  const replaces = selected?.replaces_reservation_id
    ? bundle.related.travel_reservations?.find((row) => row.id === selected.replaces_reservation_id)?.details : null
  const replacedEffect = selected?.replaces_reservation_id ? bundle.cr.effects.find((effect) => effect.id === selected.replaces_reservation_id) : null
  return {
    id: proposal.id, caseId: proposal.caseId, actionType: proposal.actionType,
    actionLabel: ACTION_LABELS[proposal.actionType] ?? label(proposal.actionType),
    title: plainText(bundle, proposal.title), rationale: plainText(bundle, proposal.rationale), status: proposal.status, statusLabel: status.label, tone: status.tone,
    pending: !decided,
    whatHappened: plainText(bundle, handover?.what_happened ?? null),
    facts: (handover?.facts ?? []).map((fact) => ({ text: plainText(bundle, fact.text), sources: fact.sources.map(sourceChip) })),
    agentDid: (handover?.agent_did ?? []).map((line) => plainText(bundle, line)),
    unknowns: (handover?.unknowns ?? []).map((line) => plainText(bundle, line)),
    recommendation: plainText(bundle, handover?.recommendation ?? null),
    alternatives: (handover?.alternatives ?? []).map((line) => plainText(bundle, line)),
    changes: proposal.changes,
    booking: selected ? {
      kind: label(selected.kind), provider: selected.provider, from: selected.from, to: selected.to,
      departureAt: selected.departure_at, arrivalAt: selected.arrival_at, checkInCutoffAt: selected.check_in_cutoff_at,
      priceAmount: selected.price_amount, currency: selected.currency, quotedAt: selected.quoted_at,
      replaces: selected.replaces_reservation_id ? str(replaces?.booking_reference) ?? str(replacedEffect?.value.reference) ?? "Earlier reservation (reference not recorded)" : null,
      source: sourceChip(selected.quote_source),
    } : null,
    draft: draftView(proposal.draftMessage),
    editedDraft: proposal.editedDraftMessage ? draftView(proposal.editedDraftMessage) : null,
    options: proposal.options.map((option) => ({ id: option.id, label: plainText(bundle, option.label), description: plainText(bundle, option.description ?? null), recommended: !!option.recommended })),
    evidence: proposal.evidenceRefs.map(sourceChip),
    nextIfApproved: plainText(bundle, proposal.nextStepIfApproved), nextIfRejected: plainText(bundle, proposal.nextStepIfRejected),
    createdAt: iso(proposal.createdAt) ?? "", createdBy: ownerName(bundle, proposal.createdBy) ?? AGENT_NAME,
    approvalRule: approvalRule(proposal.actionType),
    decision: decided ? {
      by: deciderName(bundle, proposal.decidedBy), at: iso(proposal.decidedAt), note: proposal.decisionNote,
      option: chosen?.label ?? null, nextStep: plainText(bundle, proposal.nextStep), executedAt: iso(proposal.executedAt), mode, outcome, reconciled,
    } : null,
    awaitingOutcome,
    factsChanged: decided ? null : factsChangedSince(bundle, proposal),
    outdated: statusIs(proposal, "OUTDATED") ? { changed: changedAssumptions(proposal) } : null,
    unknownOutcome: statusIs(proposal, "UNKNOWN_OUTCOME"),
    revision: proposal.revision,
    replaces: replacedVersion(bundle, proposal),
    choiceOnly: proposal.actionType === "OPERATOR_DECISION" && proposal.options.length > 0,
  }
}

/** What a card relied on, in words, for "expected → now". */
function expectedText(check: AssumptionCheck): string | null {
  const { assumption } = check
  if (assumption.kind === "record") return assumption.expected == null ? "empty" : label(String(assumption.expected)) || String(assumption.expected)
  if (assumption.kind === "no_new_message") return `nothing new from the ${assumption.from}`
  return assumption.codes.length ? `car reports ${assumption.codes.join(", ")}` : "no trouble codes"
}

/** What an OUTDATED card relied on that no longer holds (lib/agent/gate.ts stores the checks on the execution result). */
function changedAssumptions(proposal: ProposalRow): { label: string; expected: string | null; actual: string | null }[] {
  const checks = proposal.executionResult?.outdated
  if (!Array.isArray(checks)) return []
  return (checks as AssumptionCheck[]).filter((check) => !check.holds).map((check) => ({
    label: check.assumption.label, expected: expectedText(check), actual: check.now,
  }))
}

/** A redraft names what changed in the version it replaces. */
function replacedVersion(bundle: Bundle, proposal: ProposalRow): DecisionCardView["replaces"] {
  if (!proposal.revisesProposalId) return null
  const earlier = bundle.cr.proposals.find((row) => row.id === proposal.revisesProposalId)
  return earlier ? { changed: changedAssumptions(earlier) } : { changed: [] }
}

/** Who counts as news for a waiting card; the agent's own notes and operator actions do not (as in lib/cr/queries.ts). */
const OUTSIDE_ACTORS = new Set(["driver", "site", "customer", "obd", "phone"])
const NEWS_FROM: Record<string, string> = { driver: "the driver", site: "the site", customer: "the customer", obd: "the car", phone: "the driver's phone" }

/** The newest outside fact on the card's case that arrived after the card was drafted. */
function factsChangedSince(bundle: Bundle, proposal: ProposalRow): DecisionCardView["factsChanged"] {
  const newer = bundle.cr.events
    .filter((event) => event.caseId === proposal.caseId && OUTSIDE_ACTORS.has(event.actorType) && event.at > proposal.createdAt)
    .sort((a, b) => b.at.getTime() - a.at.getTime())[0]
  if (!newer) return null
  const what = newer.kind === "photo" ? "a photo" : newer.kind === "dtc" || newer.kind === "telemetry_snapshot" ? "new readings" : "a message"
  return { at: newer.at.toISOString(), what: `${what} from ${NEWS_FROM[newer.actorType] ?? "outside"}` }
}

/** Cases on this order, open ones first, newest first within each group. */
export function caseViews(bundle: Bundle): CaseView[] {
  const { cases, proposals } = bundle.cr
  return [...cases]
    .sort((a, b) => Number(OPEN_CASE_STATUSES.includes(b.status)) - Number(OPEN_CASE_STATUSES.includes(a.status))
      || b.updatedAt.getTime() - a.updatedAt.getTime())
    .map((row) => {
      const cards = proposals.filter((proposal) => proposal.caseId === row.id).map((proposal) => decisionCardView(bundle, proposal))
      const pending = cards.filter((card) => card.status === "PENDING")
      // An out-of-date card matters until its redraft exists; then the redraft says what it replaces.
      const redrafted = new Set(proposals.map((proposal) => proposal.revisesProposalId).filter(Boolean))
      const outdated = cards.filter((card) => card.outdated && !redrafted.has(card.id))
      const unknown = cards.filter((card) => card.unknownOutcome)
      const checkAt = iso(row.nextCheckAt)
      const check = checkAt ? relativeTo(checkAt, bundle.cr.now) : null
      const open = OPEN_CASE_STATUSES.includes(row.status)
      return {
        id: row.id, kind: row.kind, kindLabel: CASE_KIND_LABELS[row.kind] ?? label(row.kind),
        status: row.status, statusLabel: plainText(bundle, caseStatusLabel(row)), tone: caseTone(row, pending.length),
        urgency: row.urgency, urgencyLabel: urgencyLabel(row.urgency),
        title: row.title, summary: plainText(bundle, row.summary), channelLabel: CHANNEL_LABELS[row.channelOpened] ?? label(row.channelOpened),
        openedAt: iso(row.openedAt) ?? "", updatedAt: iso(row.updatedAt) ?? "", resolvedAt: iso(row.resolvedAt),
        owner: ownerName(bundle, row.owner), waitingOn: plainText(bundle, row.waitingOn), nextStep: plainText(bundle, row.nextAction),
        nextCheckAt: open ? checkAt : null,
        nextCheckLabel: open && checkAt ? `${check?.past ? "check was due" : "next check"} ${fmtClock(checkAt)}${check ? ` (${check.text})` : ""}` : null,
        overdue: open && !!check?.past && row.status === "WAITING_EXTERNAL",
        lastRun: row.lastRunStatus ?? null,
        sources: row.linkedRecords.map(sourceChip),
        pending, outdated, unknown,
        decided: cards.filter((card) => card.status !== "PENDING" && !card.unknownOutcome).reverse(),
      }
    })
}

// ---------------------------------------------------------------- timeline

/** What an internal line is, since "internal note" alone says little. */
const INTERNAL_LABELS: Record<string, string> = {
  lookup: "Looked up", tool_call: "Tool", proposal: "Decision card", decision: "Decision", effect: "Done, simulated", note: "Note",
}

const LIVE_KIND: Record<string, string> = {
  message: "message", voice_turn: "voice", photo: "photo", telemetry_snapshot: "telemetry", dtc: "telemetry",
  lookup: "lookup", tool_call: "lookup", proposal: "proposal", decision: "decision", effect: "effect", note: "note",
}

function liveActor(bundle: Bundle, event: CrEventRow): { name: string; role: string | null } {
  switch (event.actorType) {
    case "agent": return { name: AGENT_NAME, role: "agent" }
    case "obd": return { name: "OBD dongle", role: null }
    case "phone": return { name: "Driver's phone", role: null }
    case "system": return { name: "Control room", role: null }
    case "site": {
      const site = bundle.dir.siteName(event.actorId)
      return { name: site ?? bundle.dir.resolve(event.actorId, "site_contact").name, role: "site contact" }
    }
    default: {
      const actor = bundle.dir.resolve(event.actorId, event.actorType)
      if (event.actorType === "operator") return { name: actor.name, role: "operator" }
      return { name: actor.name, role: actor.role }
    }
  }
}

function recipientName(bundle: Bundle, type: string | null, id: string | null): string | null {
  if (!type) return null
  if (type === "agent") return AGENT_NAME
  if (type === "site") return bundle.dir.siteName(id) ?? bundle.dir.resolve(id, "site_contact").name
  return bundle.dir.resolve(id, type).name
}

function liveTone(event: CrEventRow): Tone {
  if (event.channel === "safety") return "danger"
  if (event.kind === "dtc") return "warn"
  if (event.kind === "proposal") return "accent"
  if (event.kind === "decision") return event.data?.decision === "REJECT" ? "neutral" : "ok"
  if (event.kind === "effect") return "ok"
  return "neutral"
}

/**
 * Messages, alerts and the event log from the snapshot, merged with our live
 * case events, oldest first. Each line says who spoke, on which channel, and
 * which record it comes from.
 */
export function mergedTimeline(bundle: Bundle): TimelineEntry[] {
  const { dir } = bundle
  const entries: TimelineEntry[] = []
  const threads = new Map(bundle.conversations.map((thread) => [thread.id, thread]))

  for (const message of bundle.messages) {
    if (message.orderId !== bundle.order.id && !threads.has(message.conversationId)) continue
    const d = message.details
    const channel = str(d.channel) ?? threads.get(message.conversationId)?.channel ?? "message"
    const author = dir.resolve(d.author_id, message.authorType)
    if (str(d.author_name_snapshot)) author.name = str(d.author_name_snapshot) as string
    const recipient = str(d.recipient_id) || str(d.recipient_type) ? dir.resolve(d.recipient_id, d.recipient_type) : null
    const internal = str(d.visibility) === "INTERNAL" || channel === "internal_note"
    const channelLabel = label(channel)
    entries.push({
      id: message.id, at: message.authoredAt, actorName: author.name, actorRole: author.role, actorKind: author.kind, rich: false,
      kind: "message", text: message.body,
      channelLabel: internal ? "Internal note" : recipient ? `${channelLabel} to ${recipient.name}` : channelLabel,
      source: { kind: "messages", id: message.id, label: `${channelLabel.toLowerCase()} message`, at: message.authoredAt },
      tone: "neutral", origin: "record", internal, caseId: null, photo: null,
    })
  }

  for (const alert of bundle.alerts) {
    entries.push({
      id: alert.id, at: alert.triggeredAt, actorName: "Journey monitor", actorRole: "alert", actorKind: "system", rich: false,
      kind: "alert", text: `Alert raised: ${label(alert.signal)}. ${alert.summary}`, channelLabel: `Alert, ${label(alert.status).toLowerCase()}`,
      source: { kind: "alerts", id: alert.id, label: "alert", at: alert.triggeredAt },
      tone: alert.status === "OPEN" ? (alert.severity === "critical" || alert.severity === "high" ? "danger" : "warn") : "neutral",
      origin: "record", internal: true, caseId: null, photo: null,
    })
  }

  for (const event of bundle.events) {
    const described = describeEvent(event, bundle)
    entries.push({
      id: event.id, at: event.recordedAt, actorName: described.actor ?? "System", actorRole: null, actorKind: "system", rich: false,
      kind: "event", text: described.detail ? `${described.text}. ${described.detail}` : described.text, channelLabel: "Event log",
      source: { kind: "operational_events", id: event.id, label: "event log", at: event.recordedAt },
      tone: "neutral", origin: "record", internal: true, caseId: null, photo: null,
    })
  }

  for (const event of bundle.cr.events) {
    const actor = liveActor(bundle, event)
    const to = recipientName(bundle, event.recipientType, event.recipientId)
    const channel = event.channel === "internal" ? INTERNAL_LABELS[event.kind] ?? "Internal note" : CHANNEL_LABELS[event.channel] ?? label(event.channel)
    const at = iso(event.at) ?? ""
    entries.push({
      id: event.id, at, actorName: actor.name, actorRole: actor.role, actorKind: event.actorType,
      kind: event.channel === "safety" ? "safety" : LIVE_KIND[event.kind] ?? "note", text: plainText(bundle, event.body),
      channelLabel: to ? `${channel} to ${to}` : channel,
      source: { kind: "cr_events", id: event.id, label: event.actorType === "obd" || event.actorType === "phone" ? "simulated sensor" : "case log", at },
      tone: liveTone(event), origin: "live", internal: event.channel === "internal" || event.kind === "lookup" || event.kind === "tool_call",
      rich: event.actorType === "agent" && (event.kind === "note" || event.channel === "operator_chat"),
      caseId: event.caseId, photo: photoOf(bundle, event),
    })
  }

  return entries.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
}

/** Photos are stored inline on the event; the page fetches them from a small route instead of the polled JSON. */
function photoOf(bundle: Bundle, event: CrEventRow): TimelineEntry["photo"] {
  if (event.kind !== "photo") return null
  const data = event.data as Partial<PhotoData>
  if (!data.base64 && !data.path) return null
  return { src: data.path ?? `/orders/${bundle.order.id}/photos/${event.id}`, subject: data.subject ?? null }
}

// ---------------------------------------------------------------- telemetry strip

type DtcEntry = { code: string; title: string; severity: string }
let dtcIndex: Map<string, DtcEntry> | null = null

function dtc(code: string): DtcEntry | null {
  if (!dtcIndex) {
    try {
      const file = JSON.parse(readFileSync(join(process.cwd(), "knowledge", "dtc.json"), "utf8")) as { codes: DtcEntry[] }
      dtcIndex = new Map(file.codes.map((entry) => [entry.code, entry]))
    } catch {
      dtcIndex = new Map()
    }
  }
  return dtcIndex.get(code) ?? null
}

const SEVERITY_TONE: Record<string, Tone> = { STOP_NOW: "danger", DRIVE_TO_SAFE_STOP: "warn", CONTINUE_AND_MONITOR: "neutral" }
/** A sample older than this reads as stale on the strip. */
const STRIP_STALE_MINUTES = 10

export function telemetryStrip(bundle: Bundle): TelemetryStripView | null {
  const { obd, gps, now } = bundle.cr
  if (!obd && !gps) return null
  const data = (obd?.data ?? null) as Partial<ObdData> | null
  const at = obd ? obd.at.toISOString() : null
  const rel = at ? relativeTo(at, now) : null
  const values: TelemetryStripView["values"] = []
  const push = (label: string, value: number | undefined, unit: string, tone: Tone = "neutral", digits = 0) => {
    if (typeof value === "number" && Number.isFinite(value)) values.push({ label, value: `${value.toFixed(digits)}${unit}`, tone })
  }
  if (data) {
    push("Speed", data.speed_kmh, " km/h")
    push("Engine", data.rpm, " rpm")
    push("Load", data.engine_load_pct, "%")
    push("Coolant", data.coolant_c, " °C", typeof data.coolant_c === "number" && data.coolant_c >= 110 ? "danger" : "neutral")
    push("Battery", data.battery_v, " V", typeof data.battery_v === "number" && data.battery_v < 12 ? "warn" : "neutral", 1)
    push("Charge", data.soc_pct, "%")
    if (typeof data.misfire_count === "number" && data.misfire_count > 0) push("Misfires", data.misfire_count, "", "warn")
  }
  const codes = (data?.dtcs ?? []).map((code) => {
    const entry = dtc(code)
    return { code, title: entry?.title ?? null, severity: entry ? label(entry.severity) : null, tone: entry ? SEVERITY_TONE[entry.severity] ?? "neutral" : "warn" as Tone }
  })
  const position = gps ? (() => {
    const g = gps.data as Partial<GpsData>
    const gpsRel = relativeTo(gps.at.toISOString(), now)
    const place = g.place_label ?? (typeof g.lat === "number" && typeof g.lng === "number" ? `${g.lat.toFixed(3)}, ${g.lng.toFixed(3)}` : "unknown")
    return { label: place, ageLabel: gpsRel?.text ?? null }
  })() : null
  const fuel = bundle.items.find((item) => item.role === "PRIMARY")?.vehicle.fuel ?? null
  return {
    at, ageLabel: rel?.text ?? null, stale: at ? (minutesBetween(at, now) ?? 0) > STRIP_STALE_MINUTES : false,
    mil: data?.mil ?? null, values, codes, position,
    simulated: (obd?.simulated ?? true) && (gps?.simulated ?? true),
    electric: fuel?.toLowerCase() === "electric",
  }
}

// ---------------------------------------------------------------- promise

/**
 * The delivery promise as it stands (lib/cr/effective.ts): the dataset window
 * unless the customer agreed to a change. A proposed change is listed as
 * pending and never shown as the promise.
 */
export function promiseView(bundle: Bundle): PromiseView | null {
  const promise = bundle.cr.effective?.promise
  if (!promise || !promise.start_utc) return null
  const zone = promise.zone
  const text = promise.end_utc ? fmtRange(promise.start_utc, promise.end_utc, zone) : fmtDateTime(promise.start_utc, zone)
  const openCase = bundle.cr.cases.find((row) => OPEN_CASE_STATUSES.includes(row.status))
  return {
    text, basis: plainText(bundle, promise.basis), source: sourceChip(promise.source), changed: promise.source.kind === "cr_effects",
    pending: promise.pending.map((item) => ({ effectId: item.effect_id, text: item.text, proposedAt: item.proposed_at, basis: plainText(bundle, item.basis) })),
    history: promise.history.map((item) => ({ ...item, basis: plainText(bundle, item.basis) })),
    caseId: openCase?.id ?? bundle.cr.cases[0]?.id ?? null,
  }
}
