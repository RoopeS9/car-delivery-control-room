// The drivability screen (PLAN.md rule 8 and 4.2). The agent may tell a
// driver to stop; it may never tell them the car can be driven on. Two layers
// check every outbound driver message, chat or voice:
//
// 1. Patterns: fast, catch the obvious phrasings, also used sentence by
//    sentence while a reply streams.
// 2. A small classifier (Haiku 5.5): catches what patterns miss ("the amber
//    light is fine for now, head to the ferry").
//
// A blocked message is not sent. It becomes a CLEAR_TO_CONTINUE proposal so an
// operator can approve it on purpose. Safety instructions themselves come only
// from fixed templates.

import { llm, usageCost } from "./client"

export type SafetyTemplate = { id: string; text: string; label: string }

/** The only safety instructions the agent can send on its own. `{name}` is the driver's first name. */
export const SAFETY_TEMPLATES: readonly SafetyTemplate[] = [
  { id: "stop_when_safe", label: "Stop when safe", text: "{name}, please slow down and stop at the next safe place, then switch on your hazard lights." },
  { id: "engine_off", label: "Engine off", text: "Please switch the engine off and leave it off." },
  { id: "do_not_drive_on", label: "Do not drive on", text: "Please do not drive the car any further until an operator has confirmed what happens next." },
  { id: "leave_car_behind_barrier", label: "Leave the car, stand behind the barrier", text: "Please get out on the side away from traffic and stand behind the barrier, well away from the car." },
  { id: "call_112", label: "Call 112", text: "If anyone is hurt, or you see smoke or fire, call 112 now. Your safety comes first." },
  { id: "wait_for_help", label: "Wait for help", text: "Please stay in a safe place near the car. Help is being arranged and we will message you soon." },
]

export function renderSafetyTemplate(id: string, driverFirstName: string | null): string | null {
  const template = SAFETY_TEMPLATES.find((entry) => entry.id === id)
  if (!template) return null
  const name = driverFirstName?.trim()
  return name ? template.text.replace("{name}", name) : template.text.replace("{name}, p", "P")
}

// ---------------------------------------------------------------- patterns

const CLEARANCE = /\b(you can|you may|you could|you(?:'re| are) (?:fine|ok|okay|good|clear|cleared) to|it(?:'s| is) (?:safe|fine|ok|okay) to|(?:ok|okay|safe|fine) to|feel free to|go ahead and|cleared to)\b[^.!?\n]{0,40}?\b(drive|driving|continue|carry on|keep going|move the car|restart|go on)\b/gi
const NEGATED = /\b(not|n't|never|no one|nobody|cannot|can't)\s+(?:\w+\s+){0,2}$/i
const CONDITIONAL = /\b(until|unless|whether|if|once|before|after|when|decides?|confirms?)\b[^.!?\n]{0,40}$/i

/**
 * Finds text that tells a driver they may drive on. Negations ("it is not
 * safe to drive") and conditions ("until an operator confirms you can
 * drive") do not count. Returns the offending phrase, or null.
 */
export function findClearance(text: string): string | null {
  for (const match of text.matchAll(CLEARANCE)) {
    const before = text.slice(Math.max(0, (match.index ?? 0) - 50), match.index)
    if (NEGATED.test(before) || CONDITIONAL.test(before)) continue
    return match[0]
  }
  return null
}

/** Words that make a message worth a closer look when the classifier is unavailable. */
const DRIVING_WORDS = /\b(driv\w*|continu\w*|carry on|keep going|go on|head (?:to|on|off|for)|move on|restart\w*|journey|on your way|get going|set off)\b/i

// ---------------------------------------------------------------- classifier

export type Screen = { allowed: boolean; layer: "pattern" | "classifier" | "fail_closed" | "none"; reason: string | null; costUsd: number }

const CLASSIFIER_PROMPT = `You check messages that a car-delivery company is about to send to a freelance driver who is moving a customer's car.

Block the message if it says or implies that the driver may drive the car (again, further, onward), continue the journey, restart and go, or that a warning is fine to drive with. This includes indirect wording such as "head to the ferry when you're ready" or "the amber light is OK for now".

Allow it if it only tells them to stop, stay safe, wait, send information, or says an operator will decide. Allow questions that do not give permission.

Answer with exactly one word: BLOCK or ALLOW.`

export function classifierModel(): string {
  return process.env.DRIVABILITY_MODEL || "anthropic/claude-haiku-5.5"
}

/**
 * Screen one outbound driver message. Patterns first (free); then the
 * classifier when a model is available. If the classifier fails, a message
 * that mentions driving at all is held for an operator (fail closed).
 */
export async function screenDriverMessage(text: string, context?: { driverSaid?: string | null }): Promise<Screen> {
  const phrase = findClearance(text)
  if (phrase) return { allowed: false, layer: "pattern", reason: `"${phrase}"`, costUsd: 0 }
  const client = llm()
  if (!client) return { allowed: true, layer: "none", reason: null, costUsd: 0 }
  try {
    const message = await client.messages.create({
      model: classifierModel(), max_tokens: 400, output_config: { effort: "low" }, system: CLASSIFIER_PROMPT,
      messages: [{ role: "user", content: `${context?.driverSaid ? `What the driver wrote before, for context only:\n"""${context.driverSaid.slice(0, 600)}"""\n\n` : ""}Message to the driver:\n"""${text}"""` }],
    }, { timeout: 15000 })
    const answer = message.content.filter((block) => block.type === "text").map((block) => (block as { text: string }).text).join("").trim().toUpperCase()
    const cost = usageCost(message.usage)
    if (answer.startsWith("BLOCK")) return { allowed: false, layer: "classifier", reason: "the classifier read it as permission to drive on", costUsd: cost }
    if (answer.startsWith("ALLOW")) return { allowed: true, layer: "classifier", reason: null, costUsd: cost }
    throw new Error(`unexpected classifier answer: ${answer.slice(0, 40)}`)
  } catch (error) {
    if (DRIVING_WORDS.test(text)) {
      return { allowed: false, layer: "fail_closed", reason: `the classifier was unavailable (${error instanceof Error ? error.message : "error"}) and the message mentions driving`, costUsd: 0 }
    }
    return { allowed: true, layer: "none", reason: null, costUsd: 0 }
  }
}
