// The approval gate. Every tool call the agent makes passes through here, and
// so does every proposal and every decision on one. The rules from the brief
// live in code, not only in the prompt:
//
// 1. The agent never contacts a customer on its own. Customer contact is
//    always a proposal a person approves, whatever the autonomy settings say.
// 2. Nothing changes without approval unless an operator raised that action
//    type's autonomy level, and customer contact can never be raised.
// 3. Drivers and sites only reach their own order.
// 4. The agent may tell a driver to stop, never that it is fine to drive on
//    (safety instructions come from fixed templates; see drivability.ts).
// 5. An approval is bound to the revision the operator saw, rechecked against
//    the current facts, and executed at most once.

import {
  appendEvent, claimExecution, createProposal, getAutonomy, getCase, getEffect, getProposal, insertEffect, listEffects, listProposals,
  proposalsWithChangedFacts, transitionProposal, updateCase, type CaseRow, type EffectRow, type ProposalRow,
} from "@/lib/cr/queries"
import { simNow } from "@/lib/cr/clock"
import { checkAssumptions } from "@/lib/cr/effective"
import {
  LOCKED_ACTIONS, type ActionType, type Assumption, type AssumptionCheck, type Audience, type AutonomyLevel, type CaseKind,
  type CaseStatus, type CustomerAnswerRequest, type DecisionRequest, type DecisionResponse, type DraftMessage, type EffectAuthority,
  type EffectKind, type EffectState, type HandoverPacket, type LogOutcomeRequest, type ProposalChange, type ProposalOption, type SourceRef,
  type WaitingFor,
} from "@/lib/cr/types"
import { AGENT_ID } from "./config"
import { activeDriverId, loadOrderFacts, type OrderFacts } from "./context"
import { SAFETY_TEMPLATES } from "./drivability"
import { mockProviderBook } from "./mocks"
import { operatorPhrase } from "./timeline"

// ---------------------------------------------------------------- tool policy

export type ToolName =
  | "get_order_context" | "get_timeline" | "get_telemetry" | "get_active_codes" | "lookup_trouble_code" | "lookup_warning_light"
  | "analyse_photo" | "find_nearby_help" | "search_travel_options" | "read_playbook"
  | "message_driver" | "request_photo" | "safety_instruction" | "ask_site"
  | "update_case" | "wait_for" | "hand_over" | "propose_action" | "escalate" | "close_case"

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
  wait_for: ["driver", "operator"],
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

  if (name === "safety_instruction" && !SAFETY_TEMPLATES.some((template) => template.id === input.template_id)) {
    return { ok: false, reason: "Safety instructions come only from the approved templates." }
  }

  if (name === "close_case") {
    if (SERIOUS_KINDS.includes(ctx.caseRow.kind)) {
      return { ok: false, reason: "This kind of case ends with a person's decision. Hand it over or propose an action instead." }
    }
  }

  return { ok: true }
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
  /** What the card relies on; rechecked before it executes. */
  assumptions: Assumption[]
  /** For UPDATE_ETA and CHANGE_PROMISE: the proposed window, UTC. */
  proposed_window: { start_utc: string; end_utc: string } | null
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
  if (input.action_type === "CHANGE_PROMISE") {
    if (!input.proposed_window) return { ok: false, reason: "CHANGE_PROMISE needs the proposed window." }
    if (draft?.to !== "customer") return { ok: false, reason: "CHANGE_PROMISE needs the message that asks the customer; the promise only changes when they agree." }
  }
  if (input.action_type === "UPDATE_ETA" && !input.proposed_window) return { ok: false, reason: "UPDATE_ETA needs the estimated window." }
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
  if (LOCKED_ACTIONS.includes(actionType) || actionType === "OPERATOR_DECISION" || actionType === "CHANGE_PROMISE") return "ASK_FIRST"
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

const MINUTE = 60000

function urgentCase(caseRow: CaseRow | null): boolean {
  return caseRow?.urgency === "CRITICAL" || caseRow?.urgency === "HIGH"
}

function later(minutes: number): Date {
  return new Date(simNow().getTime() + minutes * MINUTE)
}

