// Our tables, beside the starter's. No foreign keys into starter tables: the
// starter's reseed truncates its own tables and would refuse otherwise. Order
// ids are plain text. Every table is prefixed `cr_`.

import { boolean, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core"
import type {
  ActionType, ActorType, Assumption, Audience, AutonomyLevel, CaseKind, CaseStatus, Channel, DraftMessage, EffectAuthority,
  EffectKind, EffectState, EventKind, HandoverPacket, ProposalChange, ProposalOption, ProposalStatus, RunStatus, SourceRef,
  TelemetrySource, ToolCallTrace, Urgency, WaitingFor, BookingSelection,
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
  /**
   * Every case outside RESOLVED / HANDLED_BY_AGENT always has these three
   * (PLAN.md 4.2): what happens next and who does it, who or what we wait
   * on, and when we look again (simulated clock).
   */
  nextAction: text("next_action"),
  /** In words: "the driver's reply", "the shift lead to log what happened", "an operator's decision". */
  waitingOn: text("waiting_on"),
  /** Who we wait on, as a code the follow-up logic can act on. */
  waitingFor: text("waiting_for").$type<WaitingFor>(),
  nextCheckAt: at("next_check_at"),
  /** When the current wait began, so a follow-up can tell whether the awaited thing happened since. */
  waitingSince: at("waiting_since"),
  /** Follow-ups already done on the current wait (one reminder, then escalate). */
  followUps: integer("follow_ups").notNull().default(0),
  /** Open dataset records this case takes over (work items, incidents, alerts, agent proposals, endpoint claims). */
  linkedRecords: jsonb("linked_records").$type<SourceRef[]>().notNull().default([]),
  /** Outcome of the latest agent run on this case, for the watchdog. */
  lastRunStatus: text("last_run_status").$type<RunStatus>(),
  lastRunAt: at("last_run_at"),
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
  /** 1 for a first draft; a redraft after OUTDATED is a new row with the next revision. */
  revision: integer("revision").notNull().default(1),
  /** The card this one redrafts, when it is a later revision. */
  revisesProposalId: text("revises_proposal_id"),
  actionType: text("action_type").$type<ActionType>().notNull(),
  /** The recommendation as a short imperative: "Call the dealer about recovery". */
  title: text("title").notNull(),
  rationale: text("rationale").notNull(),
  handover: jsonb("handover").$type<HandoverPacket>(),
  changes: jsonb("changes").$type<ProposalChange[]>().notNull().default([]),
  draftMessage: jsonb("draft_message").$type<DraftMessage>(),
  /** Exact selected quote. Nullable for old proposals; BOOK_TRAVEL cannot execute without it. */
  bookingSelection: jsonb("booking_selection").$type<BookingSelection>(),
  evidenceRefs: jsonb("evidence_refs").$type<SourceRef[]>().notNull().default([]),
  /** What the card relied on. Rechecked against the effective state before anything executes. */
  assumptions: jsonb("assumptions").$type<Assumption[]>().notNull().default([]),
  options: jsonb("options").$type<ProposalOption[]>().notNull().default([]),
  nextStepIfApproved: text("next_step_if_approved").notNull(),
  nextStepIfRejected: text("next_step_if_rejected").notNull(),
  status: text("status").$type<ProposalStatus>().notNull(),
  createdAt: at("created_at").notNull(),
  createdBy: text("created_by").notNull(),
  decidedBy: text("decided_by"),
  decidedAt: at("decided_at"),
  /** The revision the operator saw and approved. */
  decidedRevision: integer("decided_revision"),
  /** Reason on reject, or the operator's note on approve. Goes back to the agent. */
  decisionNote: text("decision_note"),
  /** Option the operator picked, when the card had options. */
  chosenOptionId: text("chosen_option_id"),
  /** Operator's edited draft, when they changed it before approving. */
  editedDraftMessage: jsonb("edited_draft_message").$type<DraftMessage>(),
  /** What actually happens now, in words. Set when decided. */
  nextStep: text("next_step"),
  /** `<proposal id>:<revision>`, unique: a double click or a retried request never executes twice. */
  executionKey: text("execution_key").unique(),
  executedAt: at("executed_at"),
  executionResult: jsonb("execution_result").$type<Record<string, unknown>>(),
}, (table) => [
  index("cr_proposals_case_idx").on(table.caseId, table.createdAt),
  index("cr_proposals_status_idx").on(table.status),
])

/**
 * Executed changes, layered over the dataset (which is never edited). Read
 * them through `lib/cr/effective.ts`. A promise change only counts once the
 * customer's agreement is recorded with its evidence.
 */
export const crEffects = pgTable("cr_effects", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull(),
  caseId: text("case_id"),
  proposalId: text("proposal_id"),
  kind: text("kind").$type<EffectKind>().notNull(),
  /** What it applies to, e.g. `{ table: "time_windows", id, field: "promise" }` or `{ driver_id }`. */
  target: jsonb("target").$type<Record<string, unknown>>().notNull().default({}),
  /** The new value, e.g. `{ start, end, zone }`, `{ reference, provider }`, `{ text }`. */
  value: jsonb("value").$type<Record<string, unknown>>().notNull().default({}),
  state: text("state").$type<EffectState>().notNull(),
  /** Who authorised it, and on what evidence. */
  authority: jsonb("authority").$type<EffectAuthority>().notNull(),
  evidenceRefs: jsonb("evidence_refs").$type<SourceRef[]>().notNull().default([]),
  at: at("at").notNull(),
  /** The earlier effect this one replaces (e.g. CUSTOMER_AGREED replacing PROPOSED_TO_CUSTOMER). */
  supersedesId: text("supersedes_id"),
}, (table) => [index("cr_effects_order_idx").on(table.orderId, table.kind, table.at)])

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
