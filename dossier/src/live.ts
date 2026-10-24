// Live classes produced by our pipeline rather than the dataset: telemetry, robo-calls and operator actions.
// Same rule as the generated records: strict objects, closed enums, one exact value type per slot.
import { z } from "zod"
import { Id, IsoDateTime, Text } from "./primitives"

// ------------------------------------------------------------------ telemetry

const Simulated = z.boolean().describe("true for every sample in the hackathon build; the UI must say so")

export const GpsFix = z.object({
  kind: z.literal("GPS"),
  id: Id, orderId: Id, assignmentId: Id, at: IsoDateTime, receivedAt: IsoDateTime,
  lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180),
  accuracyM: z.number().nonnegative(), speedKmh: z.number().nonnegative().nullable(), headingDeg: z.number().min(0).lt(360).nullable(),
  source: z.literal("DRIVER_PHONE"), simulated: Simulated,
}).strict()

export const DtcCode = z.string().regex(/^[PCBU][0-3][0-9A-F]{3}$/)
export const ObdReading = z.object({
  kind: z.literal("OBD"),
  id: Id, orderId: Id, vehicleId: Id, at: IsoDateTime, receivedAt: IsoDateTime,
  pids: z.object({
    speedKmh: z.number().nonnegative().nullable(),
    rpm: z.number().nonnegative().nullable(),
    engineLoadPct: z.number().min(0).max(100).nullable(),
    coolantC: z.number().nullable(),
    batteryV: z.number().nullable(),
    throttlePct: z.number().min(0).max(100).nullable(),
    shortFuelTrimPct: z.number().nullable(),
    longFuelTrimPct: z.number().nullable(),
  }).strict(),
  mil: z.enum(["OFF", "ON", "FLASHING"]),
  dtcs: z.array(z.object({ code: DtcCode, status: z.enum(["PENDING", "CONFIRMED", "PERMANENT"]) }).strict()),
  freezeFrame: z.object({ dtc: DtcCode, speedKmh: z.number().nullable(), rpm: z.number().nullable(), coolantC: z.number().nullable(), engineLoadPct: z.number().nullable() }).strict().nullable(),
  /** Standard OBD2 is thin on electric cars; say which PIDs the car does not report rather than inventing zeros. */
  unsupportedPids: z.array(z.enum(["rpm", "coolantC", "shortFuelTrimPct", "longFuelTrimPct", "engineLoadPct", "throttlePct"])),
  source: z.literal("OBD_DONGLE"), simulated: Simulated,
}).strict()

export const TelemetrySample = z.discriminatedUnion("kind", [GpsFix, ObdReading])
export type TelemetrySample = z.infer<typeof TelemetrySample>

// ------------------------------------------------------------------ robo-calls

/** Who may be called. Customers (anyone who pays, incl. their own sites) are not in this list on purpose. */
export const Callee = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("DRIVER"), driverId: Id, name: Text }).strict(),
  z.object({ kind: z.literal("PICKUP_SITE_DESK"), siteId: Id.nullable(), endpointDetailId: Id, name: Text }).strict(),
  z.object({ kind: z.literal("HANDOFF_CONTACT"), endpointDetailId: Id, name: Text }).strict(),
  z.object({ kind: z.literal("TRANSFER_YARD"), siteId: Id, name: Text }).strict(),
])
export type Callee = z.infer<typeof Callee>

/** Inbound triage, asked first on every driver-initiated call (mirrors the interviewer's urgency-first rule). */
export const Urgency = z.enum(["EMERGENCY", "URGENT", "ROUTINE"])
export type Urgency = z.infer<typeof Urgency>
export const Situation = z.enum(["WARNING_LIGHT", "BREAKDOWN", "ACCIDENT", "DELAY", "KEYS_ACCESS", "EXPENSE", "OTHER_QUESTION"])
export type Situation = z.infer<typeof Situation>
/** Questions a call may ask after triage, by urgency: an emergency call stays short. */
export const MAX_QUESTIONS: Record<Urgency, number> = { EMERGENCY: 3, URGENT: 6, ROUTINE: 4 }

export const CallPurpose = z.enum([
  "PICKUP_READINESS",        // car present, keys, releaser, release paper, hours, access route
  "DRIVER_START_CHECK",      // travel booked, start point, fit to drive, ETA to pickup
  "POSITION_CHECK",          // where is the car now, ETA, anything wrong
  "FERRY_CHECKIN",           // checked in at the gate, boarding expected
  "RECEIVER_CONFIRMATION",   // non-customer handoff contact: present, named, can sign
  "DRIVER_INBOUND",          // the driver called us
])
export type CallPurpose = z.infer<typeof CallPurpose>