/** Record a proposal. At ASK_FIRST it waits for a person; at a higher level the agent carries it out and says so. */
export async function submitProposal(ctx: GateContext, input: ProposalInput): Promise<{ proposal: ProposalRow; level: AutonomyLevel; executed: boolean }> {
  const draft = resolveDraft(input.draft_message, ctx.facts)
  const level = await effectiveLevel(input.action_type, draft, ctx.facts)
  // A redraft of an outdated card of the same kind continues its revisions.
  const outdated = (await listProposals({ caseId: ctx.caseRow.id, statuses: ["OUTDATED"] })).filter((row) => row.actionType === input.action_type)
  const redrafted = new Set((await listProposals({ caseId: ctx.caseRow.id })).map((row) => row.revisesProposalId).filter(Boolean))
  const previous = outdated.filter((row) => !redrafted.has(row.id)).at(-1)
  const changes = input.proposed_window
    ? input.changes.map((change, index) => (index === 0 ? { ...change, value: input.proposed_window } : change))
    : input.changes
  const proposal = await createProposal({
    caseId: ctx.caseRow.id,
    orderId: ctx.facts.id,
    revision: previous ? previous.revision + 1 : 1,
    revisesProposalId: previous?.id ?? null,
    actionType: input.action_type,
    title: input.title.trim(),
    rationale: input.rationale.trim(),
    handover: input.handover,
    changes: changes.length ? changes : input.proposed_window ? [{ label: input.action_type === "UPDATE_ETA" ? "ETA" : "Delivery promise", before: null, after: `${input.proposed_window.start_utc} – ${input.proposed_window.end_utc} UTC`, value: input.proposed_window }] : [],
    draftMessage: draft,
    evidenceRefs: input.evidence_refs,
    assumptions: input.assumptions ?? [],
    options: input.options,
    nextStepIfApproved: input.next_step_if_approved,
    nextStepIfRejected: input.next_step_if_rejected,
    createdBy: AGENT_ID,
  })
  await appendEvent({
    caseId: ctx.caseRow.id, orderId: ctx.facts.id, actorType: "agent", actorId: AGENT_ID, kind: "proposal", channel: "internal",
    body: level === "ASK_FIRST"
      ? `Asked operations to decide: ${proposal.title}${proposal.revision > 1 ? ` (revision ${proposal.revision})` : ""}`
      : `Acting under ${level === "AUTO" ? "automatic" : "act-and-tell"} permission: ${proposal.title}`,
    data: { proposal_id: proposal.id, action_type: proposal.actionType, autonomy_level: level, revision: proposal.revision },
    sourceRefs: input.evidence_refs,
  })
  if (level === "ASK_FIRST") {
    await updateCase(ctx.caseRow.id, {
      status: "NEEDS_DECISION", owner: null, waitingOn: "an operator's decision", waitingFor: "operator",
      nextAction: `An operator decides: ${proposal.title}`, nextCheckAt: later(urgentCase(ctx.caseRow) ? 5 : 15),
    })
    return { proposal, level, executed: false }
  }
  const executed = await executeProposal(proposal.id, { by: AGENT_ID })
  return { proposal: executed, level, executed: executed.status === "EXECUTED" }
}

// ---------------------------------------------------------------- execution

type Actor = { id: string; type: "operator" | "agent" }

async function authorityFor(proposal: ProposalRow, actor: Actor, basis?: string): Promise<EffectAuthority> {
  const who = actor.type === "agent" ? "the agent under its autonomy setting" : await operatorPhrase(actor.id)
  return {
    by: actor.id, by_type: actor.type, at: simNow().toISOString(), proposal_id: proposal.id, revision: proposal.revision,
    basis: basis ?? (actor.type === "agent" ? `Carried out by ${who}` : `Approved by ${who} on the decision card (revision ${proposal.revision})`),
  }
}

async function effect(proposal: ProposalRow, kind: EffectKind, state: EffectState, value: Record<string, unknown>, authority: EffectAuthority, target: Record<string, unknown> = {}, supersedesId: string | null = null): Promise<EffectRow> {
  return insertEffect({
    orderId: proposal.orderId, caseId: proposal.caseId, proposalId: proposal.id, kind, state, value, target, authority,
    evidenceRefs: proposal.evidenceRefs, supersedesId,
  })
}

function windowOf(proposal: ProposalRow): { start_utc: string | null; end_utc: string | null; text: string } {
  const change = proposal.changes.find((entry) => entry.value) ?? proposal.changes[0]
  const value = (change?.value ?? {}) as { start_utc?: string; end_utc?: string }
  return { start_utc: value.start_utc ?? null, end_utc: value.end_utc ?? null, text: change ? `${change.label}: ${change.after}` : proposal.title }
}

type CaseAfter = { status: CaseStatus; waitingOn: string | null; waitingFor: WaitingFor | null; nextAction: string; checkInMinutes: number | null }

