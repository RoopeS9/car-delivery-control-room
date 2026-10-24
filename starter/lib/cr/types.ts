// The shared contract for everything team Random adds on top of the starter:
// cases, their timeline, decision cards (proposals), telemetry, autonomy
// levels and agent run traces. All three workstreams build against these
// names. Change them only after telling the team (PLAN.md section 6).

// ---------------------------------------------------------------- cases

export const CASE_KINDS = [
  "VEHICLE_WARNING", "BREAKDOWN", "ACCIDENT", "DELAY", "MISSED_CONNECTION", "KEYS_ACCESS", "EXPENSE",
  "DRIVER_QUESTION", "SITE_QUESTION", "OPERATOR_QUESTION",
] as const
export type CaseKind = (typeof CASE_KINDS)[number]

/** Queue order on the "Needs you" page follows this list. */
export const CASE_STATUSES = ["NEEDS_DECISION", "AGENT_WORKING", "WAITING_EXTERNAL", "HANDLED_BY_AGENT", "RESOLVED"] as const
export type CaseStatus = (typeof CASE_STATUSES)[number]

/** Statuses that keep a case in front of a person. */
export const OPEN_CASE_STATUSES: readonly CaseStatus[] = ["NEEDS_DECISION", "AGENT_WORKING", "WAITING_EXTERNAL"]

export const URGENCIES = ["CRITICAL", "HIGH", "NORMAL", "LOW"] as const
export type Urgency = (typeof URGENCIES)[number]

// ---------------------------------------------------------------- timeline

export const ACTOR_TYPES = ["driver", "site", "customer", "operator", "agent", "obd", "phone", "system"] as const
export type ActorType = (typeof ACTOR_TYPES)[number]

export const EVENT_KINDS = [
  "message", "voice_turn", "photo", "telemetry_snapshot", "dtc", "lookup", "tool_call", "proposal", "decision",
  "effect", "note",
] as const
export type EventKind = (typeof EVENT_KINDS)[number]

/**
 * Where an event happened. The driver app shows `driver_chat` and
 * `driver_voice`; the site chat shows `site_chat`; the operator's
 * "Ask the agent" box uses `operator_chat`. `safety` marks an immediate
 * safety instruction to the driver so it is never hidden.
 */
export const CHANNELS = [
  "driver_chat", "driver_voice", "site_chat", "operator_chat", "customer_email", "internal", "telemetry", "system",
  "safety",
] as const
export type Channel = (typeof CHANNELS)[number]

/** Who the agent is talking to in a turn. Decides tone, tools and what it may see. */
export const AUDIENCES = ["driver", "site", "operator"] as const
export type Audience = (typeof AUDIENCES)[number]

/**
 * A pointer from a fact to the record it came from. `kind` is a dataset
 * collection (`messages`, `alerts`, `time_windows`, ...), one of our tables
 * (`cr_events`, `cr_telemetry`), or a knowledge source (`knowledge:dtc`,
 * `knowledge:warning_lights`, `rulebook:<playbook>`, `mock:nearby_help`,
 * `mock:travel`). `label` is what the UI prints on the chip, e.g.
 * "Driver, app chat". `at` is when the source said it, if known.
 */
export type SourceRef = { kind: string; id: string; label: string; at?: string | null }

// ---------------------------------------------------------------- proposals

/**
 * `OPERATOR_DECISION` is an escalation: a question with options and no single
 * action behind it (the agent's `escalate` tool). It still renders as a
 * decision card; the chosen option goes back to the agent.
 */
export const ACTION_TYPES = [
  "CONTACT_CUSTOMER", "UPDATE_ETA", "CHANGE_PROMISE", "BOOK_RECOVERY", "BOOK_TRAVEL", "APPROVE_EXPENSE",
  "REASSIGN_DRIVER", "CLEAR_TO_CONTINUE", "CONTACT_SITE_AS_CUSTOMER", "OPERATOR_DECISION",
] as const
export type ActionType = (typeof ACTION_TYPES)[number]

export const PROPOSAL_STATUSES = ["PENDING", "APPROVED", "EDITED_AND_APPROVED", "REJECTED", "EXECUTED", "FAILED"] as const
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number]

/** One line of "what changes if you approve": before → after. */
export type ProposalChange = { label: string; before: string | null; after: string }

/** A message the agent drafted. A person approves it before it goes out. */
export type DraftMessage = {
  to_type: "customer" | "site" | "driver"
  to_id: string
  to_name: string
  channel: "email" | "phone_call" | "app_chat" | "sms"
  subject?: string | null
  body: string
  language?: string | null
}

/** A choice on the decision card, e.g. "Dealer's own roadside assistance". */
export type ProposalOption = { id: string; label: string; description?: string | null; recommended?: boolean }

