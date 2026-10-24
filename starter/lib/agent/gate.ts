// The approval gate. Every tool call the agent makes passes through here, and
// so does every proposal and every decision on one. The rules from the brief
// live in code, not only in the prompt:
//
// 1. The agent never contacts a customer on its own. Customer contact is
//    always a proposal a person approves, whatever the autonomy settings say.
// 2. Nothing changes without approval unless an operator raised that action
//    type's autonomy level, and customer contact can never be raised.
// 3. Drivers and sites only reach their own order.
// 4. The agent may tell a driver to stop, never that it is fine to drive on.

import { randomUUID } from "node:crypto"
import {
  appendEvent, createProposal, getAutonomy, getCase, getProposal, listProposals, proposalsWithChangedFacts, transitionProposal, updateCase,
  type CaseRow, type ProposalRow,
} from "@/lib/cr/queries"
import { simNow } from "@/lib/cr/clock"
import {
  LOCKED_ACTIONS, type ActionType, type Audience, type AutonomyLevel, type CaseKind, type CaseStatus, type DecisionRequest,
  type DecisionResponse, type DraftMessage, type HandoverPacket, type ProposalChange, type ProposalOption, type SourceRef,
} from "@/lib/cr/types"
import { AGENT_ID } from "./config"
import { activeDriverId, loadOrderFacts, type OrderFacts } from "./context"

// ---------------------------------------------------------------- tool policy

export type ToolName =
  | "get_order_context" | "get_timeline" | "get_telemetry" | "get_active_codes" | "lookup_trouble_code" | "lookup_warning_light"
  | "analyse_photo" | "find_nearby_help" | "search_travel_options" | "read_playbook"
  | "message_driver" | "request_photo" | "safety_instruction" | "ask_site"
  | "update_case" | "hand_over" | "propose_action" | "escalate" | "close_case"

/** Which audiences may use each tool. Anything not listed is refused. */
export const TOOL_AUDIENCES: Record<ToolName, readonly Audience[]> = {
  get_order_context: ["driver", "site", "operator"],
  get_timeline: ["operator"],
  get_telemetry: ["driver", "operator"],
  get_active_codes: ["driver", "operator"],
  lookup_trouble_code: ["driver", "operator"],
  lookup_warning_light: ["driver", "operator"],
  analyse_photo: ["driver", "operator"],
  find_nearby_help: ["driver", "operator"],
  search_travel_options: ["operator"],
  read_playbook: ["driver", "site", "operator"],
  message_driver: ["operator"],
  request_photo: ["driver", "operator"],
  safety_instruction: ["driver", "operator"],
  ask_site: ["operator"],
  update_case: ["driver", "operator"],
  hand_over: ["driver", "site"],
  propose_action: ["operator"],
  escalate: ["operator"],
  close_case: ["driver", "operator"],
}

/** Cases that always end with a person, never closed by the agent alone. */
const SERIOUS_KINDS: readonly CaseKind[] = ["VEHICLE_WARNING", "BREAKDOWN", "ACCIDENT", "DELAY", "MISSED_CONNECTION"]

export type GateVerdict = { ok: true } | { ok: false; reason: string }

export type GateContext = {
  audience: Audience
  caseRow: CaseRow
  facts: OrderFacts
  /** The operator's "Ask the agent" box: answers only, never changes or sends anything. */
  readOnly?: boolean
}

const READ_TOOLS: readonly ToolName[] = [
  "get_order_context", "get_timeline", "get_telemetry", "get_active_codes", "lookup_trouble_code", "lookup_warning_light",
  "analyse_photo", "find_nearby_help", "search_travel_options", "read_playbook",
]