/** Carry out the action's effects (all simulated). Returns where the case stands, or an unknown outcome. */
async function performEffects(proposal: ProposalRow, actor: Actor): Promise<{ after: CaseAfter; result: Record<string, unknown>; unknown?: string }> {
  const authority = await authorityFor(proposal, actor)
  const draft = proposal.editedDraftMessage ?? proposal.draftMessage
  const chosen = proposal.options.find((option) => option.id === proposal.chosenOptionId) ?? null
  const ids: string[] = []
  const note = async (body: string, data: Record<string, unknown> = {}, extra: Partial<Parameters<typeof appendEvent>[0]> = {}) => {
    const event = await appendEvent({
      caseId: proposal.caseId, orderId: proposal.orderId, actorType: actor.type, actorId: actor.id, kind: "effect", channel: "internal",
      body, data: { proposal_id: proposal.id, simulated: true, ...data }, ...extra,
    })
    ids.push(event.id)
  }
  const sendDraft = async () => {
    if (!draft) return
    const sent = await effect(proposal, "MESSAGE_SENT", "RECORDED", { to_type: draft.to_type, to_id: draft.to_id, to_name: draft.to_name, channel: draft.channel, subject: draft.subject ?? null, body: draft.body, edited: Boolean(proposal.editedDraftMessage) }, authority, { to_type: draft.to_type, to_id: draft.to_id })
    const toDriver = draft.to_type === "driver"
    await note(toDriver ? draft.body : `Sent to ${draft.to_name} (simulated): ${draft.body}`, { effect_id: sent.id, channel: draft.channel }, {
      kind: toDriver ? "message" : "effect", channel: toDriver ? "driver_chat" : draft.to_type === "customer" ? "customer_email" : "site_chat",
      recipientType: toDriver ? "driver" : draft.to_type === "customer" ? "customer" : "site", recipientId: draft.to_id,
    })
  }
  const next = proposal.nextStepIfApproved
  switch (proposal.actionType) {
    case "CONTACT_CUSTOMER":
    case "CONTACT_SITE_AS_CUSTOMER":
      await sendDraft()
      return { after: { status: "WAITING_EXTERNAL", waitingOn: `${draft?.to_name ?? "the customer"}'s answer`, waitingFor: "customer", nextAction: next, checkInMinutes: 30 }, result: { event_ids: ids } }
    case "UPDATE_ETA": {
      const window = windowOf(proposal)
      const eta = await effect(proposal, "ETA_ESTIMATE", "RECORDED", { text: window.text, estimate_utc: window.end_utc ?? window.start_utc, start_utc: window.start_utc, end_utc: window.end_utc, basis: proposal.rationale }, authority)
      await note(`Internal ETA estimate recorded (not a customer commitment): ${window.text}`, { effect_id: eta.id })
      return { after: { status: "AGENT_WORKING", waitingOn: "the agent", waitingFor: "agent", nextAction: next, checkInMinutes: 3 }, result: { event_ids: ids, effect_id: eta.id } }
    }
    case "CHANGE_PROMISE": {
      const window = windowOf(proposal)
      const proposed = await effect(proposal, "PROMISE_CHANGE", "PROPOSED_TO_CUSTOMER", { text: window.text, start_utc: window.start_utc, end_utc: window.end_utc }, authority, { field: "delivery_promise" })
      await sendDraft()
      await note(`New delivery date proposed to the customer: ${window.text}. The promise only changes when the customer agrees.`, { effect_id: proposed.id })
      return { after: { status: "WAITING_EXTERNAL", waitingOn: `${draft?.to_name ?? "the customer"}'s answer on the new date`, nextAction: "Record the customer's answer when it comes; until then the original promise stands.", waitingFor: "customer", checkInMinutes: 60 }, result: { event_ids: ids, effect_id: proposed.id } }
    }
    case "BOOK_RECOVERY":
    case "BOOK_TRAVEL": {
      const provider = chosen?.label ?? proposal.title
      const booking = mockProviderBook({ orderId: proposal.orderId, kind: proposal.actionType === "BOOK_RECOVERY" ? "recovery" : "travel", provider })
      const kind = proposal.actionType === "BOOK_RECOVERY" ? "recovery" : "travel"
      if (booking.status === "timeout") {
        const unconfirmed = await effect(proposal, "BOOKING", "UNCONFIRMED", { kind, provider, reference: booking.reference, requested_at: simNow().toISOString() }, authority)
        await note(`Booking request to ${provider} timed out without a confirmation (simulated). It may or may not exist. Reference requested: ${booking.reference}.`, { effect_id: unconfirmed.id, outcome: "unknown" })
        return {
          after: { status: "NEEDS_DECISION", waitingOn: "an operator to reconcile the booking", waitingFor: "operator", nextAction: `Check with ${provider} whether booking ${booking.reference} exists before anything is retried.`, checkInMinutes: 15 },
          result: { event_ids: ids, effect_id: unconfirmed.id, reference: booking.reference }, unknown: `Check with ${provider} whether booking ${booking.reference} exists`,
        }
      }
      const booked = await effect(proposal, "BOOKING", "RECORDED", { kind, provider, reference: booking.reference }, authority)
      await note(`Booked with ${provider}: reference ${booking.reference} (simulated booking; any earlier quote stays a quote).`, { effect_id: booked.id, reference: booking.reference })
      return { after: { status: kind === "recovery" ? "WAITING_EXTERNAL" : "AGENT_WORKING", waitingOn: kind === "recovery" ? "the recovery provider" : "the agent", waitingFor: kind === "recovery" ? "provider" : "agent", nextAction: next, checkInMinutes: kind === "recovery" ? 60 : 3 }, result: { event_ids: ids, effect_id: booked.id, reference: booking.reference } }
    }
    case "APPROVE_EXPENSE": {
      const expense = proposal.evidenceRefs.find((ref) => ref.kind === "expenses")
      const decision = await effect(proposal, "EXPENSE_DECISION", "RECORDED", { decision: "APPROVED", paid: false }, authority, expense ? { table: "expenses", id: expense.id } : {})
      await note("Expense approved. Approved is not paid.", { effect_id: decision.id })
      return { after: { status: "RESOLVED", waitingOn: null, waitingFor: null, nextAction: next, checkInMinutes: null }, result: { event_ids: ids, effect_id: decision.id } }
    }
    case "CLEAR_TO_CONTINUE": {
      const instruction = await effect(proposal, "DRIVER_INSTRUCTION", "RECORDED", { text: draft?.body ?? proposal.title, cleared_to_continue: true }, authority, { driver_id: draft?.to_id ?? null })
      if (draft) {
        // Attributed to the operator who approved it, never to the agent.
        const event = await appendEvent({
          caseId: proposal.caseId, orderId: proposal.orderId, actorType: "operator", actorId: proposal.decidedBy, kind: "message", channel: "driver_chat",
          recipientType: "driver", recipientId: draft.to_id, body: draft.body, data: { proposal_id: proposal.id, effect_id: instruction.id, cleared_to_continue: true },
        })
        ids.push(event.id)
      }
      return { after: { status: "RESOLVED", waitingOn: null, waitingFor: null, nextAction: next, checkInMinutes: null }, result: { event_ids: ids, effect_id: instruction.id } }
    }
    case "REASSIGN_DRIVER": {
      const handed = await effect(proposal, "OUTCOME_LOGGED", "RECORDED", { text: "Handed to dispatch to find another driver." }, authority)
      await note("Handed to dispatch to find another driver.", { effect_id: handed.id })
      return { after: { status: "WAITING_EXTERNAL", waitingOn: "dispatch", waitingFor: "dispatch", nextAction: next, checkInMinutes: 60 }, result: { event_ids: ids, effect_id: handed.id } }
    }
    default: {
      const choice = chosen ? `Operator chose: ${chosen.label}.` : "Operator said go ahead."
      const logged = await effect(proposal, "OUTCOME_LOGGED", "RECORDED", { text: choice, option_id: proposal.chosenOptionId }, authority)
      await note(`${choice} The agent continues from here.`, { effect_id: logged.id })
      return { after: { status: "AGENT_WORKING", waitingOn: "the agent", waitingFor: "agent", nextAction: next, checkInMinutes: 3 }, result: { event_ids: ids, effect_id: logged.id } }
    }
  }
}

