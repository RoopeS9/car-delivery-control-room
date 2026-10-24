// The agent's tools: definitions the model sees and the handlers that run
// them. Handlers never decide policy; `runTool` asks the gate first and logs
// every call, allowed or refused, so operators can see what the agent did.

import { readFileSync } from "node:fs"
import path from "node:path"
import type Anthropic from "@anthropic-ai/sdk"
import { appendEvent, getEvent, latestTelemetry, listProposals, resolveOrder, telemetrySince, updateCase } from "@/lib/cr/queries"
import { crDb } from "@/lib/cr/db"
import { sql } from "drizzle-orm"
import { simNow } from "@/lib/cr/clock"
import {
  CASE_KINDS, URGENCIES, ACTION_TYPES,
  type ActorType, type CaseKind, type EventKind, type WaitingFor, type GpsData, type ObdData, type PhotoData, type SourceRef, type ToolCallTrace, type Urgency,
} from "@/lib/cr/types"
import { AGENT_ID } from "./config"
import { contextFor, loadOrderFacts, type End } from "./context"
import { loadDriverSafetyContext, renderSafetyTemplate, SAFETY_TEMPLATES, screenDriverMessage } from "./drivability"
import { firstName, localTime, relative, utcTime } from "./format"
import { checkTool, newFactsSince, recordedTravelSelection, submitProposal, validateProposal, type GateContext, type ProposalInput, type ToolName } from "./gate"
import { cityCoords, matchWarningLights, playbook, playbooks, troubleCode } from "./knowledge"
import { findNearbyHelp, searchTravelOptions, type HelpKind, type TravelKind } from "./mocks"
import { orderTimeline, renderLines } from "./timeline"
import { describePhoto } from "./vision"

export type FollowUp =
  | { kind: "analysis"; caseId: string; reason: string }
  | { kind: "decision"; caseId: string; proposalId: string; outcome: "approved" | "rejected"; note?: string | null }

export type TurnState = GateContext & {
  runId: string
  /** Record ids the agent was shown in this turn (case notes and tool results): what it may cite. */
  seenIds?: Set<string>
  driverId: string | null
  driverName: string | null
  siteEnd: End | null
  followUps: FollowUp[]
  traces: ToolCallTrace[]
  /** Set when the agent closed the case in this turn. */
  closed: boolean
  /** Spend outside the main model calls (the drivability classifier). */
  costUsd: number
  /** Set when something reached a person or changed in this turn; a failed run is then not retried. */
  sideEffects: boolean
  /** Set when the agent chose what the case waits on (wait_for). */
  waitSet: boolean
}

type ToolContent = string | Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam>

type Handled = {
  content: ToolContent
  isError?: boolean
  gate?: ToolCallTrace["gate"]
  /** A plain-language line for the case timeline. Omit when the handler wrote its own event. */
  log?: { kind: EventKind; body: string; sources?: SourceRef[]; data?: Record<string, unknown> } | null
}

// ---------------------------------------------------------------- definitions

const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) =>
  ({ type: "object" as const, properties, required, additionalProperties: false })
const text = (description: string) => ({ type: "string", description })
const sourceRefSchema = obj({
  kind: text("Where the fact comes from: the `source.kind` you were given, e.g. messages, time_windows, cr_telemetry, knowledge:dtc."),
  id: text("The source's id, as given in a tool result."),
  label: text("Short human label, e.g. 'Driver, app chat, 08:22 UTC'."),
  at: text("When the source said it (ISO time), or an empty string."),
})
// The handover packet as top-level parameters. Models sometimes mix their own
// parameter tags into an object-valued parameter, which breaks the JSON, so
// the decision tools take no object-valued parameters; arrays are fine.
const handoverFields = {
  what_happened: text("Handover: what happened, in one sentence."),
  facts: { type: "array", description: "Handover: the facts a person needs, each with its sources.", items: obj({ text: text("One fact."), sources: { type: "array", items: sourceRefSchema } }) },
  agent_did: { type: "array", items: { type: "string" }, description: "Handover: what you already did: questions asked, lookups, instructions given." },
  unknowns: { type: "array", items: { type: "string" }, description: "Handover: what is still not known." },
  recommendation: text("Handover: your recommendation in one or two sentences."),
  alternatives: { type: "array", items: { type: "string" }, description: "Handover: other reasonable choices." },
}
const optionsSchema = {
  type: "array",
  description: "Choices for the operator, if the decision has more than one sensible answer. Empty if it is a plain yes or no.",
  items: obj({ id: text("Short id, e.g. 'own_assistance'."), label: text("Short label."), description: text("One line."), recommended: { type: "boolean" } }),
}

const assumptionSchema = {
  anyOf: [
    obj({ kind: { type: "string", enum: ["record"] }, table: text("Dataset collection, e.g. travel_reservations."), id: text("Record id from a source."), field: text("Field name, e.g. status."), expected: text("The value you relied on, as text."), label: text("In words, e.g. 'Ferry WBV-FERRY-00584 is still booked'.") }),
    obj({ kind: { type: "string", enum: ["no_new_message"] }, from: { type: "string", enum: ["driver", "site", "customer"] }, after: text("ISO time of the latest message you read."), label: text("In words, e.g. 'No new driver message after 09:12'.") }),
    obj({ kind: { type: "string", enum: ["car_codes"] }, codes: { type: "array", items: { type: "string" } }, label: text("In words, e.g. 'Car still reports P0300 and P0302'.") }),
  ],
}

const ORDER_REF = text("Order reference like CD-420584. Empty string means this case's order.")