export function checkTool(ctx: GateContext, name: string, input: Record<string, unknown>): GateVerdict {
  const allowed = TOOL_AUDIENCES[name as ToolName]
  if (!allowed) return { ok: false, reason: `There is no tool called ${name}.` }
  if (!allowed.includes(ctx.audience)) return { ok: false, reason: `${name} is not available when talking to a ${ctx.audience}.` }
  if (ctx.readOnly && !READ_TOOLS.includes(name as ToolName)) return { ok: false, reason: "The Ask box only answers questions; it does not change or send anything." }

  const orderRef = typeof input.order_ref === "string" ? input.order_ref.trim().toUpperCase() : ""
  if (orderRef && ctx.audience !== "operator" && orderRef !== ctx.facts.reference) {
    return { ok: false, reason: `This conversation is about ${ctx.facts.reference} only.` }
  }

  if (name === "ask_site") {
    const end = input.end === "delivery" ? ctx.facts.delivery : ctx.facts.pickup
    if (end.customerSide) {
      return { ok: false, reason: `The ${end.end} site belongs to the customer. Draft a CONTACT_SITE_AS_CUSTOMER proposal instead; a person approves it.` }
    }
  }

  if (name === "safety_instruction" && typeof input.text === "string") {
    const clearance = findClearance(input.text)
    if (clearance) return { ok: false, reason: `A safety instruction cannot clear the driver to drive ("${clearance}"). Clearing needs a CLEAR_TO_CONTINUE proposal.` }
  }

  if (name === "close_case") {
    if (SERIOUS_KINDS.includes(ctx.caseRow.kind)) {
      return { ok: false, reason: "This kind of case ends with a person's decision. Hand it over or propose an action instead." }
    }
  }

  return { ok: true }
}

// ---------------------------------------------------------------- drive-on clearance

const CLEARANCE = /\b(you can|you may|you could|you(?:'re| are) (?:fine|ok|okay|good|clear|cleared) to|it(?:'s| is) (?:safe|fine|ok|okay) to|(?:ok|okay|safe|fine) to|feel free to|go ahead and|cleared to)\b[^.!?\n]{0,40}?\b(drive|driving|continue|carry on|keep going|move the car|restart|go on)\b/gi
const NEGATED = /\b(not|n't|never|no one|nobody|cannot|can't)\s+(?:\w+\s+){0,2}$/i
const CONDITIONAL = /\b(until|unless|whether|if|once|before|after|when|decides?|confirms?)\b[^.!?\n]{0,40}$/i

/**
 * Finds text that tells a driver they may drive on. Negations ("it is not
 * safe to drive") and conditions ("until an operator confirms you can
 * drive") do not count. Returns the offending phrase, or null.
 */
export function findClearance(text: string): string | null {
  for (const match of text.matchAll(CLEARANCE)) {
    const before = text.slice(Math.max(0, (match.index ?? 0) - 50), match.index)
    if (NEGATED.test(before) || CONDITIONAL.test(before)) continue
    return match[0]
  }
  return null
}

// ---------------------------------------------------------------- proposals

export type ProposalInput = {
  action_type: ActionType
  title: string
  rationale: string
  handover: HandoverPacket
  changes: ProposalChange[]
  draft_message: { to: "customer" | "pickup_site" | "delivery_site" | "driver"; channel: DraftMessage["channel"]; subject: string; body: string; language: string } | null
  options: ProposalOption[]
  evidence_refs: SourceRef[]
  next_step_if_approved: string
  next_step_if_rejected: string
}

/** True when a draft would reach the paying customer or a site that belongs to them. */
export function draftReachesCustomer(draft: DraftMessage | null | undefined, facts: OrderFacts): boolean {
  if (!draft) return false
  if (draft.to_type === "customer") return true
  if (draft.to_type !== "site") return false
  return [facts.pickup, facts.delivery].some((endpoint) => endpoint.customerSide
    && (draft.to_id === String(endpoint.site?.id ?? "") || draft.to_id === `${endpoint.end}:${String(endpoint.address.id)}`))
}

/** Fills in who a draft goes to from the records, so the model cannot address the wrong party. */
export function resolveDraft(draft: ProposalInput["draft_message"], facts: OrderFacts): DraftMessage | null {
  if (!draft) return null
  const base = { channel: draft.channel, subject: draft.subject || null, body: draft.body, language: draft.language || null }
  if (draft.to === "customer") return { ...base, to_type: "customer", to_id: facts.customer.id, to_name: facts.customer.name }
  if (draft.to === "driver") {
    const driverId = activeDriverId(facts)
    return { ...base, to_type: "driver", to_id: driverId ?? "", to_name: (driverId && facts.driverNames.get(driverId)) || "the driver", channel: "app_chat" }
  }
  const endpoint = draft.to === "pickup_site" ? facts.pickup : facts.delivery
  const name = String(endpoint.site?.name ?? endpoint.address.name ?? "the site")
  const id = endpoint.site ? String(endpoint.site.id) : `${endpoint.end}:${String(endpoint.address.id)}`
  return { ...base, to_type: "site", to_id: id, to_name: name }
}

