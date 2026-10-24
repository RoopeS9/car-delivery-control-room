// Our cases, decision cards and the merged timeline, read out for the control
// room. Like the rest of lib/present this only reads: the cr_ rows are written
// by the agent (lib/agent) and the simulator (lib/sim). Every line keeps the
// source it came from, so a quote never reads as a booking and a driver message
// never reads as a verified fact.

import type { CaseRow, EventRow as CrEventRow, ProposalRow } from "@/lib/cr/queries"
import { LOCKED_ACTIONS, OPEN_CASE_STATUSES, type ActionType, type DraftMessage, type SourceRef } from "@/lib/cr/types"
import { describeEvent } from "./events"
import { type Bundle, str } from "./bundle"
import { label } from "./labels"
import type { AttentionItem, CaseView, DecisionCardView, DraftView, SourceChip, TimelineEntry, Tone } from "./types"

export const AGENT_NAME = "Road agent"

const iso = (value: Date | string | null | undefined): string | null =>
  value instanceof Date ? value.toISOString() : value ? String(value) : null

// ---------------------------------------------------------------- labels

export const CASE_KIND_LABELS: Record<string, string> = {
  VEHICLE_WARNING: "Warning light", BREAKDOWN: "Breakdown", ACCIDENT: "Accident", DELAY: "Delay",
  MISSED_CONNECTION: "Missed ferry or train", KEYS_ACCESS: "Keys or access", EXPENSE: "Expense",
  DRIVER_QUESTION: "Driver question", SITE_QUESTION: "Site question", OPERATOR_QUESTION: "Operator question",
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
}

const PROPOSAL_STATUS: Record<string, { label: string; tone: Tone }> = {
  PENDING: { label: "Waiting for your decision", tone: "warn" },
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
    href: onPage ? `#t-${ref.id}` : null,
  }
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
  for (const row of cases) {
    if (!OPEN_CASE_STATUSES.includes(row.status)) continue
    if (pending.some((proposal) => proposal.caseId === row.id)) continue
    const kindLabel = CASE_KIND_LABELS[row.kind] ?? label(row.kind)
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
        kind: "case", tone: "neutral", title: `${caseStatusLabel(row)}: ${row.title}`, short: caseStatusLabel(row),
        detail: row.nextStep ?? (row.summary || null), owner: ownerName(bundle, row.owner), at: iso(row.updatedAt), atLabel: "updated",
        section: "case", recordId: row.id,
      })
    }
  }
  return items
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
    body: bodyOverride ?? draft.body,
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
  const execution = proposal.execution ?? {}
  const mode = typeof execution.mode === "string" ? execution.mode : null
  const outcome = typeof execution.outcome === "string" && execution.outcome ? execution.outcome : null
  return {
    id: proposal.id, caseId: proposal.caseId, actionType: proposal.actionType,
    actionLabel: ACTION_LABELS[proposal.actionType] ?? label(proposal.actionType),
    title: proposal.title, rationale: proposal.rationale, status: proposal.status, statusLabel: status.label, tone: status.tone,
    pending: !decided,
    whatHappened: handover?.what_happened ?? null,
    facts: (handover?.facts ?? []).map((fact) => ({ text: fact.text, sources: fact.sources.map(sourceChip) })),
    agentDid: handover?.agent_did ?? [],
    unknowns: handover?.unknowns ?? [],
    recommendation: handover?.recommendation ?? null,
    alternatives: handover?.alternatives ?? [],
    changes: proposal.changes,
    draft: draftView(proposal.draftMessage),
    editedDraft: proposal.editedDraftMessage ? draftView(proposal.editedDraftMessage) : null,
    options: proposal.options.map((option) => ({ id: option.id, label: option.label, description: option.description ?? null, recommended: !!option.recommended })),
    evidence: proposal.evidenceRefs.map(sourceChip),
    nextIfApproved: proposal.nextStepIfApproved, nextIfRejected: proposal.nextStepIfRejected,
    createdAt: iso(proposal.createdAt) ?? "", createdBy: ownerName(bundle, proposal.createdBy) ?? AGENT_NAME,
    approvalRule: approvalRule(proposal.actionType),
    decision: decided ? {
      by: deciderName(bundle, proposal.decidedBy), at: iso(proposal.decidedAt), note: proposal.decisionNote,
      option: chosen?.label ?? null, nextStep: proposal.nextStep, executedAt: iso(proposal.executedAt), mode, outcome,
    } : null,
    awaitingOutcome: decided && mode === "operator" && !outcome,
  }
}