export const TOOL_DEFINITIONS: Record<ToolName, Anthropic.Tool> = {
  get_order_context: {
    name: "get_order_context",
    description: "Read the order: vehicle, route, pickup and delivery details with how confirmed they are, delivery promise and who set it, driver, travel bookings (and for operators: quotes, customer, open alerts, work items, expenses), the latest driver-app progress and the latest phone position and car status. Every fact has a `source` to cite. Call this first.",
    input_schema: obj({ order_ref: ORDER_REF }),
  },
  get_timeline: {
    name: "get_timeline",
    description: "Read the order's history: messages between operations, drivers, customers and sites, recorded events, and the Road Desk's own case events, oldest first, each with who, channel and time.",
    input_schema: obj({ order_ref: ORDER_REF, last: { type: "integer", description: "How many of the most recent lines to return, e.g. 40." } }),
  },
  get_telemetry: {
    name: "get_telemetry",
    description: "Read the car's OBD dongle samples and the driver's phone positions for the last N minutes: speed, revs, load, coolant, battery voltage, check-engine light, trouble codes. Phone positions are simulated in this demo.",
    input_schema: obj({ minutes: { type: "integer", description: "Look-back window in minutes, e.g. 30." } }),
  },
  get_active_codes: {
    name: "get_active_codes",
    description: "The trouble codes the car reports right now, the check-engine light state, and the freeze-frame snapshot taken when the fault appeared.",
    input_schema: obj({}),
  },
  lookup_trouble_code: {
    name: "lookup_trouble_code",
    description: "Look up one OBD trouble code in the illustrative knowledge base: what system, how severe (STOP_NOW, DRIVE_TO_SAFE_STOP, CONTINUE_AND_MONITOR), what to ask the driver. A code is a signal, not a diagnosis.",
    input_schema: obj({ code: text("e.g. P0300") }),
  },
  lookup_warning_light: {
    name: "lookup_warning_light",
    description: "Match a described dashboard light (colour, symbol, steady or flashing, message text) to the warning-light guide: severity and the safety instruction to give.",
    input_schema: obj({ description: text("The light as described or seen in a photo.") }),
  },
  analyse_photo: {
    name: "analyse_photo",
    description: "Look at a photo the driver sent (dashboard, damage, documents). Use the event id shown in the conversation as [photo, event …]. You get the image itself.",
    input_schema: obj({ event_id: text("The photo's event id.") }),
  },
  find_nearby_help: {
    name: "find_nearby_help",
    description: "Find help near the car's latest phone position: tow services, the brand's workshops, service areas or hotels. Mocked and fictional; prices are quotes and nothing is booked.",
    input_schema: obj({ kind: { type: "string", enum: ["tow", "brand_workshop", "service_area", "hotel"] } }),
  },
  search_travel_options: {
    name: "search_travel_options",
    description: "Search ferries, trains, flights or hotels after a given time. Mocked quotes, never bookings. Each option has a stable quote_id, numeric price and exact schedule; choose that quote_id in propose_action rather than inventing or parsing dates and prices.",
    input_schema: obj({
      kind: { type: "string", enum: ["ferry", "train", "flight", "hotel"] },
      from: text("Departure city or terminal."), to: text("Arrival city or terminal."), after_utc: text("ISO time, UTC."),
    }),
  },
  read_playbook: {
    name: "read_playbook",
    description: "Re-read one playbook from the rulebook.",
    input_schema: obj({ name: { type: "string", enum: [] as string[] } }),
  },
  message_driver: {
    name: "message_driver",
    description: "Send the driver on this order a message in the driver app. For questions and updates. Not for clearing them to drive.",
    input_schema: obj({ text: text("The message, short and calm.") }),
  },
  request_photo: {
    name: "request_photo",
    description: "Ask the driver for a photo. The driver app shows a camera button with your message.",
    input_schema: obj({ subject: text("What the photo should show, e.g. 'dashboard warning lights'."), message: text("Your request to the driver, one sentence.") }),
  },
  safety_instruction: {
    name: "safety_instruction",
    description: `Send the driver one approved safety instruction at once; operators see exactly what was said. Only these templates exist: ${SAFETY_TEMPLATES.map((template) => `${template.id} ("${template.text.replace("{name}, p", "P")}")`).join("; ")}. Call it again for a second instruction.`,
    input_schema: obj({ template_id: { type: "string", enum: SAFETY_TEMPLATES.map((template) => template.id) } }),
  },
  ask_site: {
    name: "ask_site",
    description: "Ask the pickup or delivery site a question about this order. Refused when the site belongs to the customer.",
    input_schema: obj({ end: { type: "string", enum: ["pickup", "delivery"] }, text: text("Your question, polite and short.") }),
  },
  update_case: {
    name: "update_case",
    description: "Set what this case is about so the control room's queue reads right: a short title, a one-to-two sentence summary of where it stands, its kind and urgency.",
    input_schema: obj({
      title: text("Short headline, e.g. 'Warning light, car stopped on the A1 near Bremen'."),
      summary: text("Where the case stands now."),
      kind: { type: "string", enum: [...CASE_KINDS] },
      urgency: { type: "string", enum: [...URGENCIES] },
    }),
  },
  wait_for: {
    name: "wait_for",
    description: "Put the case into a deliberate wait when nothing more can be done until someone else acts: who we wait on, what happens next, and when to check again. The control room shows this, and a follow-up runs when the time passes.",
    input_schema: obj({
      waiting_for: { type: "string", enum: ["driver", "site", "customer", "provider", "dispatch", "operator"] },
      waiting_on: text("In words, e.g. 'the dealer's roadside help (ETA 11:00 local)'."),
      next_action: text("What happens next and who does it, e.g. 'Check at 11:15 that roadside help arrived; then check the ferry cutoff.'"),
      check_in_minutes: { type: "integer", description: "Minutes from now (simulated clock) to check again. Work it out from 'Now' in the case notes, in UTC; the result tells you the check time in UTC and local time so you can correct it." },
    }),
  },
  hand_over: {
    name: "hand_over",
    description: "Ask the Road Desk to prepare a decision for operations once you have the facts a person needs. The decision card is built right after this conversation turn. Use it instead of trying to decide yourself.",
    input_schema: obj({ reason: text("Why a person needs to decide, in one sentence.") }),
  },
  propose_action: {
    name: "propose_action",
    description: "Bring operations one clear decision: what you recommend, what would change, the evidence, the assumptions it relies on, and what happens after yes or no. Anything that changes a booking, date, cost, driver, recovery, clearance to drive, or contacts the customer goes through here. Approving CHANGE_PROMISE only sends the question to the customer; the promise changes when they agree. Asking the dealer about recovery is not booking a tow.",
    input_schema: obj({
      action_type: { type: "string", enum: ACTION_TYPES.filter((type) => type !== "OPERATOR_DECISION") },
      title: text("The recommendation as a short imperative in under twelve words, e.g. 'Call the dealer about recovery'. The reasons go in the rationale."),
      rationale: text("Why, in two or three sentences."),
      ...handoverFields,
      changes: { type: "array", description: "What changes if approved, before → after. Empty if nothing changes in the records.", items: obj({ label: text("What"), before: text("Current value, or empty."), after: text("New value.") }) },
      draft_to: { type: "string", enum: ["none", "customer", "pickup_site", "delivery_site", "driver"], description: "Who the draft message is for, or 'none' when there is no message. 'driver' only for CLEAR_TO_CONTINUE: the instruction the driver gets once an operator approves." },
      draft_channel: { type: "string", enum: ["email", "phone_call"], description: "How it is sent. Ignored when draft_to is 'none'." },
      draft_subject: text("Email subject, or empty for a call or no draft."),
      draft_body: text("The message or call script, ready to use. Plain, polite, factual; say what is known and what is not. Empty when draft_to is 'none'."),
      draft_language: text("Language code of the draft, e.g. en, de, fi, or empty."),
      options: optionsSchema,
      evidence_refs: { type: "array", items: sourceRefSchema, description: "The sources behind this proposal." },
      assumptions: { type: "array", items: assumptionSchema, description: "The facts this card relies on. Before it executes they are rechecked; if one changed, nothing runs and you redraft it. Include the booking or record your action depends on, and the latest driver message you read." },
      window_start_utc: text("For UPDATE_ETA and CHANGE_PROMISE: start of the new window, ISO time in UTC. Otherwise empty."),
      window_end_utc: text("For UPDATE_ETA and CHANGE_PROMISE: end of the new window, ISO time in UTC. Otherwise empty."),
      booking_quote_id: text("For BOOK_TRAVEL: exact quote_id returned by search_travel_options on this case. The server copies its schedule, price and provider; never invent an id. Empty for other actions."),
      replaces_reservation_id: text("For a travel replacement: id of the original travel_reservations record or a confirmed BOOKING effect on this order. Empty for an additional booking. The original stays current until the replacement is confirmed."),
      next_step_if_approved: text("What happens right after approval, in one sentence."),
      next_step_if_rejected: text("What you will do if rejected, in one sentence."),
    }),
  },
  escalate: {
    name: "escalate",
    description: "Hand a question to operations when there is no single action to propose, e.g. facts conflict or the choice is a judgement call. Give the handover packet and the options.",
    input_schema: obj({
      question: text("The question for the operator in under twelve words, e.g. 'Call William on his phone?'. It is the card's title: the facts go in what_happened and the handover."),
      ...handoverFields,
      options: optionsSchema,
      evidence_refs: { type: "array", items: sourceRefSchema },
      next_step_if_decided: text("What you will do once they choose."),
    }),
  },
  close_case: {
    name: "close_case",
    description: "Close a routine case the agent fully handled (a driver question answered). Not allowed for warnings, breakdowns, accidents or delays.",
    input_schema: obj({ summary: text("One line: what was asked and answered.") }),
  },
}