export function validateProposal(input: ProposalInput, facts: OrderFacts): GateVerdict {
  if (!input.title.trim() || !input.rationale.trim()) return { ok: false, reason: "A proposal needs a title and a rationale." }
  const draft = input.draft_message
  if (input.action_type === "CONTACT_CUSTOMER" && draft?.to !== "customer") {
    return { ok: false, reason: "CONTACT_CUSTOMER needs a draft message to the customer." }
  }
  if (input.action_type === "CONTACT_SITE_AS_CUSTOMER") {
    if (!draft || draft.to === "customer" || draft.to === "driver") return { ok: false, reason: "CONTACT_SITE_AS_CUSTOMER needs a draft message to a site." }
    const endpoint = draft.to === "pickup_site" ? facts.pickup : facts.delivery
    if (!endpoint.customerSide) return { ok: false, reason: "That site is not the customer's; ask it directly with ask_site." }
  }
  if (draft?.to === "driver") {
    if (input.action_type !== "CLEAR_TO_CONTINUE") return { ok: false, reason: "Message the driver directly with message_driver; drafts to the driver are only for CLEAR_TO_CONTINUE." }
    if (!activeDriverId(facts)) return { ok: false, reason: "There is no driver on this order." }
  }
  if (input.options.length > 0 && new Set(input.options.map((option) => option.id)).size !== input.options.length) {
    return { ok: false, reason: "Option ids must be unique." }
  }
  return { ok: true }
}

/**
 * The autonomy level that applies to one proposal. Customer contact, and any
 * proposal whose draft would reach the customer, is always ASK_FIRST.
 */
export async function effectiveLevel(actionType: ActionType, draft: DraftMessage | null, facts: OrderFacts): Promise<AutonomyLevel> {
  if (LOCKED_ACTIONS.includes(actionType) || actionType === "OPERATOR_DECISION") return "ASK_FIRST"
  if (draftReachesCustomer(draft, facts)) return "ASK_FIRST"
  return getAutonomy(actionType)
}

export class ApprovalRequiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ApprovalRequiredError"
  }
}

export class DecisionError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = "DecisionError"
  }
}

/** Record a proposal. At ASK_FIRST it waits for a person; at a higher level the agent carries it out and says so. */
export async function submitProposal(ctx: GateContext, input: ProposalInput): Promise<{ proposal: ProposalRow; level: AutonomyLevel; executed: boolean }> {
  const draft = resolveDraft(input.draft_message, ctx.facts)
  const level = await effectiveLevel(input.action_type, draft, ctx.facts)
  const proposal = await createProposal({
    caseId: ctx.caseRow.id,
    orderId: ctx.facts.id,
    actionType: input.action_type,
    title: input.title.trim(),
    rationale: input.rationale.trim(),
    handover: input.handover,
    changes: input.changes,
    draftMessage: draft,
    evidenceRefs: input.evidence_refs,
    options: input.options,
    nextStepIfApproved: input.next_step_if_approved,
    nextStepIfRejected: input.next_step_if_rejected,
    createdBy: AGENT_ID,
  })
  await appendEvent({
    caseId: ctx.caseRow.id, orderId: ctx.facts.id, actorType: "agent", actorId: AGENT_ID, kind: "proposal", channel: "internal",
    body: level === "ASK_FIRST" ? `Asked operations to decide: ${proposal.title}` : `Acting under ${level === "AUTO" ? "automatic" : "act-and-tell"} permission: ${proposal.title}`,
    data: { proposal_id: proposal.id, action_type: proposal.actionType, autonomy_level: level },
    sourceRefs: input.evidence_refs,
  })
  if (level === "ASK_FIRST") {
    await updateCase(ctx.caseRow.id, { status: "NEEDS_DECISION", owner: null, nextStep: `Waiting for an operator to decide: ${proposal.title}` })
    return { proposal, level, executed: false }
  }
  const executed = await executeProposal(proposal.id, { by: AGENT_ID })
  return { proposal: executed, level, executed: true }
}

const HOUR = 3600000