/** Cases on this order, open ones first, newest first within each group. */
export function caseViews(bundle: Bundle): CaseView[] {
  const { cases, proposals } = bundle.cr
  return [...cases]
    .sort((a, b) => Number(OPEN_CASE_STATUSES.includes(b.status)) - Number(OPEN_CASE_STATUSES.includes(a.status))
      || b.updatedAt.getTime() - a.updatedAt.getTime())
    .map((row) => {
      const cards = proposals.filter((proposal) => proposal.caseId === row.id).map((proposal) => decisionCardView(bundle, proposal))
      const pending = cards.filter((card) => card.pending)
      return {
        id: row.id, kind: row.kind, kindLabel: CASE_KIND_LABELS[row.kind] ?? label(row.kind),
        status: row.status, statusLabel: caseStatusLabel(row), tone: caseTone(row, pending.length),
        urgency: row.urgency, urgencyLabel: urgencyLabel(row.urgency),
        title: row.title, summary: row.summary, channelLabel: CHANNEL_LABELS[row.channelOpened] ?? label(row.channelOpened),
        openedAt: iso(row.openedAt) ?? "", updatedAt: iso(row.updatedAt) ?? "", resolvedAt: iso(row.resolvedAt),
        owner: ownerName(bundle, row.owner), waitingOn: row.waitingOn, nextStep: row.nextStep,
        sources: row.sourceRefs.map(sourceChip),
        pending,
        decided: cards.filter((card) => !card.pending).reverse(),
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
      id: message.id, at: message.authoredAt, actorName: author.name, actorRole: author.role, actorKind: author.kind,
      kind: "message", text: message.body,
      channelLabel: internal ? "Internal note" : recipient ? `${channelLabel} to ${recipient.name}` : channelLabel,
      source: { kind: "messages", id: message.id, label: `${channelLabel.toLowerCase()} message`, at: message.authoredAt },
      tone: "neutral", origin: "record", internal, caseId: null,
    })
  }

  for (const alert of bundle.alerts) {
    entries.push({
      id: alert.id, at: alert.triggeredAt, actorName: "Journey monitor", actorRole: "alert", actorKind: "system",
      kind: "alert", text: `Alert raised: ${label(alert.signal)}. ${alert.summary}`, channelLabel: `Alert, ${label(alert.status).toLowerCase()}`,
      source: { kind: "alerts", id: alert.id, label: "alert", at: alert.triggeredAt },
      tone: alert.status === "OPEN" ? (alert.severity === "critical" || alert.severity === "high" ? "danger" : "warn") : "neutral",
      origin: "record", internal: true, caseId: null,
    })
  }

  for (const event of bundle.events) {
    const described = describeEvent(event, bundle)
    entries.push({
      id: event.id, at: event.recordedAt, actorName: described.actor ?? "System", actorRole: null, actorKind: "system",
      kind: "event", text: described.detail ? `${described.text}. ${described.detail}` : described.text, channelLabel: "Event log",
      source: { kind: "operational_events", id: event.id, label: "event log", at: event.recordedAt },
      tone: "neutral", origin: "record", internal: true, caseId: null,
    })
  }

  for (const event of bundle.cr.events) {
    const actor = liveActor(bundle, event)
    const to = recipientName(bundle, event.recipientType, event.recipientId)
    const channel = event.channel === "internal" ? INTERNAL_LABELS[event.kind] ?? "Internal note" : CHANNEL_LABELS[event.channel] ?? label(event.channel)
    const at = iso(event.at) ?? ""
    entries.push({
      id: event.id, at, actorName: actor.name, actorRole: actor.role, actorKind: event.actorType,
      kind: event.channel === "safety" ? "safety" : LIVE_KIND[event.kind] ?? "note", text: event.body,
      channelLabel: to ? `${channel} to ${to}` : channel,
      source: { kind: "cr_events", id: event.id, label: event.actorType === "obd" || event.actorType === "phone" ? "simulated sensor" : "case log", at },
      tone: liveTone(event), origin: "live", internal: event.channel === "internal" || event.kind === "lookup" || event.kind === "tool_call",
      caseId: event.caseId,
    })
  }

  return entries.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
}