async function finishCase(caseId: string, after: CaseAfter, owner: string | null) {
  const stillPending = (await listProposals({ caseId, statuses: ["PENDING"] })).length > 0
  await updateCase(caseId, stillPending
    ? { status: "NEEDS_DECISION", waitingOn: "an operator's decision", waitingFor: "operator", nextAction: "An operator decides on the next card.", nextCheckAt: later(15), owner: null }
    : { status: after.status, waitingOn: after.waitingOn, waitingFor: after.waitingFor, nextAction: after.nextAction, nextCheckAt: after.checkInMinutes ? later(after.checkInMinutes) : null, owner })
}

/** Mark a card OUTDATED: nothing runs; the case shows what changed and the agent redrafts. */
async function markOutdated(proposal: ProposalRow, checks: AssumptionCheck[]): Promise<ProposalRow> {
  const changed = checks.filter((check) => !check.holds)
  const updated = await transitionProposal(proposal.id, ["PENDING", "APPROVED", "EDITED_AND_APPROVED"], {
    status: "OUTDATED", executionResult: { outdated: changed }, nextStep: "The agent redrafts the card with the current facts.",
  })
  await appendEvent({
    caseId: proposal.caseId, orderId: proposal.orderId, actorType: "system", actorId: "gate", kind: "tool_call", channel: "internal",
    body: `Nothing was carried out: facts changed since "${proposal.title}" was drafted. ${changed.map((check) => `${check.assumption.label}: now ${check.now}`).join("; ")}.`,
    data: { proposal_id: proposal.id, outdated: true, checks: changed },
  })
  await updateCase(proposal.caseId, { status: "AGENT_WORKING", owner: "agent", waitingOn: "the agent", waitingFor: "agent", nextAction: "The agent redrafts the card with the current facts.", nextCheckAt: later(3) })
  return updated ?? proposal
}

/**
 * Carry out a proposal. The only place a proposal's effects are recorded. It
 * refuses unless a person approved this revision, or the agent acts at an
 * autonomy level above ASK_FIRST on a type that is not locked. It rechecks the
 * card's assumptions first (OUTDATED if one changed) and claims the execution
 * key, so a double click or a retry returns the first result.
 */