/** Where a case stands once a proposal of this type has been carried out, and when we look again. */
function caseAfter(proposal: ProposalRow, draft: DraftMessage | null): { status: CaseStatus; waitingOn: string | null; checkInMs: number | null } {
  switch (proposal.actionType) {
    case "CONTACT_CUSTOMER":
    case "CONTACT_SITE_AS_CUSTOMER":
      return { status: "WAITING_EXTERNAL", waitingOn: `${draft?.to_name ?? "the customer"}'s answer`, checkInMs: HOUR / 2 }
    case "BOOK_RECOVERY":
      return { status: "WAITING_EXTERNAL", waitingOn: "the recovery provider", checkInMs: HOUR }
    case "REASSIGN_DRIVER":
      return { status: "WAITING_EXTERNAL", waitingOn: "dispatch", checkInMs: HOUR }
    case "APPROVE_EXPENSE":
    case "CLEAR_TO_CONTINUE":
      return { status: "RESOLVED", waitingOn: null, checkInMs: null }
    default:
      return { status: "AGENT_WORKING", waitingOn: null, checkInMs: null }
  }
}

function changeLines(changes: ProposalChange[]): string {
  return changes.map((change) => `${change.label}: ${change.before ? `${change.before} → ` : ""}${change.after}`).join("; ")
}

function mockReference(actionType: ActionType): string {
  const prefix = actionType === "BOOK_RECOVERY" ? "RCV" : "TRV"
  return `${prefix}-SIM-${randomUUID().slice(0, 6).toUpperCase()}`
}

/** What a carried-out action did, in words, per action type (PLAN.md 4.2b). All simulated. */
function effectText(proposal: ProposalRow, chosenLabel: string | null, reference: string | null): string {
  const changes = changeLines(proposal.changes)
  const choice = chosenLabel ? ` (${chosenLabel})` : ""
  switch (proposal.actionType) {
    case "BOOK_RECOVERY":
    case "BOOK_TRAVEL":
      return `Booked${choice}: ${proposal.title}. Reference ${reference} (simulated booking; the earlier quote stays a quote).${changes ? ` ${changes}.` : ""}`
    case "UPDATE_ETA":
    case "CHANGE_PROMISE":
      return `Recorded as the Road Desk's own ${proposal.actionType === "UPDATE_ETA" ? "ETA" : "promise"}, beside the original record (the dataset is unchanged). ${changes}`
    case "APPROVE_EXPENSE":
      return `Expense approved${choice}. Approved is not paid. ${changes}`.trim()
    case "REASSIGN_DRIVER":
      return `Handed to dispatch to find another driver${choice}. ${changes}`.trim()
    case "OPERATOR_DECISION":
      return `Operator chose${choice || ": go ahead"}. The agent continues from here.`
    default:
      return `${proposal.title}${choice}.${changes ? ` ${changes}.` : ""} Simulated, nothing real changed.`
  }
}

/**
 * Carry out a proposal. This is the only place a proposal's effect is
 * recorded. It refuses unless a person approved it, or the agent itself acts
 * at an autonomy level above ASK_FIRST for a type that is not locked.
 * Effects are simulated: nothing real is sent or booked.
 */