/** Slots a call can extract. Each slot has exactly one value type. */
export const SlotValue = z.discriminatedUnion("slot", [
  z.object({ slot: z.literal("VEHICLE_PRESENT"), value: z.boolean() }).strict(),
  z.object({ slot: z.literal("VEHICLE_IDENTITY_MATCH"), value: z.enum(["VIN_MATCH", "PLATE_MATCH", "MISMATCH", "NOT_CHECKED"]) }).strict(),
  z.object({ slot: z.literal("KEYS_AT_SITE"), value: z.boolean() }).strict(),
  z.object({ slot: z.literal("RELEASE_CONTACT_NAME"), value: Text }).strict(),
  z.object({ slot: z.literal("RELEASE_DOCUMENT_PRESENT"), value: z.boolean() }).strict(),
  z.object({ slot: z.literal("COMMERCIAL_HOLD"), value: z.boolean() }).strict(),
  z.object({ slot: z.literal("ACCESS_INSTRUCTION"), value: Text }).strict(),
  z.object({ slot: z.literal("OPEN_DURING_SLOT"), value: z.boolean() }).strict(),
  z.object({ slot: z.literal("DRIVER_TRAVEL_BOOKED"), value: z.boolean() }).strict(),
  z.object({ slot: z.literal("DRIVER_START_LOCATION"), value: Text }).strict(),
  z.object({ slot: z.literal("DRIVER_FIT_TO_DRIVE"), value: z.boolean() }).strict(),
  z.object({ slot: z.literal("ETA"), value: IsoDateTime }).strict(),
  z.object({ slot: z.literal("CURRENT_LOCATION"), value: Text }).strict(),
  z.object({ slot: z.literal("DRIVER_SAFE"), value: z.boolean() }).strict(),
  z.object({ slot: z.literal("FERRY_CHECKED_IN"), value: z.boolean() }).strict(),
  z.object({ slot: z.literal("RECEIVER_PRESENT_AT_WINDOW"), value: z.boolean() }).strict(),
  z.object({ slot: z.literal("ISSUE_REPORTED"), value: Text }).strict(),
  z.object({ slot: z.literal("WARNING_LIGHT"), value: z.enum(["NONE", "AMBER_STEADY", "AMBER_FLASHING", "RED"]) }).strict(),
  z.object({ slot: z.literal("ENGINE_OFF"), value: z.boolean() }).strict(),
  z.object({ slot: z.literal("SYMPTOMS"), value: Text }).strict(),
  z.object({ slot: z.literal("INJURIES"), value: z.boolean() }).strict(),
  z.object({ slot: z.literal("CAR_MOVES"), value: z.boolean() }).strict(),
  z.object({ slot: z.literal("CONNECTION_AT_RISK"), value: z.boolean() }).strict(),
  z.object({ slot: z.literal("EXPENSE_ITEM"), value: Text }).strict(),
  z.object({ slot: z.literal("QUESTION"), value: Text }).strict(),
])
export type SlotValue = z.infer<typeof SlotValue>
export const SlotName = z.enum(SlotValue.options.map((o) => o.shape.slot.value) as [SlotValue["slot"], ...SlotValue["slot"][]])
export type SlotName = z.infer<typeof SlotName>

/** Slots to fill per inbound situation, in order. Safety first, then what the operator will need. */
export const CHECKLISTS: Record<Situation, SlotName[]> = {
  WARNING_LIGHT: ["DRIVER_SAFE", "CURRENT_LOCATION", "WARNING_LIGHT", "SYMPTOMS", "ENGINE_OFF"],
  BREAKDOWN: ["DRIVER_SAFE", "CURRENT_LOCATION", "ISSUE_REPORTED", "CAR_MOVES", "ENGINE_OFF"],
  ACCIDENT: ["INJURIES", "DRIVER_SAFE", "CURRENT_LOCATION", "ISSUE_REPORTED"],
  DELAY: ["CURRENT_LOCATION", "ISSUE_REPORTED", "ETA", "CONNECTION_AT_RISK"],
  KEYS_ACCESS: ["QUESTION", "CURRENT_LOCATION", "RELEASE_CONTACT_NAME"],
  EXPENSE: ["EXPENSE_ITEM", "QUESTION"],
  OTHER_QUESTION: ["QUESTION"],
}