/** A fact on the handover packet, always with where it came from. */
export type SourcedFact = { text: string; sources: SourceRef[] }

/**
 * Everything a decision card is built from (PLAN.md 4.2). The agent fills
 * this; the UI renders it top to bottom.
 */
export type HandoverPacket = {
  what_happened: string
  facts: SourcedFact[]
  agent_did: string[]
  unknowns: string[]
  recommendation: string
  alternatives: string[]
}

// ---------------------------------------------------------------- API (stream A routes, used by the UI)

/** POST here to decide a proposal. Body: `DecisionRequest`. Response: `DecisionResponse`. */
export const decisionPath = (caseId: string, proposalId: string) => `/api/cases/${caseId}/proposals/${proposalId}/decide`

/**
 * The decision buttons (PLAN.md 4.2b):
 * - `approve`: carry it out. Send `edited_draft_message` for "Edit and approve".
 * - `reject`: `note` is the one-line reason; it goes back to the agent.
 * - `handle`: "I'll handle it". The operator does it outside the system (e.g.
 *   a phone call); the case then waits for "Log what happened" (`outcomePath`).
 * - `instruct`: "Tell the agent instead". `note` is the instruction; the card
 *   is set aside and the agent's next turn follows the instruction.
 */
export type DecisionRequest = {
  decision: "approve" | "reject" | "handle" | "instruct"
  /** Operator role id, e.g. `ops-shift`. No login in this prototype. */
  decided_by: string
  note?: string | null
  /** The option picked when the card had options. */
  option_id?: string | null
  /** The operator's edited draft. Turns an approval into EDITED_AND_APPROVED. */
  edited_draft_message?: DraftMessage | null
}

export type DecisionResponse = {
  proposal_id: string
  status: ProposalStatus
  /** What happens now, in words, for the "what happens next" line. */
  next_step: string
  case_status: CaseStatus
  error?: string
}

/** POST here for the "Ask the agent" box. Body: `AskAgentRequest`. Response: `AskAgentResponse`. */
export const askAgentPath = "/api/agent/ask"

export type AskAgentRequest = {
  /** One of the two. A case wins; an order reference opens or reuses the order's open case. */
  case_id?: string | null
  order_ref?: string | null
  text: string
  /** Operator role id, e.g. `ops-shift`. */
  asked_by: string
}

export type AskAgentResponse = { case_id: string; reply: string; run_id: string | null; error?: string }

/** POST here for "Log what happened" after "I'll handle it". Body: `LogOutcomeRequest`. */
export const outcomePath = (caseId: string) => `/api/cases/${caseId}/outcome`

export type LogOutcomeRequest = {
  /** One line, e.g. "Dealer sends their own roadside help, ETA 11:00". */
  text: string
  logged_by: string
  /** The card the outcome belongs to. Defaults to the case's card waiting on an outcome. */
  proposal_id?: string | null
}

/**
 * POST here when a card says "Facts changed since this was drafted" and the
 * operator asks for a fresh one. Body: `{ by }`. The old card is set aside
 * (REJECTED with a note) and the agent drafts a new one in the background.
 * Response: `CaseActionResponse`. Which cards are out of date: the
 * `facts_changed` list on GET /api/cases/{id}, or `proposalsWithChangedFacts()`.
 */
export const refreshPath = (caseId: string, proposalId: string) => `/api/cases/${caseId}/proposals/${proposalId}/refresh`

/** POST here to give the agent a free-text instruction on a case. Body: `InstructRequest`. */
export const instructPath = (caseId: string) => `/api/cases/${caseId}/instruct`

export type InstructRequest = { text: string; by: string }

/** Response of the decision, outcome and instruct routes when the agent continues in the background. */
export type CaseActionResponse = { case_id: string; case_status: CaseStatus; next_step: string | null; error?: string }

// ---------------------------------------------------------------- channels (PLAN.md 4.2c)

/** POST /api/channels/driver/messages. Response: text/event-stream of `ChannelStreamEvent`. */
export type DriverMessageRequest = {
  orderRef: string
  driverId: string
  text: string
  mode: "chat" | "voice"
  /** Ids from POST /api/channels/photos. */
  photoIds?: string[]
}

/**
 * POST /api/channels/site/messages. `siteContactId` is the order's endpoint
 * detail id (`ep-…`) or the site id (`site-…`) of the pickup or delivery place.
 */
export type SiteMessageRequest = Omit<DriverMessageRequest, "driverId"> & { siteContactId: string }

/**
 * Server-sent events: `event: text_delta` `data: {"text": "..."}`, then
 * `event: done` `data: {"caseId","replyEventId","heldForApproval"}`, or
 * `event: error` `data: {"message"}`. `heldForApproval` is true when the
 * reply would reach the customer and waits for a person instead.
 */