export async function executeProposal(proposalId: string, options: { by: string }): Promise<ProposalRow> {
  const proposal = await getProposal(proposalId)
  if (!proposal) throw new Error("Proposal not found")
  if (proposal.status === "EXECUTED" || proposal.status === "UNKNOWN_OUTCOME" || proposal.status === "OUTDATED") return proposal
  const approved = proposal.status === "APPROVED" || proposal.status === "EDITED_AND_APPROVED"
  if (approved && proposal.decidedRevision !== proposal.revision) throw new ApprovalRequiredError("The approval was for a different revision of this card.")
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

  const checks = await checkAssumptions(proposal.caseId, proposal.orderId, proposal.assumptions)
  if (checks.some((check) => !check.holds)) return markOutdated(proposal, checks)

  if (!(await claimExecution(proposal.id, `${proposal.id}:${proposal.revision}`))) return (await getProposal(proposal.id))!

  const actor: Actor = approved ? { id: proposal.decidedBy ?? options.by, type: "operator" } : { id: AGENT_ID, type: "agent" }
  const { after, result, unknown } = await performEffects(proposal, actor)
  const done = await transitionProposal(proposal.id, ["APPROVED", "EDITED_AND_APPROVED", "PENDING"], {
    status: unknown ? "UNKNOWN_OUTCOME" : "EXECUTED", executedAt: simNow(),
    executionResult: { ...result, simulated: true, by: actor.id, revision: proposal.revision, ...(unknown ? { reconcile: unknown } : {}) },
  })
  if (!done) throw new Error("The proposal changed while it was being carried out.")
  await finishCase(proposal.caseId, after, after.status === "AGENT_WORKING" || after.status === "RESOLVED" ? "agent" : unknown ? null : actor.type === "operator" ? actor.id : null)
  return done
}

// ---------------------------------------------------------------- decisions

export type FollowUpKind = "approved" | "rejected" | "instructed" | "outcome" | "outdated" | "customer_answer"

export type DecisionOutcome = DecisionResponse & {
  followUp: { kind: FollowUpKind; proposal: ProposalRow; caseRow: CaseRow; text: string | null } | null
}

async function pendingLeft(caseId: string): Promise<boolean> {
  return (await listProposals({ caseId, statuses: ["PENDING"] })).length > 0
}

async function response(proposal: ProposalRow, nextStep: string, followUp: DecisionOutcome["followUp"]): Promise<DecisionOutcome> {
  const caseRow = (await getCase(proposal.caseId))!
  return {
    proposal_id: proposal.id, status: proposal.status, next_step: nextStep, next_check_at: caseRow.nextCheckAt?.toISOString() ?? null,
    case_status: caseRow.status,
    ...(proposal.status === "OUTDATED" ? { outdated: (proposal.executionResult?.outdated as AssumptionCheck[] | undefined) ?? [] } : {}),
    followUp,
  }
}

