// When the agent runs (PLAN.md 4.2): a driver or site writes in, the car
// reports a fault, an operator decides, logs an outcome, instructs or asks.
// Each entry point stores what came in first, then runs a turn under the
// case lock, then any follow-up turns (preparing a decision, continuing
// after one). The API routes are thin wrappers around these.

import { simNow } from "@/lib/cr/clock"
import {
  appendEvent, attachEvents, createCase, getCase, getProposal, listCases, resolveOrder, updateCase, type CaseRow,
} from "@/lib/cr/queries"
import {
  OPEN_CASE_STATUSES, type AskAgentRequest, type AssumptionCheck, type CustomerAnswerRequest, type DecisionRequest,
  type DriverMessageRequest, type LogOutcomeRequest, type PhotoData, type SiteMessageRequest, type TelemetryTriggerRequest,
} from "@/lib/cr/types"
import { AGENT_ID } from "./config"
import { activeDriverId, activeOrderForDriver, driverName, linkedRecordsOf, loadOrderFacts, type End, type OrderFacts } from "./context"
import { decideProposal, logOutcome, recordCustomerAnswer, refreshProposal, type DecisionOutcome } from "./gate"
import { operatorPhrase } from "./timeline"
import { runTurn, withCaseLock, type TurnResult } from "./loop"
import type { FollowUp } from "./tools"

export class ChannelError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = "ChannelError"
  }
}

type OnText = ((text: string) => void) | undefined

async function openCase(orderId: string, match: (row: CaseRow) => boolean, create: () => Promise<CaseRow>): Promise<CaseRow> {
  const open = await listCases({ orderId, statuses: [...OPEN_CASE_STATUSES] })
  const existing = open.find(match)
  if (existing) {
    if (existing.status === "WAITING_EXTERNAL") {
      return (await updateCase(existing.id, { status: "AGENT_WORKING", waitingOn: "the agent", waitingFor: "agent", nextAction: "The agent reads the new message." })) ?? existing
    }
    return existing
  }
  return create()
}

// ---------------------------------------------------------------- driver

export type PreparedDriverMessage = { facts: OrderFacts; driverId: string; name: string | null; request: DriverMessageRequest }

/** Check who is writing about what before anything streams. Throws ChannelError with an HTTP status. */
export async function prepareDriverMessage(request: DriverMessageRequest): Promise<PreparedDriverMessage> {
  if (!request?.driverId || !request.text?.trim() && !request.photoIds?.length) throw new ChannelError(400, "driverId and text are required.")
  const order = request.orderRef ? await resolveOrder(request.orderRef) : null
  const orderId = order?.id ?? (await activeOrderForDriver(request.driverId))
  if (!orderId) throw new ChannelError(404, request.orderRef ? `No order ${request.orderRef}.` : "This driver has no current job.")
  const facts = await loadOrderFacts(orderId)
  if (!facts) throw new ChannelError(404, "Order not found.")
  // Rule 8: a client-supplied orderRef grants nothing by itself; the driver must be on an active assignment.
  if (!facts.assignments.some((row) => row.driver_id === request.driverId && (row.status === "IN_PROGRESS" || row.status === "ASSIGNED"))) {
    throw new ChannelError(403, `${request.driverId} is not on an active assignment for ${facts.reference}.`)
  }
  return { facts, driverId: request.driverId, name: facts.driverNames.get(request.driverId) ?? (await driverName(request.driverId)), request }
}

export async function handleDriverMessage(prepared: PreparedDriverMessage, onText?: OnText): Promise<{ caseId: string; result: TurnResult }> {
  const { facts, driverId, name, request } = prepared
  const voice = request.mode === "voice"
  const channel = voice ? "driver_voice" : "driver_chat"
  const text = request.text?.trim() || "(sent a photo)"
  const caseRow = await openCase(facts.id, (row) => row.driverId === driverId || (!row.driverId && row.kind !== "SITE_QUESTION"), () => createCase({
    orderId: facts.id, kind: "DRIVER_QUESTION", status: "AGENT_WORKING", urgency: "NORMAL",
    title: `Message from ${name ?? "the driver"}`, summary: text.slice(0, 200), channelOpened: channel, owner: "agent", driverId,
    linkedRecords: linkedRecordsOf(facts),
  }))
  if (request.photoIds?.length) await attachEvents(request.photoIds, caseRow.id)
  await appendEvent({
    caseId: caseRow.id, orderId: facts.id, actorType: "driver", actorId: driverId, kind: voice ? "voice_turn" : "message", channel,
    recipientType: "agent", recipientId: AGENT_ID, body: text, data: { photo_ids: request.photoIds ?? [] },
  })
  const result = await withCaseLock(caseRow.id, () => runTurn({
    caseId: caseRow.id, audience: "driver", trigger: "inbound", voice,
    input: `${name ?? "The driver"} wrote${voice ? " (spoken, transcribed)" : ""}: "${text}"${request.photoIds?.length ? ` and sent ${request.photoIds.length} photo(s), listed above as [photo, event …].` : ""}`,
    counterpart: { type: "driver", id: driverId, name }, replyChannel: channel, onText,
  }))
  return { caseId: caseRow.id, result }
}

