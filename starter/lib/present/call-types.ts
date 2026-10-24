// Shapes from the robo-call service, and small readers shared by server and browser.

export type CallScenario = { id: string; orderRef: string; role: string; mood: string; purpose: string; inbound: boolean; title: string }

export type CallTurn = { seq: number; speaker: "CALLER" | "CALLEE" | string; startedAt: string; endedAt?: string | null; text: string }
export type CallSlot = { value: { slot: string; value: unknown }; turnSeq: number; quote: string }
export type CallToolCall = { name?: string; tool?: string; reason?: string; args?: Record<string, unknown>; turnSeq?: number; [key: string]: unknown }

export type CallRecord = {
  id: string
  orderId: string
  brief: {
    id: string; purpose: string; callee: { kind: string; name?: string; [key: string]: unknown }
    opening?: string; mayState?: string[]; ask?: string[]; mustNot?: string[]; closing?: string; maxDurationS?: number
    basis?: { collection: string; id: string }[]
  } | null
  direction: "OUTBOUND" | "INBOUND" | string
  attempt?: number
  startedAt: string
  endedAt?: string | null
  outcome: string
  engine?: string
  triage: { urgency?: string; level?: string; reason?: string; quote?: string; [key: string]: unknown } | string | null
  toolCalls: CallToolCall[]
  turns: CallTurn[]
  slots: CallSlot[]
  toneReview?: unknown
  retryAfter: string | null
}

export type DossierItemRef = { collection: string; id: string; at: string | null; strength: string; membership: string }
export type ServiceDossier = { phase?: { phase: string; basis: string }; classes: Record<string, DossierItemRef[]> }

const SLOT_WORDS: Record<string, string> = {
  VEHICLE_PRESENT: "Car is at the site", KEYS_AT_SITE: "Keys are at the site", RELEASE_CONTACT_NAME: "Who releases the car",
  RELEASE_DOCUMENT_PRESENT: "Signed release is there", OPEN_DURING_SLOT: "Open during the slot", ACCESS_INSTRUCTION: "How to get in",
}

/** "Car is at the site", from VEHICLE_PRESENT; unknown slots are spelled out. */
export function slotLabel(slot: string): string {
  return SLOT_WORDS[slot] ?? slot.toLowerCase().replace(/_/g, " ").replace(/^./, (char) => char.toUpperCase())
}

export function slotValue(value: unknown): string {
  if (value === true) return "yes"
  if (value === false) return "no"
  if (value == null) return "not said"
  return typeof value === "string" ? value : JSON.stringify(value)
}