const capitalise = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`

/**
 * An operator's decision on a card: approve (with an edited draft or a chosen
 * option), reject, "I'll handle it", or "Tell the agent instead". Approving a
 * card that is already carried out returns the first result.
 */
export async function decideProposal(caseId: string, proposalId: string, request: DecisionRequest): Promise<DecisionOutcome> {
  let proposal = await getProposal(proposalId)
  if (!proposal || proposal.caseId !== caseId) throw new DecisionError(404, "This decision is not on this case.")
  const by = request.decided_by?.trim()
  if (!by) throw new DecisionError(400, "Say who is deciding.")
  if (proposal.status !== "PENDING") {
    // A double click or a retried request: give back what already happened.
    if ((request.decision === "approve" || request.decision === "handle") && ["APPROVED", "EDITED_AND_APPROVED", "EXECUTED", "UNKNOWN_OUTCOME", "OUTDATED"].includes(proposal.status)) {
      return response(proposal, proposal.nextStep ?? proposal.nextStepIfApproved, null)
    }
    throw new DecisionError(409, `This was already decided (${proposal.status.toLowerCase().replace(/_/g, " ")}).`)
  }
  const note = request.note?.trim() || null
  const now = simNow()
  const who = await operatorPhrase(by)

  if (request.decision === "reject" || request.decision === "instruct") {
    const instructing = request.decision === "instruct"
    if (!note) throw new DecisionError(400, instructing ? "Write the instruction for the agent." : "Give a short reason so the agent can try something else.")
    const nextStep = instructing ? `The agent follows the instruction: ${note}` : proposal.nextStepIfRejected
    const updated = await transitionProposal(proposal.id, ["PENDING"], { status: "REJECTED", decidedBy: by, decidedAt: now, decidedRevision: proposal.revision, decisionNote: note, nextStep })
    if (!updated) throw new DecisionError(409, "Someone else decided this first.")
    await appendEvent({
      caseId, orderId: proposal.orderId, actorType: "operator", actorId: by, kind: "decision", channel: "internal",
      body: instructing ? `Set aside "${proposal.title}" and told the agent: ${note}` : `Rejected "${proposal.title}". Reason: ${note}`,
      data: { proposal_id: proposal.id, decision: request.decision },
    })
    const caseRow = await updateCase(caseId, (await pendingLeft(caseId))
      ? { status: "NEEDS_DECISION" }
      : { status: "AGENT_WORKING", owner: "agent", nextAction: nextStep, waitingOn: "the agent", waitingFor: "agent", nextCheckAt: new Date(now.getTime() + 3 * MINUTE) })
    return response(updated, nextStep, { kind: instructing ? "instructed" : "rejected", proposal: updated, caseRow: caseRow!, text: note })
  }

  const option = request.option_id
    ? proposal.options.find((entry) => entry.id === request.option_id)
    : proposal.options.find((entry) => entry.recommended) ?? null
  if (request.option_id && !option) throw new DecisionError(400, "That option is not on this card.")
  const edited = request.edited_draft_message ?? null
  if (edited && proposal.draftMessage && (edited.to_type !== proposal.draftMessage.to_type || edited.to_id !== proposal.draftMessage.to_id)) {
    throw new DecisionError(400, "An edit can change the message, not who it goes to.")
  }

  // A phone call is always done by a person: approving it means "I'll handle it".
  const handling = request.decision === "handle" || (proposal.draftMessage?.channel === "phone_call" && proposal.actionType !== "CLEAR_TO_CONTINUE")
  if (handling) {
    const checks = await checkAssumptions(caseId, proposal.orderId, proposal.assumptions)
    if (checks.some((check) => !check.holds)) {
      proposal = await markOutdated(proposal, checks)
      return response(proposal, "The agent redrafts the card with the current facts.", { kind: "outdated", proposal, caseRow: (await getCase(caseId))!, text: null })
    }
    const nextStep = `${capitalise(who)} does this outside the system, then logs what happened.`
    const updated = await transitionProposal(proposal.id, ["PENDING"], {
      status: edited ? "EDITED_AND_APPROVED" : "APPROVED", decidedBy: by, decidedAt: now, decidedRevision: proposal.revision, decisionNote: note,
      chosenOptionId: option?.id ?? null, editedDraftMessage: edited, nextStep,
    })
    if (!updated) throw new DecisionError(409, "Someone else decided this first.")
    await appendEvent({
      caseId, orderId: proposal.orderId, actorType: "operator", actorId: by, kind: "decision", channel: "internal",
      body: `Will handle it personally: "${proposal.title}"${option ? ` (${option.label})` : ""}.`,
      data: { proposal_id: proposal.id, decision: "handle", option_id: option?.id ?? null },
    })
    await updateCase(caseId, (await pendingLeft(caseId))
      ? { status: "NEEDS_DECISION" }
      : { status: "WAITING_EXTERNAL", owner: by, waitingOn: `${who} to log what happened`, waitingFor: "operator", nextAction: nextStep, nextCheckAt: new Date(now.getTime() + (urgentCase(await getCase(caseId)) ? 15 : 30) * MINUTE) })
    return response(updated, nextStep, null)
  }

  const updated = await transitionProposal(proposal.id, ["PENDING"], {
    status: edited ? "EDITED_AND_APPROVED" : "APPROVED", decidedBy: by, decidedAt: now, decidedRevision: proposal.revision, decisionNote: note,
    chosenOptionId: option?.id ?? null, editedDraftMessage: edited, nextStep: proposal.nextStepIfApproved,
  })
  if (!updated) throw new DecisionError(409, "Someone else decided this first.")
  await appendEvent({
    caseId, orderId: proposal.orderId, actorType: "operator", actorId: by, kind: "decision", channel: "internal",
    body: `Approved "${proposal.title}"${option ? `, choosing: ${option.label}` : ""}${edited ? ", with an edited message" : ""}.${note ? ` Note: ${note}` : ""}`,
    data: { proposal_id: proposal.id, decision: "approve", option_id: option?.id ?? null, edited: Boolean(edited), revision: proposal.revision },
  })
  const executed = await executeProposal(proposal.id, { by })
  if (executed.status === "OUTDATED") {
    return response(executed, "The agent redrafts the card with the current facts.", { kind: "outdated", proposal: executed, caseRow: (await getCase(caseId))!, text: null })
  }
  const caseRow = (await getCase(caseId))!
  return response(executed, executed.status === "UNKNOWN_OUTCOME" ? caseRow.nextAction ?? proposal.nextStepIfApproved : proposal.nextStepIfApproved, { kind: "approved", proposal: executed, caseRow, text: note })
}

/**
 * "Log what happened": after "I'll handle it", or to reconcile a booking whose
 * outcome was unknown (`confirmed` says whether it exists).
 */
export async function logOutcome(caseId: string, input: LogOutcomeRequest): Promise<DecisionOutcome> {
  const text = input.text?.trim()
  const by = input.logged_by?.trim()
  if (!text) throw new DecisionError(400, "Write one line on what happened.")
  if (!by) throw new DecisionError(400, "Say who is logging this.")
  const caseRow = await getCase(caseId)
  if (!caseRow) throw new DecisionError(404, "Case not found.")
  const waiting = await listProposals({ caseId, statuses: ["APPROVED", "EDITED_AND_APPROVED", "UNKNOWN_OUTCOME"] })
  const proposal = input.proposal_id ? waiting.find((row) => row.id === input.proposal_id) : waiting.filter((row) => !row.executedAt || row.status === "UNKNOWN_OUTCOME").at(-1)
  const who = await operatorPhrase(by)

  if (!proposal) {
    // An outcome with no card waiting is still useful: record it and let the agent continue.
    await insertEffect({ orderId: caseRow.orderId, caseId, kind: "OUTCOME_LOGGED", state: "RECORDED", value: { text }, authority: { by, by_type: "operator", at: simNow().toISOString(), basis: `Logged by ${who}` } })
    await appendEvent({ caseId, orderId: caseRow.orderId, actorType: "operator", actorId: by, kind: "note", channel: "internal", body: `Logged by ${who}: ${text}`, data: { outcome: true } })
    await updateCase(caseId, { status: "AGENT_WORKING", owner: "agent", waitingOn: "the agent", waitingFor: "agent", nextAction: "The agent continues from the logged outcome.", nextCheckAt: later(3) })
    return { proposal_id: "", status: "EXECUTED", next_step: "The agent continues from the logged outcome.", next_check_at: later(3).toISOString(), case_status: "AGENT_WORKING", followUp: null }
  }

  if (proposal.status === "UNKNOWN_OUTCOME") {
    if (typeof input.confirmed !== "boolean") throw new DecisionError(400, "Say whether the booking exists (confirmed: true or false).")
    const unconfirmed = (await listEffects({ caseId, kinds: ["BOOKING"] })).filter((row) => row.proposalId === proposal.id && row.state === "UNCONFIRMED").at(-1)
    const authority: EffectAuthority = { by, by_type: "operator", at: simNow().toISOString(), proposal_id: proposal.id, revision: proposal.revision, basis: `Reconciled by ${who}: ${text}` }
    if (input.confirmed && unconfirmed) await effect(proposal, "BOOKING", "RECORDED", { ...unconfirmed.value, reconciled: true }, authority, {}, unconfirmed.id)
    await effect(proposal, "OUTCOME_LOGGED", "RECORDED", { text, booking_exists: input.confirmed }, authority)
    await appendEvent({
      caseId, orderId: proposal.orderId, actorType: "operator", actorId: by, kind: "effect", channel: "internal",
      body: `${capitalise(who)} checked the booking: ${input.confirmed ? "it exists" : "it does not exist; nothing was booked"}. ${text}`, data: { proposal_id: proposal.id, booking_exists: input.confirmed },
    })
    const updated = await transitionProposal(proposal.id, ["UNKNOWN_OUTCOME"], { status: input.confirmed ? "EXECUTED" : "FAILED" })
    await updateCase(caseId, { status: "AGENT_WORKING", owner: "agent", waitingOn: "the agent", waitingFor: "agent", nextAction: "The agent continues from the reconciled booking.", nextCheckAt: later(3) })
    return response(updated!, "The agent continues from the reconciled booking.", { kind: "outcome", proposal: updated!, caseRow: (await getCase(caseId))!, text })
  }

  if (!(await claimExecution(proposal.id, `${proposal.id}:${proposal.revision}`))) {
    return response((await getProposal(proposal.id))!, "Already logged.", null)
  }
  const authority: EffectAuthority = { by, by_type: "operator", at: simNow().toISOString(), proposal_id: proposal.id, revision: proposal.revision, basis: `Done by ${who} outside the system; outcome logged` }
  const logged = await effect(proposal, "OUTCOME_LOGGED", "RECORDED", { text }, authority)
  await appendEvent({
    caseId, orderId: proposal.orderId, actorType: "operator", actorId: by, kind: "effect", channel: "internal",
    body: `Done by ${who}: ${proposal.title}. Outcome: ${text}`, data: { proposal_id: proposal.id, effect_id: logged.id, outcome: text, handled_outside: true },
  })
  const updated = await transitionProposal(proposal.id, ["APPROVED", "EDITED_AND_APPROVED"], {
    status: "EXECUTED", executedAt: simNow(), executionResult: { effect_id: logged.id, outcome: text, by, handled_outside: true, revision: proposal.revision },
  })
  await updateCase(caseId, { status: "AGENT_WORKING", owner: "agent", waitingOn: "the agent", waitingFor: "agent", nextAction: "The agent continues from the logged outcome.", nextCheckAt: later(3) })
  return response(updated!, "The agent continues from the logged outcome.", { kind: "outcome", proposal: updated!, caseRow: (await getCase(caseId))!, text })
}

/**
 * The customer's answer to a proposed promise change. Only "agreed", with its
 * evidence, changes the effective promise (PLAN.md rule 2).
 */
export async function recordCustomerAnswer(caseId: string, input: CustomerAnswerRequest): Promise<DecisionOutcome> {
  const by = input.logged_by?.trim()
  const note = input.note?.trim()
  if (!by || !note) throw new DecisionError(400, "Say who is logging this and what the customer said.")
  if (input.answer !== "agreed" && input.answer !== "declined") throw new DecisionError(400, "The answer is agreed or declined.")
  const caseRow = await getCase(caseId)
  if (!caseRow) throw new DecisionError(404, "Case not found.")
  const promiseEffects = await listEffects({ caseId, kinds: ["PROMISE_CHANGE"] })
  const answered = new Set(promiseEffects.map((row) => row.supersedesId).filter(Boolean))
  const proposed = input.effect_id
    ? await getEffect(input.effect_id)
    : promiseEffects.filter((row) => row.state === "PROPOSED_TO_CUSTOMER" && !answered.has(row.id)).at(-1) ?? null
  if (!proposed || proposed.caseId !== caseId || proposed.state !== "PROPOSED_TO_CUSTOMER" || answered.has(proposed.id)) {
    throw new DecisionError(409, "There is no proposed date waiting for the customer's answer on this case.")
  }
  const facts = await loadOrderFacts(caseRow.orderId)
  const who = await operatorPhrase(by)
  const answer = await insertEffect({
    orderId: caseRow.orderId, caseId, proposalId: proposed.proposalId, kind: "PROMISE_CHANGE",
    state: input.answer === "agreed" ? "CUSTOMER_AGREED" : "CUSTOMER_DECLINED", value: proposed.value, target: proposed.target,
    authority: { by: facts?.customer.id ?? "customer", by_type: "customer", at: simNow().toISOString(), proposal_id: proposed.proposalId, basis: `Customer ${input.answer} (logged by ${who}): ${note}` },
    evidenceRefs: [{ kind: "cr_effects", id: proposed.id, label: "Proposed date change", at: proposed.at.toISOString() }], supersedesId: proposed.id,
  })
  await appendEvent({
    caseId, orderId: caseRow.orderId, actorType: "operator", actorId: by, kind: "effect", channel: "internal",
    body: input.answer === "agreed"
      ? `Customer agreed to the new date (${String(proposed.value.text ?? "")}). The promise is now changed. Evidence: ${note}`
      : `Customer declined the new date. The original promise stands. Evidence: ${note}`,
    data: { effect_id: answer.id, customer_answer: input.answer },
  })
  await updateCase(caseId, { status: "AGENT_WORKING", owner: "agent", waitingOn: "the agent", waitingFor: "agent", nextAction: "The agent continues from the customer's answer.", nextCheckAt: later(3) })
  const proposal = proposed.proposalId ? await getProposal(proposed.proposalId) : null
  const updatedCase = (await getCase(caseId))!
  return {
    proposal_id: proposal?.id ?? "", status: proposal?.status ?? "EXECUTED", next_step: "The agent continues from the customer's answer.",
    next_check_at: updatedCase.nextCheckAt?.toISOString() ?? null, case_status: updatedCase.status,
    followUp: proposal ? { kind: "customer_answer", proposal, caseRow: updatedCase, text: `${input.answer}: ${note}` } : null,
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
    status: "OUTDATED", decidedBy: by.trim(), decidedAt: simNow(), decisionNote: "Set aside: facts changed since it was drafted.", nextStep,
  })
  if (!updated) throw new DecisionError(409, "Someone else decided this first.")
  await appendEvent({
    caseId, orderId: proposal.orderId, actorType: "operator", actorId: by.trim(), kind: "decision", channel: "internal",
    body: `Asked for a fresh card: facts changed since "${proposal.title}" was drafted.`, data: { proposal_id: proposal.id, decision: "refresh" },
  })
  const caseRow = await updateCase(caseId, (await pendingLeft(caseId))
    ? { status: "NEEDS_DECISION" }
    : { status: "AGENT_WORKING", owner: "agent", nextAction: nextStep, waitingOn: "the agent", waitingFor: "agent", nextCheckAt: later(3) })
  return { proposal_id: proposal.id, status: "OUTDATED", next_step: nextStep, next_check_at: caseRow!.nextCheckAt?.toISOString() ?? null, case_status: caseRow!.status }
}