/** Tools that only read. The operator's "Ask the agent" box gets only these. */
export const READ_ONLY_TOOLS: readonly ToolName[] = [
  "get_order_context", "get_timeline", "get_telemetry", "get_active_codes", "lookup_trouble_code", "lookup_warning_light",
  "analyse_photo", "find_nearby_help", "search_travel_options", "read_playbook",
]

/** Tools offered to each audience, in a fixed order so the prompt cache stays warm. */
export function toolsFor(audience: GateContext["audience"], readOnly = false): Anthropic.Tool[] {
  const names = (Object.keys(TOOL_DEFINITIONS) as ToolName[]).filter((name) => {
    const allowed = { driver: 0, site: 1, operator: 2 }[audience]
    return [
      ["get_order_context", "get_telemetry", "get_active_codes", "lookup_trouble_code", "lookup_warning_light", "analyse_photo", "find_nearby_help", "read_playbook", "request_photo", "safety_instruction", "update_case", "wait_for", "hand_over", "close_case"],
      ["get_order_context", "read_playbook", "hand_over", "close_case"],
      ["get_order_context", "get_timeline", "get_telemetry", "get_active_codes", "lookup_trouble_code", "lookup_warning_light", "analyse_photo", "find_nearby_help", "search_travel_options", "read_playbook", "message_driver", "request_photo", "safety_instruction", "ask_site", "update_case", "wait_for", "propose_action", "escalate", "close_case"],
    ][allowed].includes(name) && (!readOnly || READ_ONLY_TOOLS.includes(name))
  })
  const books = playbooks().map((book) => book.name)
  return names.map((name) => {
    const tool = TOOL_DEFINITIONS[name]
    const definition = name === "read_playbook" ? { ...tool, input_schema: obj({ name: { type: "string", enum: books } }) } : tool
    return { ...definition, strict: true }
  })
}

// ---------------------------------------------------------------- handlers

const json = (value: unknown) => JSON.stringify(value, null, 1)
const str = (value: unknown) => (typeof value === "string" ? value : "")

async function sendToDriver(state: TurnState, input: { body: string; channel: "driver_chat" | "safety"; data?: Record<string, unknown> }) {
  if (!state.driverId) return null
  state.sideEffects = true
  return appendEvent({
    caseId: state.caseRow.id, orderId: state.facts.id, actorType: "agent", actorId: AGENT_ID, kind: "message", channel: input.channel,
    recipientType: "driver", recipientId: state.driverId, body: input.body, data: input.data ?? {},
  })
}

