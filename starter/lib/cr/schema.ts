// Our tables, beside the starter's. No foreign keys into starter tables: the
// starter's reseed truncates its own tables and would refuse otherwise. Order
// ids are plain text. Every table is prefixed `cr_`.

import { boolean, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core"
import type {
  ActionType, ActorType, Audience, AutonomyLevel, CaseKind, CaseStatus, Channel, DraftMessage, EventKind,
  HandoverPacket, ProposalChange, ProposalOption, ProposalStatus, RunStatus, SourceRef, TelemetrySource,
  ToolCallTrace, Urgency,
} from "./types"

const at = (name: string) => timestamp(name, { withTimezone: true })

export const crCases = pgTable("cr_cases", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull(),
  kind: text("kind").$type<CaseKind>().notNull(),
  status: text("status").$type<CaseStatus>().notNull(),
  urgency: text("urgency").$type<Urgency>().notNull(),
  /** Short headline, e.g. "Warning light, car stopped near Hamburg". */
  title: text("title").notNull(),
  /** One or two sentences on where the case stands now. */
  summary: text("summary").notNull().default(""),
  /** The channel the case started on, e.g. `driver_voice`, `site_chat`, `telemetry`. */
  channelOpened: text("channel_opened").$type<Channel>().notNull(),
  openedAt: at("opened_at").notNull(),
  updatedAt: at("updated_at").notNull(),
  resolvedAt: at("resolved_at"),
  /** `agent`, an operator role id such as `ops-shift`, or null when nobody owns it yet. */
  owner: text("owner"),
  /** Driver on the case, when there is one. */
  driverId: text("driver_id"),
  /** Who we wait on while WAITING_EXTERNAL, in words: "the dealer", "the driver's photo". */
  waitingOn: text("waiting_on"),
  /** What happens next, in words, after the latest decision. */
  nextStep: text("next_step"),
  /** Existing dataset records this case builds on (alerts, work items, incidents). */
  sourceRefs: jsonb("source_refs").$type<SourceRef[]>().notNull().default([]),
}, (table) => [
  index("cr_cases_order_idx").on(table.orderId),
  index("cr_cases_status_idx").on(table.status, table.updatedAt),
])

export const crEvents = pgTable("cr_events", {
  id: text("id").primaryKey(),
  caseId: text("case_id"),
  orderId: text("order_id").notNull(),
  at: at("at").notNull(),
  actorType: text("actor_type").$type<ActorType>().notNull(),
  /** Driver id, operator role id, agent id (`road-agent`), site id, `obd`, `phone`... */
  actorId: text("actor_id"),
  kind: text("kind").$type<EventKind>().notNull(),
  channel: text("channel").$type<Channel>().notNull(),
  recipientType: text("recipient_type").$type<ActorType>(),
  recipientId: text("recipient_id"),
  /** Plain-language text for the timeline. Never JSON. */
  body: text("body").notNull(),
  data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
  sourceRefs: jsonb("source_refs").$type<SourceRef[]>().notNull().default([]),
}, (table) => [
  index("cr_events_case_idx").on(table.caseId, table.at),
  index("cr_events_order_idx").on(table.orderId, table.at),
])

export const crProposals = pgTable("cr_proposals", {
  id: text("id").primaryKey(),
  caseId: text("case_id").notNull(),
  orderId: text("order_id").notNull(),
  actionType: text("action_type").$type<ActionType>().notNull(),
  /** The recommendation as a short imperative: "Call the dealer about recovery". */
  title: text("title").notNull(),
  rationale: text("rationale").notNull(),
  handover: jsonb("handover").$type<HandoverPacket>(),
  changes: jsonb("changes").$type<ProposalChange[]>().notNull().default([]),
  draftMessage: jsonb("draft_message").$type<DraftMessage>(),
  evidenceRefs: jsonb("evidence_refs").$type<SourceRef[]>().notNull().default([]),
  options: jsonb("options").$type<ProposalOption[]>().notNull().default([]),
  nextStepIfApproved: text("next_step_if_approved").notNull(),
  nextStepIfRejected: text("next_step_if_rejected").notNull(),
  status: text("status").$type<ProposalStatus>().notNull(),
  createdAt: at("created_at").notNull(),
  createdBy: text("created_by").notNull(),
  decidedBy: text("decided_by"),
  decidedAt: at("decided_at"),
  /** Reason on reject, or the operator's note on approve. Goes back to the agent. */
  decisionNote: text("decision_note"),
  /** Option the operator picked, when the card had options. */
  chosenOptionId: text("chosen_option_id"),
  /** Operator's edited draft, when they changed it before approving. */
  editedDraftMessage: jsonb("edited_draft_message").$type<DraftMessage>(),
  /** What actually happens now, in words. Set when decided. */
  nextStep: text("next_step"),
  executedAt: at("executed_at"),
  execution: jsonb("execution").$type<Record<string, unknown>>(),
}, (table) => [
  index("cr_proposals_case_idx").on(table.caseId, table.createdAt),
  index("cr_proposals_status_idx").on(table.status),
])

export const crTelemetry = pgTable("cr_telemetry", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull(),
  vehicleId: text("vehicle_id"),
  at: at("at").notNull(),
  source: text("source").$type<TelemetrySource>().notNull(),
  /** `ObdData` for OBD, `GpsData` for PHONE_GPS. */
  data: jsonb("data").$type<Record<string, unknown>>().notNull(),
  simulated: boolean("simulated").notNull().default(true),
}, (table) => [index("cr_telemetry_order_idx").on(table.orderId, table.source, table.at)])

export const crAutonomy = pgTable("cr_autonomy", {
  actionType: text("action_type").$type<ActionType>().primaryKey(),
  level: text("level").$type<AutonomyLevel>().notNull(),
  locked: boolean("locked").notNull().default(false),
  updatedBy: text("updated_by"),
  updatedAt: at("updated_at"),
})

export const crAgentRuns = pgTable("cr_agent_runs", {
  id: text("id").primaryKey(),
  caseId: text("case_id"),
  orderId: text("order_id"),
  audience: text("audience").$type<Audience>().notNull(),
  startedAt: at("started_at").notNull(),
  finishedAt: at("finished_at"),
  status: text("status").$type<RunStatus>().notNull(),
  model: text("model").notNull(),
  effort: text("effort"),
  /** The message that started the turn. */
  input: text("input").notNull(),
  toolCalls: jsonb("tool_calls").$type<ToolCallTrace[]>().notNull().default([]),
  /** Final text the agent said to its audience. */
  output: text("output"),
  stopReason: text("stop_reason"),
  usage: jsonb("usage").$type<Record<string, unknown>>(),
  error: text("error"),
}, (table) => [index("cr_agent_runs_case_idx").on(table.caseId, table.startedAt)])
