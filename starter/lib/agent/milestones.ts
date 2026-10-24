// The driver reports the delivery's steps in the app: at the pickup, collected, checked in at the terminal, at the
// delivery address, handed over. A report is checked (the right driver, the steps in order), stored as a milestone
// and read everywhere through lib/cr/lifecycle.ts. A handover also brings operations one card: the delivery
// confirmation to the customer, drafted from the records, which a person approves before it is sent.

import { effectiveOrder } from "@/lib/cr/effective"
import { lifecycleOf, MILESTONE_WORDS, MILESTONES, nextMilestone, type Milestone, type MilestoneData } from "@/lib/cr/lifecycle"
import { appendEvent, createCase, resolveOrder } from "@/lib/cr/queries"
import type { SourceRef } from "@/lib/cr/types"
import { activeDriverId, loadOrderFacts, type OrderFacts } from "./context"
import { localTime } from "./format"
import { submitProposal } from "./gate"
import { ChannelError } from "./triggers"

export type MilestoneRequest = {
  orderRef: string
  driverId: string
  milestone: Milestone
  keys?: number | null
  receiverName?: string | null
  photoIds?: string[]
  note?: string | null
}

export type MilestoneResult = { eventId: string; at: string; milestone: Milestone; next: Milestone | null; caseId: string | null; text: string }

// A managed place by its name; a private address by its city ("Third-party handoff" is a record label, not a place).
const placeName = (endpoint: OrderFacts["pickup"]) => endpoint.site?.name ? String(endpoint.site.name)
  : `the ${endpoint.end === "pickup" ? "pickup" : "delivery"} address in ${String(endpoint.address.city ?? "town")}`

export function hasFerry(facts: OrderFacts): boolean {
  return facts.reservations.some((row) => row.kind === "FERRY" && row.status === "BOOKED")
}

export async function recordMilestone(request: MilestoneRequest): Promise<MilestoneResult> {
  if (!MILESTONES.includes(request.milestone)) throw new ChannelError(400, "Unknown step.")
  const order = await resolveOrder(request.orderRef)
  if (!order) throw new ChannelError(404, `No order ${request.orderRef}.`)
  const facts = await loadOrderFacts(order.id)
  if (!facts) throw new ChannelError(404, "Order not found.")
  // Rule 8: only the driver on the order's live assignment reports its steps.
  const assignment = facts.assignments.find((row) => row.driver_id === request.driverId && (row.status === "ASSIGNED" || row.status === "IN_PROGRESS"))
  if (!assignment) throw new ChannelError(403, "This driver is not on an active assignment for this order.")

  const lifecycle = await lifecycleOf(order.id)
  const ferry = hasFerry(facts)
  if (lifecycle[request.milestone]) throw new ChannelError(409, `${MILESTONE_WORDS[request.milestone]} is already recorded.`)
  const steps = ferry ? [...MILESTONES] : MILESTONES.filter((step) => step !== "CHECKED_IN")
  const index = steps.indexOf(request.milestone)
  if (index < 0) throw new ChannelError(400, "This trip has no ferry check-in.")
  const lastDone = Math.max(-1, ...steps.map((step, i) => (lifecycle[step] ? i : -1)))
  if (index < lastDone) throw new ChannelError(409, "A later step is already recorded.")
  const collected = Boolean(lifecycle.COLLECTED) || facts.status === "IN_TRANSIT"
  if (index > steps.indexOf("COLLECTED") && !collected) throw new ChannelError(409, "Record the collection first.")
  const receiver = request.receiverName?.trim().slice(0, 120) || null
  if (request.milestone === "DELIVERED" && !receiver) throw new ChannelError(400, "Write who took the car and keys.")
  const counted = request.milestone === "COLLECTED" || request.milestone === "DELIVERED"
  const keys = counted && typeof request.keys === "number" && Number.isFinite(request.keys) && request.keys >= 0 && request.keys <= 9 ? Math.round(request.keys) : null

  const driverName = facts.driverNames.get(request.driverId) ?? "The driver"
  const where = request.milestone === "ARRIVED_PICKUP" || request.milestone === "COLLECTED" ? placeName(facts.pickup)
    : request.milestone === "CHECKED_IN" ? String(facts.reservations.find((row) => row.kind === "FERRY" && row.status === "BOOKED")?.origin_terminal ?? "the terminal") : placeName(facts.delivery)
  const photos = request.photoIds?.filter((id) => typeof id === "string").slice(0, 8) ?? []
  const detail = [keys != null ? `${keys} ${keys === 1 ? "key" : "keys"}` : null, receiver ? `to ${receiver}` : null, photos.length ? `${photos.length} ${photos.length === 1 ? "photo" : "photos"}` : null].filter(Boolean).join(", ")
  const text = `${MILESTONE_WORDS[request.milestone]} at ${where}${detail ? ` (${detail})` : ""}.${request.note?.trim() ? ` ${request.note.trim().slice(0, 300)}` : ""}`
  const data: MilestoneData = {
    milestone: request.milestone, assignment_id: String(assignment.id), keys, receiver_name: receiver, photo_ids: photos,
    note: request.note?.trim().slice(0, 300) || null, simulated: true,
  }
  const event = await appendEvent({
    caseId: null, orderId: order.id, actorType: "driver", actorId: request.driverId, kind: "milestone", channel: "driver_chat",
    body: `${driverName}: ${text}`, data: data as unknown as Record<string, unknown>,
  })
  const after = { ...lifecycle, [request.milestone]: { at: event.at.toISOString(), driverId: request.driverId, data, eventId: event.id } }
  const caseId = request.milestone === "DELIVERED" ? await deliveryConfirmation(facts, event.id, event.at, receiver!, keys, photos.length) : null
  return { eventId: event.id, at: event.at.toISOString(), milestone: request.milestone, next: nextMilestone(after, ferry), caseId, text }
}

