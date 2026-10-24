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
  if (typeof value === "string") return /^[A-Z_]+$/.test(value) ? value.toLowerCase().replace(/_/g, " ") : value
  return JSON.stringify(value)
}

/** "URGENT WARNING_LIGHT: DRIVER_SAFE=true, CURRENT_LOCATION="…"" read out: "Urgent, warning light. Driver safe: yes · Current location: …". */
export function readToolArgument(argument: unknown): string {
  const text = typeof argument === "string" ? argument : argument == null ? "" : JSON.stringify(argument)
  const head = text.match(/^([A-Z_]+) ([A-Z_]+):\s*([\s\S]*)$/)
  const words = (code: string) => code.toLowerCase().replace(/_/g, " ")
  const body = head ? head[3] : text
  const pairs = [...body.matchAll(/([A-Z_]+)=("([^"]*)"|[^,]+)/g)].map((match) => {
    const raw = match[3] ?? match[2].trim()
    const value = raw === "true" ? "yes" : raw === "false" ? "no" : /^[A-Z_]+$/.test(raw) ? words(raw) : raw
    return `${slotLabel(match[1])}: ${value}`
  })
  if (!pairs.length) return text
  const lead = head ? `${words(head[1]).replace(/^./, (char) => char.toUpperCase())}, ${words(head[2])}. ` : ""
  return `${lead}${pairs.join(" · ")}`
}