export async function executeProposal(proposalId: string, options: { by: string; outcome?: string | null }): Promise<ProposalRow> {
  const proposal = await getProposal(proposalId)
  if (!proposal) throw new Error("Proposal not found")
  const approved = proposal.status === "APPROVED" || proposal.status === "EDITED_AND_APPROVED"
  if (!approved) {
    if (proposal.status !== "PENDING" || options.by !== AGENT_ID) {
      throw new ApprovalRequiredError(`Proposal is ${proposal.status.toLowerCase().replace(/_/g, " ")}; it cannot be carried out.`)
    }
    const caseRow = await getCase(proposal.caseId)
    const facts = caseRow ? await loadOrderFacts(caseRow.orderId) : null
    if (!facts) throw new Error("Order not found")
    if ((await effectiveLevel(proposal.actionType, proposal.draftMessage, facts)) === "ASK_FIRST") {
      throw new ApprovalRequiredError(`${proposal.actionType} needs a person's approval before it can be carried out.`)
    }
  }

  const draft = proposal.editedDraftMessage ?? proposal.draftMessage
  const actor = approved ? { type: "operator" as const, id: proposal.decidedBy } : { type: "agent" as const, id: AGENT_ID }
  const chosen = proposal.options.find((option) => option.id === proposal.chosenOptionId) ?? null
  const reference = proposal.actionType === "BOOK_RECOVERY" || proposal.actionType === "BOOK_TRAVEL" ? mockReference(proposal.actionType) : null
  const effectIds: string[] = []

  if (options.outcome) {
    // "I'll handle it": the person did it outside the system and logged what happened.
    const event = await appendEvent({
      caseId: proposal.caseId, orderId: proposal.orderId, actorType: "operator", actorId: options.by, kind: "effect", channel: "internal",
      body: `Done by ${options.by === proposal.decidedBy ? "the operator" : options.by}: ${proposal.title}. Outcome: ${options.outcome}`,
      data: { proposal_id: proposal.id, outcome: options.outcome, handled_outside: true },
    })
    effectIds.push(event.id)
  } else {
    if (draft) {
      const toDriver = draft.to_type === "driver"
      const event = await appendEvent({
        caseId: proposal.caseId, orderId: proposal.orderId, actorType: actor.type, actorId: actor.id, kind: toDriver ? "message" : "effect",
        channel: toDriver ? "driver_chat" : draft.to_type === "customer" ? "customer_email" : "site_chat",
        recipientType: toDriver ? "driver" : draft.to_type === "customer" ? "customer" : "site", recipientId: draft.to_id,
        body: toDriver ? draft.body : draft.channel === "phone_call" ? `Call ${draft.to_name}. Talking points: ${draft.body}` : `Sent to ${draft.to_name} (simulated): ${draft.body}`,
        data: { proposal_id: proposal.id, simulated: true, channel: draft.channel, subject: draft.subject ?? null, edited: Boolean(proposal.editedDraftMessage), approved_by: proposal.decidedBy },
      })
      effectIds.push(event.id)
    }
    if (!draft || proposal.changes.length > 0 || reference) {
      const event = await appendEvent({
        caseId: proposal.caseId, orderId: proposal.orderId, actorType: actor.type, actorId: actor.id, kind: "effect", channel: "internal",
        body: effectText(proposal, chosen?.label ?? null, reference),
        data: { proposal_id: proposal.id, simulated: true, changes: proposal.changes, option_id: proposal.chosenOptionId, reference },
      })
      effectIds.push(event.id)
    }
  }

  const done = await transitionProposal(proposal.id, ["APPROVED", "EDITED_AND_APPROVED", "PENDING"], {
    status: "EXECUTED", executedAt: simNow(),
    execution: { effect_event_ids: effectIds, simulated: true, by: options.by, reference, outcome: options.outcome ?? null },
  })
  if (!done) throw new Error("The proposal changed while it was being carried out.")

  const after = options.outcome ? { status: "AGENT_WORKING" as CaseStatus, waitingOn: null, checkInMs: null } : caseAfter(proposal, draft)
  const stillPending = (await listProposals({ caseId: proposal.caseId, statuses: ["PENDING"] })).length > 0
  await updateCase(proposal.caseId, {
    status: stillPending ? "NEEDS_DECISION" : after.status,
    waitingOn: after.waitingOn,
    nextStep: proposal.nextStepIfApproved,
    nextCheckAt: after.checkInMs ? new Date(simNow().getTime() + after.checkInMs) : null,
    owner: after.status === "AGENT_WORKING" || after.status === "RESOLVED" ? "agent" : proposal.decidedBy ?? null,
  })
  return done
}

export type FollowUpKind = "approved" | "rejected" | "instructed" | "outcome"

export type DecisionOutcome = DecisionResponse & {
  followUp: { kind: FollowUpKind; proposal: ProposalRow; caseRow: CaseRow; text: string | null } | null
}

async function pendingLeft(caseId: string): Promise<boolean> {
  return (await listProposals({ caseId, statuses: ["PENDING"] })).length > 0
}