/**
 * A driver message that reads as permission to drive on is not sent. It
 * becomes a CLEAR_TO_CONTINUE card with that text as the draft, so an
 * operator can approve it on purpose (PLAN.md 4.2, drivability screen).
 */
export async function holdForClearance(state: GateContext, text: string, reason: string | null): Promise<"card" | "noted"> {
  // An operator already said no to clearing this driver and nothing new has happened since (no message from the
  // driver, no logged outcome such as a finished repair): the question is not asked again. The driver got the fixed
  // "an operator has to confirm" line; the refusal is noted, and the agent reads it in the case notes.
  const rejected = (await listProposals({ caseId: state.caseRow.id, statuses: ["REJECTED"] })).filter((row) => row.actionType === "CLEAR_TO_CONTINUE").at(-1)
  if (rejected && !(rejected.decidedAt && await newFactsSince(state.caseRow.id, rejected.decidedAt))) {
    await appendEvent({
      caseId: state.caseRow.id, orderId: state.facts.id, actorType: "system", actorId: "gate", kind: "tool_call", channel: "internal",
      body: `Drivability screen held back a message that reads as permission to drive on${reason ? ` (${reason})` : ""}. An operator already rejected clearing the driver on this case (${rejected.decisionNote ?? "no reason given"}), so no new card: the driver stays stopped.`,
      data: { refused: true, rule: "drivability_screen", text, rejected_proposal_id: rejected.id },
    })
    return "noted"
  }
  await appendEvent({
    caseId: state.caseRow.id, orderId: state.facts.id, actorType: "system", actorId: "gate", kind: "tool_call", channel: "internal",
    body: `Drivability screen held back a message that reads as permission to drive on${reason ? ` (${reason})` : ""}. It is now a card for an operator.`,
    data: { refused: true, rule: "drivability_screen", text },
  })
  await submitProposal({ audience: "operator", caseRow: state.caseRow, facts: state.facts }, {
    action_type: "CLEAR_TO_CONTINUE",
    title: "Clear the driver to drive on?",
    rationale: "The agent's message to the driver read as permission to drive on. Only an operator can give that.",
    handover: { what_happened: "The agent drafted a message that would let the driver continue.", facts: [], agent_did: ["Held the message back."], unknowns: ["Whether the car is safe to drive."], recommendation: "Approve only if you are sure the car may be driven.", alternatives: ["Reject and keep the driver stopped."] },
    changes: [],
    draft_message: { to: "driver", channel: "app_chat", subject: "", body: text, language: "" },
    options: [],
    evidence_refs: [],
    assumptions: [],
    proposed_window: null,
    next_step_if_approved: "The driver gets this message from the operator and may drive on.",
    next_step_if_rejected: "The driver stays stopped; the agent tells them an operator will confirm.",
  })
  return "card"
}

const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : [])
const strings = (value: unknown): string[] => list<unknown>(value).filter((entry): entry is string => typeof entry === "string")

/** The handover packet from the flat tool parameters. */
function handoverFrom(input: Record<string, unknown>): ProposalInput["handover"] {
  return {
    what_happened: str(input.what_happened), facts: list(input.facts), agent_did: strings(input.agent_did),
    unknowns: strings(input.unknowns), recommendation: str(input.recommendation), alternatives: strings(input.alternatives),
  }
}

/** A proposal from propose_action's flat parameters. */
export function proposalFrom(input: Record<string, unknown>): ProposalInput {
  const to = str(input.draft_to)
  const start = str(input.window_start_utc).trim()
  const end = str(input.window_end_utc).trim()
  return {
    action_type: str(input.action_type) as ProposalInput["action_type"],
    title: str(input.title),
    rationale: str(input.rationale),
    handover: handoverFrom(input),
    changes: list(input.changes),
    draft_message: to && to !== "none" && str(input.draft_body).trim()
      ? {
        to: to as NonNullable<ProposalInput["draft_message"]>["to"], channel: input.draft_channel === "email" ? "email" : "phone_call",
        subject: str(input.draft_subject), body: str(input.draft_body), language: str(input.draft_language),
      }
      : null,
    options: list(input.options),
    evidence_refs: list(input.evidence_refs),
    assumptions: list(input.assumptions),
    proposed_window: start && end ? { start_utc: start, end_utc: end } : null,
    next_step_if_approved: str(input.next_step_if_approved),
    next_step_if_rejected: str(input.next_step_if_rejected),
  }
}