// ---------------------------------------------------------------- site

export type PreparedSiteMessage = { facts: OrderFacts; end: End; contactId: string; name: string; request: SiteMessageRequest }

/** `siteContactId` is the order's endpoint detail id (`ep-…`) or the site id of its pickup or delivery place. */
export async function prepareSiteMessage(request: SiteMessageRequest): Promise<PreparedSiteMessage> {
  if (!request?.siteContactId || !request.orderRef || !request.text?.trim()) throw new ChannelError(400, "orderRef, siteContactId and text are required.")
  const order = await resolveOrder(request.orderRef)
  const facts = order ? await loadOrderFacts(order.id) : null
  if (!facts) throw new ChannelError(404, `No order ${request.orderRef}.`)
  const matches = (endpoint: OrderFacts["pickup"]) => endpoint.detail?.id === request.siteContactId || (endpoint.site && endpoint.site.id === request.siteContactId)
  const end: End | null = matches(facts.pickup) ? "pickup" : matches(facts.delivery) ? "delivery" : null
  if (!end) throw new ChannelError(403, `This contact is not the pickup or delivery place of ${facts.reference}.`)
  const endpoint = end === "pickup" ? facts.pickup : facts.delivery
  const contact = typeof endpoint.detail?.contact_name === "string" ? endpoint.detail.contact_name : null
  const place = String(endpoint.site?.name ?? endpoint.address.name ?? "the site")
  return { facts, end, contactId: request.siteContactId, name: contact ? `${contact}, ${place}` : place, request }
}

export async function handleSiteMessage(prepared: PreparedSiteMessage, onText?: OnText): Promise<{ caseId: string; result: TurnResult }> {
  const { facts, end, contactId, name, request } = prepared
  const caseRow = await openCase(facts.id, (row) => row.kind === "SITE_QUESTION" || row.channelOpened === "site_chat", () => createCase({
    orderId: facts.id, kind: "SITE_QUESTION", status: "AGENT_WORKING", urgency: "NORMAL", title: `Question from ${name}`,
    summary: request.text.slice(0, 200), channelOpened: "site_chat", owner: "agent", driverId: activeDriverId(facts),
  }))
  if (request.photoIds?.length) await attachEvents(request.photoIds, caseRow.id)
  await appendEvent({
    caseId: caseRow.id, orderId: facts.id, actorType: "site", actorId: contactId, kind: "message", channel: "site_chat",
    recipientType: "agent", recipientId: AGENT_ID, body: request.text.trim(), data: { name, end },
  })
  const result = await withCaseLock(caseRow.id, () => runTurn({
    caseId: caseRow.id, audience: "site", trigger: "inbound", siteEnd: end, voice: request.mode === "voice",
    input: `${name} (${end} place) wrote: "${request.text.trim()}"`,
    counterpart: { type: "site", id: contactId, name }, replyChannel: "site_chat", onText,
  }))
  return { caseId: caseRow.id, result }
}

// ---------------------------------------------------------------- photos

const MAX_PHOTO_BYTES = 5 * 1024 * 1024

/** Store an uploaded photo as a `photo` event; the message that sends it attaches it to the case. */
export async function storePhoto(input: { orderRef: string; mediaType: string; bytes: Buffer; subject?: string | null; caption?: string | null; uploadedBy?: string | null }): Promise<string> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(input.mediaType)) throw new ChannelError(415, "Photos must be PNG, JPEG or WebP.")
  if (input.bytes.length > MAX_PHOTO_BYTES) throw new ChannelError(413, "Photos must be 5 MB or smaller. Scale it down before uploading.")
  const order = await resolveOrder(input.orderRef)
  if (!order) throw new ChannelError(404, `No order ${input.orderRef}.`)
  const data: PhotoData = { media_type: input.mediaType as PhotoData["media_type"], base64: input.bytes.toString("base64"), subject: input.subject ?? null, caption: input.caption ?? null }
  const event = await appendEvent({
    orderId: order.id, actorType: input.uploadedBy?.startsWith("site") || input.uploadedBy?.startsWith("ep-") ? "site" : "driver", actorId: input.uploadedBy ?? null,
    kind: "photo", channel: "driver_chat", body: input.caption || (input.subject ? `Photo: ${input.subject}` : "Photo"), data: data as unknown as Record<string, unknown>,
  })
  return event.id
}