/** The handover becomes one card: tell the customer, in words the records support. A person approves it. */
async function deliveryConfirmation(facts: OrderFacts, eventId: string, at: Date, receiver: string, keys: number | null, photos: number): Promise<string> {
  const effective = await effectiveOrder(facts.id)
  const promise = effective.promise
  const zone = String(facts.delivery.timezone ?? promise?.zone ?? "UTC")
  const when = localTime(at.toISOString(), zone) ?? at.toISOString()
  const vehicle = facts.vehicle ? `${facts.vehicle.make} ${facts.vehicle.model}` : "car"
  const window = promise?.start_utc && promise.end_utc ? `${localTime(promise.start_utc, zone)} to ${localTime(promise.end_utc, zone)}` : null
  const late = promise?.end_utc ? at.getTime() > Date.parse(promise.end_utc) : false
  const early = promise?.start_utc ? at.getTime() < Date.parse(promise.start_utc) : false
  const place = placeName(facts.delivery)
  const handoverSource: SourceRef = { kind: "cr_events", id: eventId, label: `Handover reported in the driver app, ${when}`, at: at.toISOString() }
  const caseRow = await createCase({
    orderId: facts.id, kind: "HANDOVER", status: "AGENT_WORKING", urgency: late ? "HIGH" : "NORMAL", title: `Delivered: confirm to ${facts.customer.name}`,
    summary: `${vehicle} handed over at ${place} to ${receiver}, ${when}${late ? ", after the promised window" : ""}.`, channelOpened: "system", owner: "agent", driverId: activeDriverId(facts),
  })
  const body = [
    `Hello,`,
    `Your ${vehicle} (order ${facts.reference}) was handed over at ${place} on ${when} to ${receiver}${keys != null ? `, with ${keys} ${keys === 1 ? "key" : "keys"}` : ""}.`,
    photos ? `The driver took ${photos} ${photos === 1 ? "photo" : "photos"} at the handover; they are kept with the order.` : null,
    late && window ? `This was later than the agreed delivery window (${window}). We are sorry for the delay.` : null,
    `Kind regards,\nBahn operations`,
  ].filter(Boolean).join("\n\n")
  await submitProposal({ audience: "operator", caseRow, facts }, {
    action_type: "CONTACT_CUSTOMER",
    title: `Tell ${facts.customer.name} the car was delivered`,
    rationale: `The driver reported the handover in the app. The customer hears it from a person: the agent never contacts them on its own.${late ? " The handover was after the promised window, so the message says so." : early ? " The handover was before the promised window." : ""}`,
    handover: {
      what_happened: `${vehicle} handed over at ${place} to ${receiver}, ${when}.`,
      facts: [
        { text: `Handed over to ${receiver} at ${place}, ${when}${keys != null ? `, ${keys} ${keys === 1 ? "key" : "keys"}` : ""}${photos ? `, ${photos} photos` : ""} (driver's report in the app, simulated).`, sources: [handoverSource] },
        ...(promise && window ? [{ text: `Delivery promise ${window} (${promise.basis}). ${late ? "The handover was after it." : early ? "The handover was before it." : "The handover was within it."}`, sources: [promise.source] }] : []),
      ],
      agent_did: ["Drafted the delivery confirmation from the handover report and the promise."],
      unknowns: ["A signed handover document is not in this app; the receiver's name is as the driver typed it."],
      recommendation: "Send the confirmation.",
      alternatives: ["Edit it first", "Call the customer instead"],
    },
    changes: [],
    draft_message: { to: "customer", channel: "email", subject: `Delivered: your ${vehicle}, order ${facts.reference}`, body, language: "en" },
    options: [],
    evidence_refs: [handoverSource],
    assumptions: [],
    proposed_window: null,
    next_step_if_approved: "The confirmation goes to the customer and the case closes.",
    next_step_if_rejected: "No message goes out; the case closes with your reason.",
  })
  return caseRow.id
}
