// Types shared by the voice server code, the routes and the call screen.
// No server imports here: the browser bundle reads this file too.

export type Urgency = "EMERGENCY" | "URGENT" | "ROUTINE"
export const URGENCY_RANK: Record<Urgency, number> = { ROUTINE: 1, URGENT: 2, EMERGENCY: 3 }

export type CallDirection = "AGENT_INITIATED" | "DRIVER_INITIATED"

export const SITUATIONS = [
  "WARNING_LIGHT", "BREAKDOWN", "ACCIDENT", "DELAY", "KEYS_ACCESS", "EXPENSE", "OTHER_QUESTION",
] as const
export type Situation = (typeof SITUATIONS)[number]

/** One extracted fact. `turn_id` points at the driver turn (and audio clip) it came from. */
export type Slot = { value: string; turn_id: string; quote: string; confidence: number }
export type CallSlots = Record<string, Slot>

/** Optional hint from the simulator until stream C feeds real OBD and GPS. */
export type TelemetryHint = {
  codes?: string[]
  milFlashing?: boolean
  /** Free text such as "A1 near Osnabrück" */
  place?: string
  /** Any other short note, such as "reduced power" */
  note?: string
}

/** A fact we knew before the call, with where it came from. */
export type ContextFact = { key: string; text: string; source: string; at: string | null }

export type CallPhase = "urgency" | "checklist" | "readback" | "closing" | "ended"

export type TriggerRecord = {
  trigger: "call_urgent" | "call_ended"
  at: string
  delivered: boolean
  status: number | null
  note: string
}

export type Spend = { llm: number; stt: number; tts: number }

export type ScreenFlag = { text: string; reason: string; category: string; by: "pattern" | "classifier" | "classifier_unavailable"; replacedWith: string | null }

export type TurnFlags = {
  /** Ids of the safety templates spoken on this turn (lib/voice/interview/safety.ts). */
  safetyTemplates?: string[]
  /** Sentences the drivability screen blocked or replaced. */
  screened?: ScreenFlag[]
  /** The model's own text before screening, kept for audit. */
  rawText?: string
  /** A driver turn where nothing was said before the reply deadline. */
  silence?: boolean
  /** Which interview phase this agent turn served. */
  phase?: CallPhase
  sttError?: string
}

export type CallState = {
  orderRef: string
  driverName: string | null
  phase: CallPhase
  /** Agent questions asked during the checklist phase. */
  questions: number
  readbacks: number
  readbackTurnId: string | null
  urgencyQuote: string | null
  urgencyAt: string | null
  context: ContextFact[]
  telemetryHint: TelemetryHint | null
  /** Consecutive driver silences past the reply deadline. */
  silences: number
  triggers: TriggerRecord[]
  spend: Spend
  liveStt: "browser" | "server"
}

// ------------------------------------------------------------- HTTP shapes

export type StartCallRequest = {
  orderRef: string
  driverId: string
  direction: CallDirection
  telemetryHint?: TelemetryHint | null
}

export type SpokenLine = { text: string; audioUrl: string | null }

export type StartCallResponse = {
  callId: string
  opening: SpokenLine
  /** Short phrases the screen may play while the reply is on its way. */
  fillers: SpokenLine[]
  driverName: string | null
  liveStt: "browser" | "server"
}

/** Server-sent events from POST /api/voice/calls/:id/turns */
export type TurnEvent =
  | { event: "driver"; data: { turnId: string; seq: number; text: string } }
  | { event: "sentence"; data: { index: number; text: string; audioUrl: string | null } }
  | { event: "state"; data: { urgency: Urgency | null; urgencyQuote: string | null; situation: string | null; phase: CallPhase } }
  | { event: "done"; data: { agentTurnId: string; phase: CallPhase; ended: boolean } }
  | { event: "error"; data: { message: string } }

export type CallTurnView = {
  id: string; seq: number; speaker: "agent" | "driver"; startedAt: string; endedAt: string | null
  textLive: string | null; textFinal: string | null; sttModel: string | null; audioUrl: string | null; interrupted: boolean
  flags: TurnFlags
}

export type CallView = {
  id: string; caseId: string | null; orderId: string; orderRef: string; driverId: string; driverName: string | null
  direction: CallDirection; startedAt: string; endedAt: string | null
  urgency: Urgency | null; urgencyTurnId: string | null; urgencyQuote: string | null
  situation: string | null; slots: CallSlots; slotLabels: Record<string, string>
  /** Checklist items still unknown (what the operator has to find out). */
  missing: { key: string; label: string }[]
  readbackConfirmed: boolean; endReason: string | null; recordingKey: string | null; nextCheckAt: string | null
  phase: CallPhase; context: ContextFact[]; triggers: TriggerRecord[]; spend: Spend
  turns: CallTurnView[]
}