// ---------------------------------------------------------------- telemetry

/** The car reports a fault: open a case and contact the driver first, before any person sees it. */
export async function handleTelemetryFault(request: TelemetryTriggerRequest): Promise<{ caseId: string; result: TurnResult }> {
  const order = await resolveOrder(request.orderRef)
  const facts = order ? await loadOrderFacts(order.id) : null
  if (!facts) throw new ChannelError(404, `No order ${request.orderRef}.`)
  const driverId = activeDriverId(facts)
  if (!driverId) throw new ChannelError(409, `${facts.reference} has no driver on the road.`)
  const codes = (request.codes ?? []).map((code) => code.trim().toUpperCase()).filter(Boolean)
  const light = request.mil === "FLASHING" ? "flashing" : request.mil === "ON" ? "on" : "off"
  const summary = `Check-engine light ${light}${codes.length ? `, trouble codes ${codes.join(", ")}` : ""}${request.note ? `, ${request.note}` : ""}`
  const caseRow = await openCase(facts.id, (row) => row.driverId === driverId && ["VEHICLE_WARNING", "BREAKDOWN"].includes(row.kind), () => createCase({
    orderId: facts.id, kind: "VEHICLE_WARNING", status: "AGENT_WORKING", urgency: request.mil === "FLASHING" ? "CRITICAL" : "HIGH",
    title: `Car reports a fault${codes.length ? `: ${codes.join(", ")}` : ""}`, summary, channelOpened: "telemetry", owner: "agent", driverId,
    linkedRecords: linkedRecordsOf(facts),
  }))
  if (request.eventId) await attachEvents([request.eventId], caseRow.id)
  else {
    await appendEvent({
      caseId: caseRow.id, orderId: facts.id, actorType: "obd", actorId: "obd", kind: "dtc", channel: "telemetry", body: summary,
      data: { codes, mil: request.mil, note: request.note ?? null },
    })
  }
  const name = facts.driverNames.get(driverId) ?? null
  const result = await withCaseLock(caseRow.id, () => runTurn({
    caseId: caseRow.id, audience: "driver", trigger: "telemetry",
    input: `The car's OBD dongle just reported: ${summary}. ${name ?? "The driver"} has not written to us. Contact them first: make sure they are safe, give the safety instruction the severity calls for, and ask what they see.`,
    counterpart: { type: "driver", id: driverId, name }, replyChannel: "driver_chat",
  }))
  return { caseId: caseRow.id, result }
}

// ---------------------------------------------------------------- operators

/** The "Ask the agent" box: read-only answers with sources. */
export async function askAgent(request: AskAgentRequest): Promise<{ caseId: string; result: TurnResult }> {
  if (!request?.text?.trim() || !request.asked_by?.trim()) throw new ChannelError(400, "text and asked_by are required.")
  let caseRow = request.case_id ? await getCase(request.case_id) : null
  let created = false
  if (!caseRow) {
    const order = request.order_ref ? await resolveOrder(request.order_ref) : null
    if (!order) throw new ChannelError(404, "Give a case or an order reference.")
    const open = await listCases({ orderId: order.id, statuses: [...OPEN_CASE_STATUSES] })
    caseRow = open[0] ?? null
    if (!caseRow) {
      created = true
      caseRow = await createCase({
        orderId: order.id, kind: "OPERATOR_QUESTION", status: "AGENT_WORKING", urgency: "LOW", title: `Question about ${order.reference}`,
        summary: request.text.slice(0, 200), channelOpened: "operator_chat", owner: "agent",
      })
    }
  }
  await appendEvent({
    caseId: caseRow.id, orderId: caseRow.orderId, actorType: "operator", actorId: request.asked_by, kind: "message", channel: "operator_chat",
    recipientType: "agent", recipientId: AGENT_ID, body: request.text.trim(),
  })
  const target = caseRow
  const asker = await operatorPhrase(request.asked_by)
  const result = await withCaseLock(target.id, () => runTurn({
    caseId: target.id, audience: "operator", trigger: "ask", input: `${asker.charAt(0).toUpperCase()}${asker.slice(1)} asks: "${request.text.trim()}"`,
    counterpart: { type: "operator", id: request.asked_by, name: asker }, replyChannel: "operator_chat",
  }))
  if (created) await updateCase(target.id, result.error ? { status: "RESOLVED" } : { status: "HANDLED_BY_AGENT", summary: `Answered: ${request.text.slice(0, 160)}` })
  return { caseId: target.id, result }
}