/** An operator's decision on a card: approve (with an edited draft or a chosen option), reject, handle it themselves, or instruct the agent. */
export async function decideProposal(caseId: string, proposalId: string, request: DecisionRequest): Promise<DecisionOutcome> {
  const proposal = await getProposal(proposalId)
  if (!proposal || proposal.caseId !== caseId) throw new DecisionError(404, "This decision is not on this case.")
  if (proposal.status !== "PENDING") throw new DecisionError(409, `This was already decided (${proposal.status.toLowerCase().replace(/_/g, " ")}).`)
  const by = request.decided_by?.trim()
  if (!by) throw new DecisionError(400, "Say who is deciding.")
  const note = request.note?.trim() || null
  const now = simNow()

  if (request.decision === "reject" || request.decision === "instruct") {
    const instructing = request.decision === "instruct"
    if (!note) throw new DecisionError(400, instructing ? "Write the instruction for the agent." : "Give a short reason so the agent can try something else.")
    const nextStep = instructing ? `The agent follows the instruction: ${note}` : proposal.nextStepIfRejected
    const updated = await transitionProposal(proposal.id, ["PENDING"], { status: "REJECTED", decidedBy: by, decidedAt: now, decisionNote: note, nextStep })
    if (!updated) throw new DecisionError(409, "Someone else decided this first.")
    await appendEvent({
      caseId, orderId: proposal.orderId, actorType: "operator", actorId: by, kind: "decision", channel: "internal",
      body: instructing ? `Set aside "${proposal.title}" and told the agent: ${note}` : `Rejected "${proposal.title}". Reason: ${note}`,
      data: { proposal_id: proposal.id, decision: request.decision },
    })
    const caseRow = await updateCase(caseId, { status: (await pendingLeft(caseId)) ? "NEEDS_DECISION" : "AGENT_WORKING", owner: "agent", nextStep, waitingOn: null })
    return {
      proposal_id: proposal.id, status: "REJECTED", next_step: nextStep, case_status: caseRow!.status,
      followUp: { kind: instructing ? "instructed" : "rejected", proposal: updated, caseRow: caseRow!, text: note },
    }
  }

  const option = request.option_id
    ? proposal.options.find((entry) => entry.id === request.option_id)
    : proposal.options.find((entry) => entry.recommended) ?? null
  if (request.option_id && !option) throw new DecisionError(400, "That option is not on this card.")
  const edited = request.edited_draft_message ?? null
  if (edited && proposal.draftMessage && (edited.to_type !== proposal.draftMessage.to_type || edited.to_id !== proposal.draftMessage.to_id)) {
    throw new DecisionError(400, "An edit can change the message, not who it goes to.")
  }

  if (request.decision === "handle") {
    const nextStep = `${by} does this outside the system, then logs what happened.`
    const updated = await transitionProposal(proposal.id, ["PENDING"], {
      status: edited ? "EDITED_AND_APPROVED" : "APPROVED", decidedBy: by, decidedAt: now, decisionNote: note,
      chosenOptionId: option?.id ?? null, editedDraftMessage: edited, nextStep,
    })
    if (!updated) throw new DecisionError(409, "Someone else decided this first.")
    await appendEvent({
      caseId, orderId: proposal.orderId, actorType: "operator", actorId: by, kind: "decision", channel: "internal",
      body: `Will handle it personally: "${proposal.title}"${option ? ` (${option.label})` : ""}.`,
      data: { proposal_id: proposal.id, decision: "handle", option_id: option?.id ?? null },
    })
    const caseRow = await updateCase(caseId, {
      status: (await pendingLeft(caseId)) ? "NEEDS_DECISION" : "WAITING_EXTERNAL", owner: by, waitingOn: `${by} to log what happened`, nextStep,
      nextCheckAt: new Date(now.getTime() + HOUR / 2),
    })
    return { proposal_id: proposal.id, status: updated.status, next_step: nextStep, case_status: caseRow!.status, followUp: null }
  }

  const updated = await transitionProposal(proposal.id, ["PENDING"], {
    status: edited ? "EDITED_AND_APPROVED" : "APPROVED", decidedBy: by, decidedAt: now, decisionNote: note,
    chosenOptionId: option?.id ?? null, editedDraftMessage: edited, nextStep: proposal.nextStepIfApproved,
  })
  if (!updated) throw new DecisionError(409, "Someone else decided this first.")
  await appendEvent({
    caseId, orderId: proposal.orderId, actorType: "operator", actorId: by, kind: "decision", channel: "internal",
    body: `Approved "${proposal.title}"${option ? `, choosing: ${option.label}` : ""}${edited ? ", with an edited message" : ""}.${note ? ` Note: ${note}` : ""}`,
    data: { proposal_id: proposal.id, decision: "approve", option_id: option?.id ?? null, edited: Boolean(edited) },
  })
  const executed = await executeProposal(proposal.id, { by })
  const caseRow = await getCase(caseId)
  return {
    proposal_id: proposal.id, status: executed.status, next_step: proposal.nextStepIfApproved, case_status: caseRow!.status,
    followUp: { kind: "approved", proposal: executed, caseRow: caseRow!, text: note },
  }
}