const handlers: Record<ToolName, (state: TurnState, input: Record<string, unknown>) => Promise<Handled>> = {
  async get_order_context(state, input) {
    const ref = str(input.order_ref).trim()
    let facts = state.facts
    if (ref && ref.toUpperCase() !== state.facts.reference) {
      const order = await resolveOrder(ref)
      const other = order ? await loadOrderFacts(order.id) : null
      if (!other) return { content: `No order ${ref}.`, isError: true }
      facts = other
    }
    const context = await contextFor(state.audience, facts, { siteEnd: state.siteEnd, driverId: state.driverId })
    return { content: json(context), log: { kind: "lookup", body: `Read the order record for ${facts.reference}`, sources: [{ kind: "orders", id: facts.id, label: `Order ${facts.reference}` }] } }
  },

  async get_timeline(state, input) {
    const ref = str(input.order_ref).trim()
    const order = ref ? await resolveOrder(ref) : { id: state.facts.id, reference: state.facts.reference }
    if (!order) return { content: `No order ${ref}.`, isError: true }
    const last = typeof input.last === "number" && input.last > 0 ? Math.min(input.last, 120) : 40
    const lines = await orderTimeline(order.id, { limit: last })
    return {
      content: lines.length ? json(lines.map((line) => ({ at: utcTime(line.at), who: line.who, channel: line.channel, text: line.text, source: line.source }))) : "No history recorded.",
      log: { kind: "lookup", body: `Read the history of ${order.reference} (${lines.length} entries)` },
    }
  },

  async get_telemetry(state, input) {
    const minutes = typeof input.minutes === "number" && input.minutes > 0 ? Math.min(input.minutes, 240) : 30
    const rows = await telemetrySince(state.facts.id, new Date(simNow().getTime() - minutes * 60000))
    if (rows.length === 0) {
      const lastObd = await latestTelemetry(state.facts.id, "OBD")
      const lastGps = await latestTelemetry(state.facts.id, "PHONE_GPS")
      return {
        content: json({ samples: 0, note: `Nothing in the last ${minutes} min.`, last_car_sample: lastObd ? relative(lastObd.at) : "never", last_phone_position: lastGps ? relative(lastGps.at) : "never" }),
        log: { kind: "lookup", body: `Checked the car and phone data for the last ${minutes} min: nothing received` },
      }
    }
    const obd = rows.filter((row) => row.source === "OBD")
    const gps = rows.filter((row) => row.source === "PHONE_GPS")
    const series = (key: keyof ObdData) => obd.map((row) => (row.data as ObdData)[key]).filter((value): value is number => typeof value === "number")
    const range = (values: number[]) => (values.length ? { first: values[0], last: values.at(-1), min: Math.min(...values), max: Math.max(...values) } : null)
    const latest = obd.at(-1)
    const lastPos = gps.at(-1)
    return {
      content: json({
        window_minutes: minutes,
        car: latest ? {
          samples: obd.length, latest_at: utcTime(latest.at), latest_age: relative(latest.at),
          check_engine_light: (latest.data as ObdData).mil, trouble_codes: (latest.data as ObdData).dtcs,
          speed_kmh: range(series("speed_kmh")), rpm: range(series("rpm")), engine_load_pct: range(series("engine_load_pct")),
          coolant_c: range(series("coolant_c")), battery_v: range(series("battery_v")), misfire_count: range(series("misfire_count")),
          state_of_charge_pct: range(series("soc_pct")),
          source: { kind: "cr_telemetry", id: latest.id, label: `OBD dongle, ${utcTime(latest.at)}`, at: latest.at.toISOString() },
        } : null,
        phone: lastPos ? {
          positions: gps.length, latest: { ...(lastPos.data as GpsData), at: utcTime(lastPos.at), age: relative(lastPos.at) },
          moving: gps.length > 1 ? (gps.at(-1)!.data as GpsData).speed_kmh : null,
          note: lastPos.simulated ? "Simulated phone GPS, not a verified position." : null,
          source: { kind: "cr_telemetry", id: lastPos.id, label: `${lastPos.simulated ? "Simulated phone GPS" : "Phone GPS"}, ${utcTime(lastPos.at)}`, at: lastPos.at.toISOString() },
        } : null,
      }),
      log: { kind: "lookup", body: `Checked the car's dongle and the driver's phone for the last ${minutes} min`, sources: latest ? [{ kind: "cr_telemetry", id: latest.id, label: `OBD dongle, ${utcTime(latest.at)}`, at: latest.at.toISOString() }] : [] },
    }
  },

  async get_active_codes(state) {
    const latest = await latestTelemetry(state.facts.id, "OBD")
    if (!latest) return { content: json({ connected: false, note: "No data from an OBD dongle on this car." }), log: { kind: "lookup", body: "Checked for trouble codes: no dongle data" } }
    const data = latest.data as ObdData
    const frames = await telemetrySince(state.facts.id, new Date(latest.at.getTime() - 60 * 60000), "OBD")
    const frame = [...frames].reverse().find((row) => (row.data as ObdData).freeze_frame)?.data as ObdData | undefined
    const source: SourceRef = { kind: "cr_telemetry", id: latest.id, label: `OBD dongle, ${utcTime(latest.at)}`, at: latest.at.toISOString() }
    return {
      content: json({
        check_engine_light: data.mil, trouble_codes: data.dtcs, reported: utcTime(latest.at), age: relative(latest.at),
        freeze_frame: frame?.freeze_frame ?? null, note: "Codes are signals from the car, not a diagnosis.", source,
      }),
      log: { kind: "lookup", body: data.dtcs.length ? `Read the car's trouble codes: ${data.dtcs.join(", ")}, check-engine light ${data.mil.toLowerCase()}` : "Read the car's trouble codes: none", sources: [source] },
    }
  },

  async lookup_trouble_code(_state, input) {
    const code = str(input.code).trim().toUpperCase()
    const entry = troubleCode(code)
    const source: SourceRef = { kind: "knowledge:dtc", id: code, label: `Trouble-code guide, ${code}` }
    if (!entry) {
      return {
        content: json({ code, found: false, note: "Not in the guide. Codes starting P1, B1, C1 or U1 are often manufacturer-specific. Treat as DRIVE_TO_SAFE_STOP until an operator decides; a dashboard photo helps." }),
        log: { kind: "lookup", body: `Looked up ${code}: not in the guide`, sources: [source] },
      }
    }
    return { content: json({ ...entry, source }), log: { kind: "lookup", body: `Looked up ${code}: ${entry.title.toLowerCase()}, ${entry.severity.replace(/_/g, " ").toLowerCase()}`, sources: [source] } }
  },

  async lookup_warning_light(_state, input) {
    const description = str(input.description)
    const matches = matchWarningLights(description).slice(0, 3)
    return {
      content: json({
        described: description,
        matches: matches.map((light) => ({ ...light, source: { kind: "knowledge:warning_lights", id: light.id, label: `Warning-light guide, ${light.name}` } })),
        note: matches.length ? "A described light is a report, not a diagnosis." : "No match. Ask for a dashboard photo.",
      }),
      log: { kind: "lookup", body: matches[0] ? `Matched the described light to: ${matches[0].name} (${matches[0].severity.replace(/_/g, " ").toLowerCase()})` : "Could not match the described light", sources: matches[0] ? [{ kind: "knowledge:warning_lights", id: matches[0].id, label: `Warning-light guide, ${matches[0].name}` }] : [] },
    }
  },

  async analyse_photo(state, input) {
    const event = await getEvent(str(input.event_id))
    if (!event || event.kind !== "photo" || event.orderId !== state.facts.id) return { content: "No photo with that id on this order.", isError: true }
    const photo = event.data as unknown as PhotoData
    let data = photo.base64 ?? null
    if (!data && photo.path) {
      const file = path.join(process.cwd(), "public", path.normalize(photo.path).replace(/^([/\\])+/, ""))
      if (!file.startsWith(path.join(process.cwd(), "public"))) return { content: "Photo path is outside the public folder.", isError: true }
      data = readFileSync(file).toString("base64")
    }
    if (!data) return { content: "The photo has no image data.", isError: true }
    const source: SourceRef = { kind: "cr_events", id: event.id, label: `Photo from the driver, ${utcTime(event.at)}`, at: event.at.toISOString() }
    // The picture is read by a vision model and reaches the agent as words: the agent's own model takes no images.
    const seen = await describePhoto(photo.media_type, data, photo.caption ?? event.body)
    if (seen) state.costUsd += seen.costUsd
    return {
      content: json({
        sent: utcTime(event.at), subject: photo.subject ?? null, caption: photo.caption ?? event.body,
        description: seen?.text ?? "The photo could not be read right now (no vision model answered). Ask the driver to describe what they see.",
        note: "What is visible in the photo, described by a vision model. A photo is evidence of what it shows, not a diagnosis.", source,
      }),
      log: { kind: "lookup", body: `Looked at the driver's photo${photo.subject ? ` of the ${photo.subject}` : ""}${seen ? "" : " (could not be read)"}`, sources: [source] },
    }
  },

  async find_nearby_help(state, input) {
    const gps = await latestTelemetry(state.facts.id, "PHONE_GPS")
    const fallback = cityCoords(String(state.facts.pickup.address.city ?? ""), String(state.facts.pickup.address.country ?? ""))
    const at = gps ? (gps.data as GpsData) : fallback
    if (!at) return { content: "No position to search from. Ask the driver where they are.", isError: true }
    const result = findNearbyHelp({ lat: at.lat, lng: at.lng, kind: (str(input.kind) || "tow") as HelpKind, make: state.facts.vehicle?.make ?? null })
    return {
      content: json({ ...result, searched_from: gps ? `the latest simulated phone position (${relative(gps.at)})` : "the pickup city (no phone position)" }),
      log: { kind: "lookup", body: `Looked for ${str(input.kind).replace("_", " ")} options near the car (mocked)`, sources: [result.source] },
    }
  },

  async search_travel_options(_state, input) {
    const result = searchTravelOptions({ kind: (str(input.kind) || "ferry") as TravelKind, from: str(input.from), to: str(input.to), after_utc: str(input.after_utc) })
    return { content: json(result), log: { kind: "lookup", body: `Searched ${str(input.kind)} quotes from ${str(input.from)} to ${str(input.to)} (mocked, nothing booked)`, sources: [result.source], data: { quote_selections: result.options.map((option) => option.booking_selection) } } }
  },

  async read_playbook(_state, input) {
    const book = playbook(str(input.name))
    return book ? { content: book.markdown, log: null } : { content: "No playbook with that name.", isError: true }
  },

  async message_driver(state, input) {
    if (!state.driverId) return { content: "There is no driver on this order to message.", isError: true }
    const screen = await screenDriverMessage(str(input.text), { safety: await loadDriverSafetyContext(state.facts, state.caseRow) })
    state.costUsd += screen.costUsd
    if (!screen.allowed) {
      const held = await holdForClearance(state, str(input.text), screen.reason)
      return { content: `Not sent: it reads as permission to drive on (${screen.reason}). ${held === "card" ? "It is now a CLEAR_TO_CONTINUE card for an operator." : "An operator already refused to clear the driver and nothing new has come in since, so the driver stays stopped."} If the message also carried facts the driver needs (a booking, a time, where to wait), send those again with message_driver without telling them to drive, leave or head anywhere; an operator clears the driver to continue.`, isError: true, gate: "REFUSED" }
    }
    await sendToDriver(state, { body: str(input.text), channel: "driver_chat", data: { screened: screen.layer } })
    return { content: `Sent to ${state.driverName ?? "the driver"}.`, log: null }
  },

  async request_photo(state, input) {
    if (!state.driverId) return { content: "There is no driver on this order to ask.", isError: true }
    await sendToDriver(state, { body: str(input.message), channel: "driver_chat", data: { request: "photo", subject: str(input.subject) } })
    return { content: `Photo request sent to ${state.driverName ?? "the driver"}.`, log: null }
  },

  async safety_instruction(state, input) {
    if (!state.driverId) return { content: "There is no driver on this order.", isError: true }
    const body = renderSafetyTemplate(str(input.template_id), firstName(state.driverName))
    if (!body) return { content: "No such safety template.", isError: true, gate: "REFUSED" }
    await sendToDriver(state, { body, channel: "safety", data: { safety: true, template_id: str(input.template_id) } })
    return { content: `Sent: "${body}"`, log: null }
  },

  async ask_site(state, input) {
    const end: End = input.end === "delivery" ? "delivery" : "pickup"
    const endpoint = end === "pickup" ? state.facts.pickup : state.facts.delivery
    const name = String(endpoint.site?.name ?? endpoint.address.name ?? "the site")
    state.sideEffects = true
    await appendEvent({
      caseId: state.caseRow.id, orderId: state.facts.id, actorType: "agent", actorId: AGENT_ID, kind: "message", channel: "site_chat",
      recipientType: "site", recipientId: endpoint.site ? String(endpoint.site.id) : `${end}:${String(endpoint.address.id)}`,
      body: str(input.text), data: { end, name },
    })
    return { content: `Asked ${name}. Their reply will arrive as a new message.`, log: null }
  },

  async update_case(state, input) {
    const kind = str(input.kind) as CaseKind
    const urgency = str(input.urgency) as Urgency
    const updated = await updateCase(state.caseRow.id, {
      title: str(input.title).slice(0, 140) || state.caseRow.title,
      summary: str(input.summary).slice(0, 600),
      kind: CASE_KINDS.includes(kind) ? kind : state.caseRow.kind,
      urgency: URGENCIES.includes(urgency) ? urgency : state.caseRow.urgency,
    })
    if (updated) state.caseRow = updated
    return { content: "Case updated.", log: null }
  },

  async wait_for(state, input) {
    // After hand_over the next step is the operator's card; a wait set now would hide the case from "Needs you".
    if (state.followUps.some((followUp) => followUp.kind === "analysis")) {
      return { content: "Not recorded: you handed this case to operations in this turn, and they decide the next step. Do not set a wait now; write your reply.", isError: true, gate: "REFUSED" }
    }
    const minutes = typeof input.check_in_minutes === "number" ? Math.min(Math.max(Math.round(input.check_in_minutes), 1), 24 * 60) : 30
    const pending = await listProposals({ caseId: state.caseRow.id, statuses: ["PENDING"] })
    const updated = await updateCase(state.caseRow.id, {
      ...(pending.length ? {} : { status: "WAITING_EXTERNAL" as const }),
      owner: "agent", waitingFor: str(input.waiting_for) as WaitingFor, waitingOn: str(input.waiting_on) || "an answer",
      nextAction: str(input.next_action) || null, nextCheckAt: new Date(simNow().getTime() + minutes * 60000),
    })
    if (updated) state.caseRow = updated
    state.waitSet = true
    const at = new Date(simNow().getTime() + minutes * 60000).toISOString()
    const zones = [...new Set([state.facts.pickup.timezone, state.facts.delivery.timezone].filter((zone): zone is string => Boolean(zone)))]
    const when = `${utcTime(at)}${zones.length ? ` = ${zones.map((zone) => localTime(at, zone)).join(" = ")}` : ""}`
    await appendEvent({
      caseId: state.caseRow.id, orderId: state.facts.id, actorType: "agent", actorId: AGENT_ID, kind: "note", channel: "internal",
      body: `Waiting on ${str(input.waiting_on)}. Next check at ${utcTime(at)}, in ${minutes} min: ${str(input.next_action)}`,
    })
    return { content: `The case waits on ${str(input.waiting_on)}. The follow-up runs in ${minutes} minutes, at ${when} (simulated clock). If that is not the time you meant, call wait_for again with the corrected minutes.`, log: null }
  },

  async hand_over(state, input) {
    const reason = str(input.reason)
    if (!state.followUps.some((followUp) => followUp.kind === "analysis")) {
      state.followUps.push({ kind: "analysis", caseId: state.caseRow.id, reason })
    }
    const updated = await updateCase(state.caseRow.id, {
      status: "AGENT_WORKING", owner: "agent", waitingOn: "the agent", waitingFor: "agent",
      nextAction: "The agent is preparing a decision for operations.", nextCheckAt: new Date(simNow().getTime() + 3 * 60000),
    })
    if (updated) state.caseRow = updated
    await appendEvent({
      caseId: state.caseRow.id, orderId: state.facts.id, actorType: "agent", actorId: AGENT_ID, kind: "note", channel: "internal",
      body: `Handing over to operations: ${reason}`,
    })
    return { content: state.audience === "driver"
      ? "Operations will get a decision card right after this turn. Now write your reply to the driver: one or two short, plain sentences on what happens next and what they should do meanwhile. Nothing about prices, quotes, cards or internal steps, and no lists or bold."
      : "Operations will get a decision card right after this turn. Tell the person you are talking to, in a sentence or two, that a colleague will come back to them.", log: null }
  },

  async propose_action(state, input) {
    const proposal = proposalFrom(input)
    const invented = await uncitableSources(state, [...proposal.handover.facts.flatMap((fact) => fact.sources ?? []), ...proposal.evidence_refs])
    if (invented.length) {
      return { content: `Not recorded: ${invented.length === 1 ? "this source is" : "these sources are"} not in the records you were shown: ${invented.map((ref) => `${ref.label ?? ref.kind} (${ref.id})`).join("; ")}. Cite the source objects exactly as the tools gave them; for a message or an operator's instruction, read get_timeline and cite its entry.`, isError: true, gate: "REFUSED" }
    }
    if (str(input.booking_quote_id).trim()) {
      const selection = await recordedTravelSelection(state.caseRow.id, str(input.booking_quote_id).trim())
      if (!selection) return { content: "Not recorded: that quote is not on this case. Search travel options and choose one returned quote_id.", isError: true, gate: "REFUSED" }
      proposal.booking_selection = { ...selection, replaces_reservation_id: str(input.replaces_reservation_id).trim() || null }
    }
    const verdict = validateProposal(proposal, state.facts)
    if (!verdict.ok) return { content: `Not recorded: ${verdict.reason}`, isError: true, gate: "REFUSED" }
    state.sideEffects = true
    const { proposal: row, level, executed } = await submitProposal(state, proposal)
    return {
      content: executed
        ? `Carried out under ${level === "AUTO" ? "automatic" : "act-and-tell"} permission and recorded: ${row.title}.`
        : `Recorded for an operator to decide: ${row.title}. Nothing changes until they approve.`,
      gate: executed ? "ALLOWED" : "PROPOSED",
      log: null,
    }
  },

  async escalate(state, input) {
    const proposal: ProposalInput = {
      action_type: "OPERATOR_DECISION",
      title: str(input.question),
      rationale: str(input.what_happened),
      handover: handoverFrom(input),
      changes: [],
      draft_message: null,
      options: list(input.options),
      evidence_refs: list(input.evidence_refs),
      assumptions: [],
      proposed_window: null,
      next_step_if_approved: str(input.next_step_if_decided),
      next_step_if_rejected: "The agent asks what to do instead.",
    }
    const verdict = validateProposal(proposal, state.facts)
    if (!verdict.ok) return { content: `Not recorded: ${verdict.reason}`, isError: true, gate: "REFUSED" }
    state.sideEffects = true
    const { proposal: row } = await submitProposal(state, proposal)
    return { content: `Question recorded for operations: ${row.title}`, gate: "PROPOSED", log: null }
  },

  async close_case(state, input) {
    const pending = await listProposals({ caseId: state.caseRow.id, statuses: ["PENDING"] })
    if (pending.length) return { content: "This case has a decision waiting for an operator; it cannot be closed.", isError: true, gate: "REFUSED" }
    if (state.audience === "site" && (state.siteEnd === "delivery" ? state.facts.delivery : state.facts.pickup).customerSide) {
      return { content: "This place belongs to the customer: your reply is held for an operator to approve, so the case stays open. Just write the reply.", isError: true, gate: "REFUSED" }
    }
    const updated = await updateCase(state.caseRow.id, { status: "HANDLED_BY_AGENT", summary: str(input.summary), owner: "agent", nextAction: null })
    if (updated) state.caseRow = updated
    state.closed = true
    await appendEvent({
      caseId: state.caseRow.id, orderId: state.facts.id, actorType: "agent", actorId: AGENT_ID, kind: "note", channel: "internal",
      body: `Handled by the agent: ${str(input.summary)}`,
    })
    return { content: "Case closed as handled by the agent.", log: null }
  },
}