/** A free-text instruction to the agent on a case ("Tell the agent instead"). */
export async function instructAgent(caseId: string, text: string, by: string): Promise<CaseRow> {
  const caseRow = await getCase(caseId)
  if (!caseRow) throw new ChannelError(404, "Case not found.")
  if (!text?.trim() || !by?.trim()) throw new ChannelError(400, "text and by are required.")
  await appendEvent({
    caseId, orderId: caseRow.orderId, actorType: "operator", actorId: by, kind: "message", channel: "internal",
    recipientType: "agent", recipientId: AGENT_ID, body: `Instruction to the agent: ${text.trim()}`,
  })
  return (await updateCase(caseId, { status: "AGENT_WORKING", owner: "agent", waitingOn: "the agent", waitingFor: "agent", nextAction: `The agent follows the instruction: ${text.trim()}` }))!
}

function outdatedReason(title: string, revision: number, checks: AssumptionCheck[] | undefined): string {
  const changed = (checks ?? []).map((check) => `${check.assumption.label} (now: ${check.now})`).join("; ")
  return `The card "${title}" (revision ${revision}) became outdated before it ran${changed ? `: ${changed}` : ""}. Nothing was carried out. Redraft it with the current facts (it becomes the next revision), or explain why no card is needed now.`
}

/** Follow-up turns after a decision. Nothing runs while a booking's outcome is unknown or after an operator takes a case over. */
function followUpsFor(caseId: string, proposalId: string, outcome: DecisionOutcome): FollowUp[] {
  const followUp = outcome.followUp
  if (!followUp) return []
  if (followUp.kind === "outdated") return [{ kind: "analysis", caseId, reason: outdatedReason(followUp.proposal.title, followUp.proposal.revision, outcome.outdated) }]
  if (followUp.proposal.status === "UNKNOWN_OUTCOME") return []
  if (followUp.proposal.actionType === "OPERATOR_DECISION" && followUp.proposal.chosenOptionId === "take_over") return []
  return [{ kind: "decision", caseId, proposalId, outcome: followUp.kind === "approved" || followUp.kind === "outcome" || followUp.kind === "customer_answer" ? "approved" : "rejected", note: followUp.kind === "customer_answer" ? followUp.text : null }]
}

export async function decide(caseId: string, proposalId: string, request: DecisionRequest): Promise<{ outcome: DecisionOutcome; followUps: FollowUp[] }> {
  const outcome = await decideProposal(caseId, proposalId, request)
  const proposal = outcome.followUp?.proposal
  if (proposal?.actionType === "OPERATOR_DECISION" && proposal.chosenOptionId === "take_over") {
    // "I'll take it from here": the case stays with the operator; the agent waits for an instruction.
    const who = await operatorPhrase(request.decided_by)
    await updateCase(caseId, {
      status: "WAITING_EXTERNAL", owner: request.decided_by, waitingFor: "operator", waitingOn: `${who} (took the case over)`,
      nextAction: "The operator handles this case; the agent stays out until instructed.", nextCheckAt: new Date(simNow().getTime() + 60 * 60000),
    })
  }
  return { outcome, followUps: followUpsFor(caseId, proposalId, outcome) }
}

export async function outcome(caseId: string, input: LogOutcomeRequest): Promise<{ outcome: DecisionOutcome; followUps: FollowUp[] }> {
  const result = await logOutcome(caseId, input)
  return { outcome: result, followUps: result.followUp ? followUpsFor(caseId, result.proposal_id, result) : [{ kind: "decision", caseId, proposalId: "", outcome: "approved", note: null }] }
}

/** The customer's answer to a proposed date change. Only "agreed" moves the promise; the agent continues from there. */
export async function customerAnswer(caseId: string, input: CustomerAnswerRequest): Promise<{ outcome: DecisionOutcome; followUps: FollowUp[] }> {
  const result = await recordCustomerAnswer(caseId, input)
  return { outcome: result, followUps: result.followUp ? followUpsFor(caseId, result.proposal_id, result) : [] }
}

