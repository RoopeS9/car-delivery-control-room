// Transcript of record for driver calls (PLAN.md 4.6). Voice owns these two
// tables. No foreign keys into starter tables: the starter's reseed refuses
// to run otherwise, so `order_id` and `driver_id` are plain text.

import { boolean, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core"
import type { CallSlots, CallState, TurnFlags } from "./types"

export const crCalls = pgTable("cr_calls", {
  id: text("id").primaryKey(),
  caseId: text("case_id"),
  orderId: text("order_id").notNull(),
  driverId: text("driver_id").notNull(),
  /** 'AGENT_INITIATED' | 'DRIVER_INITIATED' */
  direction: text("direction").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  /** 'EMERGENCY' | 'URGENT' | 'ROUTINE', null until the driver answers the opening */
  urgency: text("urgency"),
  urgencyTurnId: text("urgency_turn_id"),
  situation: text("situation"),
  /** Each slot: { value, turn_id, quote, confidence } */
  slots: jsonb("slots").$type<CallSlots>().notNull().default({}),
  readbackConfirmed: boolean("readback_confirmed").notNull().default(false),
  endReason: text("end_reason"),
  recordingKey: text("recording_key"),
  /** When we told the driver we would get back to them (stream A's follow-up trigger reads this). */
  nextCheckAt: timestamp("next_check_at", { withTimezone: true }),
  /** Voice addition to the plan's fields: interview phase, context facts, urgency quote, triggers, spend. */
  state: jsonb("state").$type<CallState>().notNull(),
}, (table) => [index("cr_calls_order_idx").on(table.orderId, table.startedAt)])

export const crCallTurns = pgTable("cr_call_turns", {
  id: text("id").primaryKey(),
  callId: text("call_id").notNull(),
  seq: integer("seq").notNull(),
  /** 'agent' | 'driver' */
  speaker: text("speaker").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  textLive: text("text_live"),
  textFinal: text("text_final"),
  sttModel: text("stt_model"),
  audioKey: text("audio_key"),
  interrupted: boolean("interrupted").notNull().default(false),
  /** Voice addition: safety templates used, screen results, silence. */
  flags: jsonb("flags").$type<TurnFlags>().notNull().default({}),
}, (table) => [index("cr_call_turns_call_idx").on(table.callId, table.seq)])