/** Ids in a text: every `"id": "…"` a tool result or the case notes carried. */
export function idsIn(text: string): string[] {
  return [...text.matchAll(/"id":\s*"([^"]+)"|\b((?:evt|eff|tel|prop|case|msg|conv|ord|res|win|asg|ep|alert|inc|wi|track|veh|cust|site|drv)-[A-Za-z0-9-]+)/g)].map((match) => match[1] ?? match[2])
}

/**
 * Sources an agent cites must be records it was shown or that exist: a citation of an invented id ("msg-latest")
 * would look like evidence on the card. Guides (`knowledge:*`) are fixed files and always citable.
 */
async function uncitableSources(state: TurnState, refs: { kind?: string; id?: string; label?: string }[]): Promise<{ kind: string; id: string; label?: string }[]> {
  const unknown = refs.filter((ref) => ref?.id && !String(ref.kind ?? "").startsWith("knowledge") && !state.seenIds?.has(String(ref.id)))
    .map((ref) => ({ kind: String(ref.kind ?? ""), id: String(ref.id), label: ref.label }))
  if (!unknown.length || !state.seenIds) return []
  const ids = [...new Set(unknown.map((ref) => ref.id))]
  const found = await crDb().execute(sql`
    SELECT id FROM cr_events WHERE id IN ${ids} UNION SELECT id FROM cr_effects WHERE id IN ${ids}
    UNION SELECT id FROM cr_telemetry WHERE id IN ${ids} UNION SELECT id FROM related_records WHERE id IN ${ids}
    UNION SELECT id FROM orders WHERE id IN ${ids} UNION SELECT id FROM messages WHERE id IN ${ids}
    UNION SELECT id FROM conversations WHERE id IN ${ids} UNION SELECT id FROM alerts WHERE id IN ${ids}`)
  const exists = new Set((found as unknown as { id: string }[]).map((row) => row.id))
  return unknown.filter((ref) => !exists.has(ref.id))
}