export type ChannelStreamEvent =
  | { event: "text_delta"; data: { text: string } }
  | { event: "done"; data: { caseId: string; replyEventId: string | null; heldForApproval: boolean } }
  | { event: "error"; data: { message: string } }

/** POST /api/channels/photos, multipart: `file` (PNG/JPEG/WebP, ≤ 5 MB), `orderRef`, optional `subject` and `caption`. */
export type PhotoUploadResponse = { photoId: string }

/** GET /api/channels/driver/{driverId}/feed?since=ISO (and /api/channels/site/{siteContactId}/feed). */
export type FeedResponse = { now: string; messages: FeedMessage[] }

export type FeedMessage = {
  id: string
  at: string
  caseId: string | null
  orderId: string
  /** Who wrote it. */
  from: ActorType
  fromName: string
  /** `safety` is an immediate safety instruction; show it prominently and, in voice mode, ring. */
  kind: "message" | "safety" | "photo_request"
  text: string
  photoRequest?: { subject: string } | null
}

// ---------------------------------------------------------------- cases API

/** GET /api/cases?since=ISO: open cases plus anything changed since `since`. */
export type CasesResponse = {
  now: string
  cases: (CaseSummary & { pending_proposals: number })[]
  handled_by_agent_today: number
}

/** GET /api/cases/{id}?since=ISO: the case, all its proposals, and its events (since `since` if given). */
export type CaseSummary = {
  id: string; order_id: string; order_ref: string; kind: CaseKind; status: CaseStatus; urgency: Urgency
  title: string; summary: string; owner: string | null; waiting_on: string | null; next_step: string | null
  next_check_at: string | null; opened_at: string; updated_at: string
}

/** POST /api/agent/telemetry: the simulator reports a fault; the agent contacts the driver first. */
export type TelemetryTriggerRequest = {
  orderRef: string
  /** Trouble codes now active, e.g. ["P0300", "P0302"]. */
  codes: string[]
  mil: MilState
  /** One line on what the car shows, e.g. "reduced power message". */
  note?: string | null
  /** The `dtc` event the simulator already wrote, if any. Otherwise the route writes one. */
  eventId?: string | null
}

// ---------------------------------------------------------------- autonomy

export const AUTONOMY_LEVELS = ["ASK_FIRST", "DO_AND_TELL", "AUTO"] as const
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number]

/** Action types that can never leave ASK_FIRST (brief: never contact a customer alone). */
export const LOCKED_ACTIONS: readonly ActionType[] = ["CONTACT_CUSTOMER", "CONTACT_SITE_AS_CUSTOMER"]

// ---------------------------------------------------------------- telemetry

export const TELEMETRY_SOURCES = ["OBD", "PHONE_GPS"] as const
export type TelemetrySource = (typeof TELEMETRY_SOURCES)[number]

export type MilState = "OFF" | "ON" | "FLASHING"

/** One OBD2 dongle sample. Electric cars report a reduced set; missing means not reported. */
export type ObdData = {
  speed_kmh?: number
  rpm?: number
  engine_load_pct?: number
  throttle_pct?: number
  coolant_c?: number
  battery_v?: number
  fuel_trim_short_pct?: number
  fuel_trim_long_pct?: number
  misfire_count?: number
  soc_pct?: number
  mil: MilState
  dtcs: string[]
  /** Present on the detailed snapshot the dongle sends when a fault appears. */
  freeze_frame?: { code: string; at: string; values: Record<string, number> } | null
}

/** One simulated phone position. `place_label` is a human name for the spot, if known. */
export type GpsData = {
  lat: number
  lng: number
  accuracy_m?: number
  speed_kmh?: number
  heading?: number
  place_label?: string | null
}

/**
 * `cr_events.data` for a `photo` event. Give the image either inline
 * (`base64`) or as a file under `starter/public/` (`path`, e.g.
 * `/demo/dashboard-584.png`). PNG, JPEG or WebP only: the agent reads it with
 * vision. Every image must be generated or drawn, never a real photo.
 */
export type PhotoData = {
  media_type: "image/png" | "image/jpeg" | "image/webp"
  base64?: string
  path?: string
  /** What the photo is meant to show, e.g. "dashboard", "damage front left". */
  subject?: string | null
  caption?: string | null
}

/** `cr_events.data` for a `message` event with `kind: "photo_request"`: the driver app shows a camera button. */
export type PhotoRequestData = { request: "photo"; subject: string }

// ---------------------------------------------------------------- agent runs

export type ToolCallTrace = {
  name: string
  input: unknown
  /** What the gate decided before the tool ran. */
  gate: "ALLOWED" | "PROPOSED" | "REFUSED"
  gate_reason?: string | null
  result: unknown
  is_error: boolean
  at: string
  ms: number
}

export type RunStatus = "RUNNING" | "DONE" | "ERROR"