/**
 * "Facts changed since this was drafted": set the card aside and let the
 * agent draft a fresh one. Only allowed when something new really came in.
 */
export async function refreshProposal(caseId: string, proposalId: string, by: string): Promise<DecisionResponse> {
  const proposal = await getProposal(proposalId)
  if (!proposal || proposal.caseId !== caseId) throw new DecisionError(404, "This decision is not on this case.")
  if (proposal.status !== "PENDING") throw new DecisionError(409, `This was already decided (${proposal.status.toLowerCase().replace(/_/g, " ")}).`)
  if (!by?.trim()) throw new DecisionError(400, "Say who is asking for the refresh.")
  const changed = await proposalsWithChangedFacts(caseId)
  if (!changed.some((entry) => entry.proposalId === proposalId)) throw new DecisionError(409, "Nothing new has come in since this card was drafted.")
  const nextStep = "The agent drafts a fresh card with the new facts."
  const updated = await transitionProposal(proposal.id, ["PENDING"], {
    status: "REJECTED", decidedBy: by.trim(), decidedAt: simNow(), decisionNote: "Set aside: facts changed since it was drafted.", nextStep,
  })
  if (!updated) throw new DecisionError(409, "Someone else decided this first.")
  await appendEvent({
    caseId, orderId: proposal.orderId, actorType: "operator", actorId: by.trim(), kind: "decision", channel: "internal",
    body: `Asked for a fresh card: facts changed since "${proposal.title}" was drafted.`, data: { proposal_id: proposal.id, decision: "refresh" },
  })
  const caseRow = await updateCase(caseId, { status: (await pendingLeft(caseId)) ? "NEEDS_DECISION" : "AGENT_WORKING", owner: "agent", nextStep, waitingOn: null })
  return { proposal_id: proposal.id, status: "REJECTED", next_step: nextStep, case_status: caseRow!.status }
}

/** "Log what happened" after "I'll handle it": records the outcome and lets the agent continue. */
export async function logOutcome(caseId: string, input: { text: string; logged_by: string; proposal_id?: string | null }): Promise<DecisionOutcome> {
  const text = input.text?.trim()
  const by = input.logged_by?.trim()
  if (!text) throw new DecisionError(400, "Write one line on what happened.")
  if (!by) throw new DecisionError(400, "Say who is logging this.")
  const waiting = (await listProposals({ caseId, statuses: ["APPROVED", "EDITED_AND_APPROVED"] }))
  const proposal = input.proposal_id ? waiting.find((row) => row.id === input.proposal_id) : waiting.at(-1)
  if (!proposal) {
    // An outcome with no card waiting is still useful: record it and let the agent continue.
    const caseRow = await getCase(caseId)
    if (!caseRow) throw new DecisionError(404, "Case not found.")
    await appendEvent({ caseId, orderId: caseRow.orderId, actorType: "operator", actorId: by, kind: "note", channel: "internal", body: `Logged: ${text}` })
    const updated = await updateCase(caseId, { status: "AGENT_WORKING", owner: "agent", waitingOn: null, nextStep: "The agent continues from the logged outcome." })
    return { proposal_id: "", status: "EXECUTED", next_step: updated!.nextStep ?? "", case_status: updated!.status, followUp: null }
  }
  const executed = await executeProposal(proposal.id, { by, outcome: text })
  const caseRow = await updateCase(caseId, { owner: "agent", nextStep: "The agent continues from the logged outcome." })
  return {
    proposal_id: proposal.id, status: executed.status, next_step: caseRow!.nextStep ?? "", case_status: caseRow!.status,
    followUp: { kind: "outcome", proposal: executed, caseRow: caseRow!, text },
  }
}