/** Run one tool call through the gate, then the handler, and log it. */
export async function runTool(state: TurnState, name: string, rawInput: unknown): Promise<{ content: ToolContent; isError: boolean }> {
  const started = Date.now()
  const input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Record<string, unknown>
  const verdict = checkTool(state, name, input)
  const trace: ToolCallTrace = { name, input, gate: "ALLOWED", gate_reason: null, result: null, is_error: false, at: simNow().toISOString(), ms: 0 }

  let outcome: Handled
  if (!verdict.ok) {
    outcome = { content: `Refused by the approval gate: ${verdict.reason}`, isError: true, gate: "REFUSED" }
    trace.gate_reason = verdict.reason
    await appendEvent({
      caseId: state.caseRow.id, orderId: state.facts.id, actorType: "system", actorId: "gate", kind: "tool_call", channel: "internal",
      body: `Approval gate stopped the agent: ${verdict.reason}`, data: { tool: name, refused: true },
    })
  } else {
    try {
      outcome = await handlers[name as ToolName](state, input)
    } catch (error) {
      outcome = { content: `The tool failed: ${error instanceof Error ? error.message : String(error)}`, isError: true }
    }
    if (outcome.gate === "REFUSED") {
      trace.gate_reason = typeof outcome.content === "string" ? outcome.content : null
      await appendEvent({
        caseId: state.caseRow.id, orderId: state.facts.id, actorType: "system", actorId: "gate", kind: "tool_call", channel: "internal",
        body: `Approval gate stopped the agent: ${trace.gate_reason}`, data: { tool: name, refused: true },
      })
    } else if (outcome.log && !outcome.isError) {
      await appendEvent({
        caseId: state.caseRow.id, orderId: state.facts.id, actorType: "agent", actorId: AGENT_ID, kind: outcome.log.kind, channel: "internal",
        body: outcome.log.body, sourceRefs: outcome.log.sources ?? [], data: { ...outcome.log.data, tool: name },
      })
    }
  }

  trace.gate = outcome.gate ?? "ALLOWED"
  trace.is_error = Boolean(outcome.isError)
  // After a refusal a model tends to explain it; on a driver or site turn that explanation would be sent as the reply.
  if (outcome.isError && state.audience !== "operator" && typeof outcome.content === "string") {
    outcome.content += ` Your final text still goes to ${state.audience === "driver" ? "the driver" : "the site"} as your reply: write only the message to them, nothing about tools or cases.`
  }
  if (typeof outcome.content === "string") for (const id of idsIn(outcome.content)) state.seenIds?.add(id)
  trace.result = typeof outcome.content === "string" ? outcome.content.slice(0, 4000) : "[image and text]"
  trace.ms = Date.now() - started
  state.traces.push(trace)
  return { content: outcome.content, isError: Boolean(outcome.isError) }
}

export type { ActorType }