/** "Facts changed since this was drafted": set the card aside; the agent drafts a fresh one. */
export async function refresh(caseId: string, proposalId: string, by: string): Promise<{ response: Awaited<ReturnType<typeof refreshProposal>>; followUps: FollowUp[] }> {
  const response = await refreshProposal(caseId, proposalId, by)
  return { response, followUps: [{ kind: "analysis", caseId, reason: "New facts came in after the last card was drafted, and the operator asked for a fresh one. Re-read the case notes and the records, then redraft it (it becomes the next revision)." }] }
}

// ---------------------------------------------------------------- follow-ups

const OPERATIONS = { type: "operator" as const, id: null, name: "Operations" }

const CONTINUE = "Continue the case: tell the driver what happens next if they need to know (message_driver), propose the next decision if one is needed, or put the case into a deliberate wait with wait_for (who we wait on and when to check again). End with one line for the operators."

async function decisionInput(caseRow: CaseRow, proposalId: string, note: string | null | undefined): Promise<{ trigger: "decision" | "instruct"; input: string }> {
  const proposal = proposalId ? await getProposal(proposalId) : null
  if (!proposal) {
    return { trigger: "instruct", input: `An operator logged an outcome or gave an instruction; it is the latest entry in the case notes. ${CONTINUE}` }
  }
  const chosen = proposal.options.find((option) => option.id === proposal.chosenOptionId)
  const outcomeText = typeof proposal.executionResult?.outcome === "string" ? proposal.executionResult.outcome : null
  const what = `"${proposal.title}" (${proposal.actionType})`
  if (note && proposal.actionType === "CHANGE_PROMISE") {
    return { trigger: "decision", input: `The customer's answer to the proposed date change was recorded: ${note}. Only an agreement changes the promise. ${CONTINUE}` }
  }
  if (proposal.status === "FAILED") {
    return { trigger: "decision", input: `An operator checked the booking from ${what}: it does not exist; nothing was booked. Do not retry blindly: look for fresh options and propose again only with a current quote. ${CONTINUE}` }
  }
  if (outcomeText) {
    return { trigger: "decision", input: `Operator logged an outcome for ${what}: "${outcomeText}". ${CONTINUE} Typical next steps: check new timings against later deadlines (ferry check-in, the delivery promise) and propose a travel change or a customer update where one is at risk.` }
  }
  if (proposal.status === "REJECTED" && proposal.nextStep?.startsWith("The agent follows the instruction")) {
    return { trigger: "instruct", input: `Instruction from an operator, given instead of ${what}: "${proposal.decisionNote}". Follow it. Anything that changes something still goes through propose_action.` }
  }
  if (proposal.status === "REJECTED") {
    return { trigger: "decision", input: `Operator decided: rejected ${what}. Reason: "${proposal.decisionNote}". Do not propose the same thing again. Work out the next step from the reason, then propose it or escalate.` }
  }
  return { trigger: "decision", input: `Operator decided: approved ${what}${chosen ? `, option "${chosen.label}"` : ""}. It has been carried out (simulated). Next step on the card: ${proposal.nextStepIfApproved}. ${CONTINUE}` }
}

/** Run follow-up turns one after another. Errors are recorded on the case, never thrown. */
export async function runFollowUps(followUps: FollowUp[]): Promise<void> {
  const queue = [...followUps]
  while (queue.length) {
    const followUp = queue.shift()!
    try {
      const caseRow = await getCase(followUp.caseId)
      if (!caseRow) continue
      const request = followUp.kind === "analysis"
        ? { trigger: "analysis" as const, input: `Prepare the decision for operations now. Why: ${followUp.reason}` }
        : await decisionInput(caseRow, followUp.proposalId, followUp.note)
      const result = await withCaseLock(caseRow.id, () => runTurn({
        caseId: caseRow.id, audience: "operator", trigger: request.trigger, input: request.input, counterpart: OPERATIONS, replyChannel: "internal",
      }))
      queue.push(...result.followUps)
    } catch (error) {
      console.error("Road Desk follow-up failed", error)
    }
  }
}

/** Instruct, then let the agent act on it. */
export async function runInstruction(caseId: string): Promise<void> {
  await runFollowUps([{ kind: "decision", caseId, proposalId: "", outcome: "approved", note: null }])
}