/** What the reasoning model hands the voice caller. Small on purpose: it becomes the voice model's system prompt. */
export const CallBrief = z.object({
  id: Id, orderId: Id, purpose: CallPurpose, callee: Callee, createdAt: IsoDateTime, createdBy: z.enum(["RULE", "REASONING_MODEL", "OPERATOR"]),
  language: z.literal("en"),
  opening: Text,
  /** Facts the caller may say, already phrased for speech (numbers spelled out, conclusions precomputed). */
  mayState: z.array(Text).max(12),
  /** Slots to fill, in order. */
  ask: z.array(SlotName).min(1).max(6),
  mustNot: z.array(z.enum(["CUSTOMER_DETAILS", "PRICES", "OTHER_ORDERS", "MECHANICAL_ADVICE", "PROMISE_CHANGES", "CLEARANCE_TO_DRIVE"])),
  closing: Text,
  maxDurationS: z.number().int().min(30).max(180),
  /** Dossier items the brief was built from, so a later reader can check it. */
  basis: z.array(z.object({ collection: Text, id: Id }).strict()),
}).strict()
export type CallBrief = z.infer<typeof CallBrief>

export const CallTurn = z.object({
  seq: z.number().int().nonnegative(), speaker: z.enum(["CALLER", "CALLEE", "IVR"]),
  startedAt: IsoDateTime, endedAt: IsoDateTime, text: Text, audioKey: Text.nullable(),
}).strict()

export const CallRecord = z.object({
  id: Id, orderId: Id, brief: CallBrief, direction: z.enum(["OUTBOUND", "INBOUND"]),
  attempt: z.number().int().min(1), startedAt: IsoDateTime, endedAt: IsoDateTime.nullable(),
  outcome: z.enum(["COMPLETED", "PARTIAL", "NO_ANSWER", "VOICEMAIL", "IVR_DEAD_END", "WRONG_PARTY", "REFUSED", "DROPPED", "ESCALATED"]),
  engine: z.enum(["VOICECHAT_11B", "PERSONAPLEX", "CHAINED_STT_LLM_TTS", "SIMULATED", "SIMULATED_LLM"]),
  /** Inbound only: how the caller's opening was classified, citing the turn. Null on outbound calls. */
  triage: z.object({ urgency: Urgency, situation: Situation, turnSeq: z.number().int().nonnegative(), quote: Text }).strict().nullable(),
  /** Tool calls the voice model made during the call (VoiceChat supports live tool calls). */
  toolCalls: z.array(z.object({ turnSeq: z.number().int().nonnegative(), name: z.enum(["ESCALATE_TO_OPERATOR", "REQUEST_PHOTO", "IVR_PRESS"]), argument: Text }).strict()),
  turns: z.array(CallTurn),
  /** Every extracted value cites the turn it came from. A slot is a claim by the callee, never a verification. */
  slots: z.array(z.object({ value: SlotValue, turnSeq: z.number().int().nonnegative(), quote: Text }).strict()),
  toneReview: z.object({
    model: Text, at: IsoDateTime,
    flags: z.array(z.enum(["IRRITATED", "CONFUSED", "EVASIVE", "UNSAFE_SITUATION", "LANGUAGE_BARRIER", "CALLER_ERROR", "OFF_SCRIPT"])),
    summary: Text,
  }).strict().nullable(),
  retryAfter: IsoDateTime.nullable(),
}).strict()
export type CallRecord = z.infer<typeof CallRecord>

// ------------------------------------------------------------------ operator actions

export const OperatorAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("NOTE"), id: Id, orderId: Id, at: IsoDateTime, operatorId: Id, text: Text }).strict(),
  z.object({ kind: z.literal("CALL_REQUESTED"), id: Id, orderId: Id, at: IsoDateTime, operatorId: Id, purpose: CallPurpose, callee: Callee }).strict(),
  z.object({ kind: z.literal("CALL_CANCELLED"), id: Id, orderId: Id, at: IsoDateTime, operatorId: Id, callId: Id, reason: Text }).strict(),
  z.object({ kind: z.literal("HANDLED_OUTSIDE"), id: Id, orderId: Id, at: IsoDateTime, operatorId: Id, what: Text, outcome: Text }).strict(),
  z.object({ kind: z.literal("DECISION"), id: Id, orderId: Id, at: IsoDateTime, operatorId: Id, about: z.object({ collection: Text, id: Id }).strict(), choice: Text }).strict(),
])
export type OperatorAction = z.infer<typeof OperatorAction>
