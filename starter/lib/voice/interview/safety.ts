// Safety instructions are template-only (PLAN.md 4.6). The interviewer never
// phrases a safety instruction in its own words: it writes a tag such as
// [[CALL_112]] and the server speaks the template. A safety-like sentence in
// free text is replaced by the matching template. The ids used are logged on
// the turn (`cr_call_turns.flags.safetyTemplates`).

export const SAFETY_TEMPLATES = {
  STOP_WHEN_SAFE: "As soon as it is safe, pull over and stop the car.",
  ENGINE_OFF: "Please switch the engine off.",
  LEAVE_CAR_BARRIER: "Get everyone out of the car and stand behind the barrier, away from the traffic.",
  CALL_112: "If anyone is hurt or in danger, call 112 now.",
  WAIT_FOR_HELP: "Stay there, somewhere safe, and wait for help.",
} as const

export type SafetyId = keyof typeof SAFETY_TEMPLATES
export const SAFETY_IDS = Object.keys(SAFETY_TEMPLATES) as SafetyId[]

// Safety signals the driver can mention at any point in the call. The
// interviewer reports them in the strict tool field `safety_signal` (so a
// paraphrase like "it smells like gas" counts); the server then speaks the
// templates, raises the urgency and records a `safety_signal` slot.
export const SAFETY_SIGNALS = {
  FUEL_SMELL: { label: "Fuel smell", urgency: "URGENT", templates: ["LEAVE_CAR_BARRIER"], rank: 2 },
  FLUID_LEAK: { label: "Leaking fluid, possibly fuel", urgency: "URGENT", templates: ["LEAVE_CAR_BARRIER"], rank: 2 },
  BURNING_SMELL: { label: "Burning smell", urgency: "URGENT", templates: ["LEAVE_CAR_BARRIER"], rank: 2 },
  OVERHEATING: { label: "Overheating warning", urgency: "URGENT", templates: ["LEAVE_CAR_BARRIER"], rank: 1 },
  SMOKE: { label: "Smoke", urgency: "EMERGENCY", templates: ["CALL_112", "LEAVE_CAR_BARRIER"], rank: 3 },
  FIRE: { label: "Fire", urgency: "EMERGENCY", templates: ["CALL_112", "LEAVE_CAR_BARRIER"], rank: 4 },
} as const satisfies Record<string, { label: string; urgency: "URGENT" | "EMERGENCY"; templates: SafetyId[]; rank: number }>

export type SafetySignalKind = keyof typeof SAFETY_SIGNALS
export const SAFETY_SIGNAL_KINDS = Object.keys(SAFETY_SIGNALS) as SafetySignalKind[]

const TAG = /\[\[\s*([A-Z_0-9]+)\s*\]\]/g

export type SpokenPart = { kind: "safety"; id: SafetyId; text: string } | { kind: "free"; text: string }

/** Split model text into template tags and free text, in order. Unknown tags are dropped. */
export function expandSafetyTags(text: string): SpokenPart[] {
  const parts: SpokenPart[] = []
  let last = 0
  for (const match of text.matchAll(TAG)) {
    const before = text.slice(last, match.index).trim()
    if (before) parts.push({ kind: "free", text: before })
    const id = match[1] as SafetyId
    if (id in SAFETY_TEMPLATES) parts.push({ kind: "safety", id, text: SAFETY_TEMPLATES[id] })
    last = (match.index ?? 0) + match[0].length
  }
  const rest = text.slice(last).trim()
  if (rest) parts.push({ kind: "free", text: rest })
  return parts
}

// A free-text instruction that sounds like safety advice maps to its template.
// Questions ("Is the engine off?") are not instructions and pass through.
const FREE_SAFETY: [RegExp, SafetyId][] = [
  [/\b112\b|\bemergency services\b|\bcall (an )?ambulance\b/i, "CALL_112"],
  [/\bbarrier\b|\bget (everyone |yourself )?out of the car\b|\bleave the car\b|\baway from (the )?traffic\b/i, "LEAVE_CAR_BARRIER"],
  [/\b(switch|turn|shut) (the engine |it )?off\b|\bengine off\b/i, "ENGINE_OFF"],
  [/\bpull over\b|\bstop the car\b|\bpull in\b/i, "STOP_WHEN_SAFE"],
  [/\bwait for help\b|\bstay (where you are|there|with the car)\b/i, "WAIT_FOR_HELP"],
]

// Only instructions count: "Switch the engine off." or "You should call 112."
// Statements and read-backs ("So: engine off, light flashing.") do not.
const IMPERATIVE = /^(?:(?:please|now|okay|ok|right|first|then|and|thanks|thank you)[,.!\s]+|[A-Z][a-z]+[,.!]\s+)*(call|get|stand|stay|leave|switch|turn|shut|pull|stop|move|wait|keep|go|step|put)\b/i
const ADVISORY = /\byou (should|must|need to|have to|'ll need to)\b|\bmake sure\b|\bi need you to\b/i

export function freeSafetyTemplate(sentence: string): SafetyId | null {
  const text = sentence.trim()
  if (text.endsWith("?")) return null
  if (Object.values(SAFETY_TEMPLATES).some((template) => template === text)) return null
  if (!IMPERATIVE.test(text) && !ADVISORY.test(text)) return null
  for (const [pattern, id] of FREE_SAFETY) if (pattern.test(text)) return id
  return null
}
