// The drivability screen (PLAN.md 4.6): every agent utterance in a call is
// checked before it is spoken, with patterns first and then a cheap Haiku
// classifier. It blocks anything that implies the car may be driven on, and,
// because the same rules apply in a call, mechanical diagnosis or repair
// advice and promises of bookings, costs, dates or consequences.
//
// Stream A will build a shared screen later; swap the body of
// `screenDriverUtterance` for it and keep the signature.

import { reasoningParams, usageCost, voiceClient } from "./client"

export type ScreenCategory = "DRIVABILITY" | "MECHANICAL" | "PROMISE"
export type ScreenResult = {
  allowed: boolean
  category: ScreenCategory | null
  reason: string
  by: "pattern" | "classifier" | "classifier_unavailable" | "cache"
  cost: number
}

const PATTERNS: [RegExp, ScreenCategory, string][] = [
  [/\b(you can|you could|you may|feel free to|go ahead and|it'?s (fine|ok|okay|safe) to|should be (fine|ok|okay|safe) to|safe to)\s+(keep |continue |carry on |go on )?(driv|continu|carry on|go on|head|make your way|get to)/i, "DRIVABILITY", "implies the car may be driven on"],
  [/\b(keep|carry on|continue) (driving|on|your (journey|trip))\b|\bcontinue to (the|your)\b/i, "DRIVABILITY", "implies the car may be driven on"],
  [/\bdrive (on|slowly|carefully|gently)\b|\bdrive it to\b|\bsafe to drive\b|\b(is|it'?s|looks|seems) (still )?drivable\b|\bshould (make|get you) (it )?to\b|\blimp\b/i, "DRIVABILITY", "implies the car may be driven on"],
  [/\bcylinders?\b|\bcatalytic\b|\bspark ?plugs?\b|\bignition coils?\b|\bcoil packs?\b|\binjectors?\b|\bhead gasket\b|\bfuel pump\b|\bsensor\b|\bfuses?\b|\bdipstick\b|\boil level\b|\btop (it |them )?up\b|\b(open|check under) the (bonnet|hood)\b|\breset the\b|\bclear the (fault )?codes?\b/i, "MECHANICAL", "mechanical diagnosis or repair advice"],
  [/\b(probably|likely|most likely) (just |a |an |the |caused|means|is)\b|\bcaused by\b|\bnothing serious\b|\bnot (a )?serious\b|\bthis (means|usually means)\b/i, "MECHANICAL", "states a diagnosis"],
  [/\bwe('ll| will) (send|book|arrange|organi[sz]e|get you|pay|cover|refund|reimburse)\b|\b(tow|recovery|mechanic|help)( truck)? (is|will be) (on (its|the) way|coming)\b/i, "PROMISE", "promises a booking or help we have not arranged"],
  [/\b(it|this) (will|would) cost\b|\bwe('ll| will) (pay|cover)\b|\bnew delivery (date|time)\b|\b(delivery|car) will (be|arrive) (late|delayed|on)\b|\byou('ll| will) (miss|make|not make) the (ferry|boat|train)\b/i, "PROMISE", "states a cost, date or consequence as fact"],
]

/**
 * The model talking about its own work instead of to the driver ("This is
 * URGENT", "Situation is WARNING_LIGHT", "per the note"). Never spoken.
 */
const META = /\b(EMERGENCY|URGENT|ROUTINE)\b(?!\s+(?:help|services))|\bWARNING_?LIGHT\b|\bOTHER_QUESTION\b|\bKEYS_ACCESS\b|\b(situation|urgency) (is|=)\b|\brecord_call_state\b|\bsystem note\b|\bper the note\b|\b(the )?checklist\b|\b(I will|I'll|I should|I must) (confirm|ask|classify|record|not judge|acknowledge|do the read-?back)\b|\bthe driver (said|says|is|has)\b|\bthey (have|are|said)\b.*\b(so I|I will)\b|\[turn \d+\]/

const META_ANY_CASE = /\b(answer from the facts|then ask the|ask the (first|next) missing|do the read-?back|corrected (reply|version)|here is (my|the) (reply|answer|corrected)|let me (redo|correct) (that|this|my)|^wait,|scratch that|(urgent|routine),? (but )?not an emergency|so this is (urgent|routine|an emergency)|this counts as)\b/i

export function isMetaTalk(text: string): boolean {
  return META.test(text) || META_ANY_CASE.test(text.trim())
}

const CLASSIFIER_MODEL = () => process.env.VOICE_SCREEN_MODEL || "anthropic/claude-haiku-5.5"

const SYSTEM = `You screen one sentence that a roadside support line is about to say aloud to a delivery driver. Block only clear problems; most sentences are fine.
Answer with exactly one word:
BLOCK_DRIVABILITY only if it tells or lets the driver drive the car further: keep driving, continue, drive on, drive to a place, "good to go", or that the car is fine or safe to drive.
BLOCK_MECHANICAL only if it diagnoses the fault, names a likely cause or part, or gives repair, inspection or reset advice.
BLOCK_PROMISE only if it promises a tow, recovery, booking, payment, cost or a new date, or states as fact that the delivery will be late or a ferry will be missed.
ALLOW everything else. These are all ALLOW:
- "So: you're safe, nothing urgent, and you want to know where to leave the keys. Is that right?" (a read-back)
- "So: you're stopped at the service area, engine light flashing, car shaking. Is that right?"
- "Is the engine switched off now?" and any other question
- "Your car's data shows an engine fault and reduced power, and the check-engine light is flashing." (repeating what the car reported is not a diagnosis)
- "I've alerted an operator, and your case comes first." (an operator was alerted; nothing is promised)
- "An operator will look at this now and decide the next step."
- "We'll message you in the app within 15 minutes."
- "The delivery site's note says reception takes the keys, but that isn't confirmed yet."
- Instructions to stop, stay off the road, or wait somewhere safe.`

const cache = ((globalThis as unknown as { __voiceScreen?: Map<string, ScreenResult> }).__voiceScreen ??= new Map())

const DRIVE_WORDS = /\b(driv|continu|carry on|journey|on your way|ferry|road|go on|head)/i

export async function screenDriverUtterance(text: string): Promise<ScreenResult> {
  const sentence = text.trim()
  const known = cache.get(sentence)
  if (known) return { ...known, by: "cache", cost: 0 }
  for (const [pattern, category, reason] of PATTERNS) {
    if (pattern.test(sentence)) {
      const result: ScreenResult = { allowed: false, category, reason, by: "pattern", cost: 0 }
      cache.set(sentence, result)
      return result
    }
  }
  try {
    const model = CLASSIFIER_MODEL()
    const response = await voiceClient().messages.create({
      model,
      max_tokens: 16,
      system: SYSTEM,
      messages: [{ role: "user", content: `Sentence: "${sentence}"` }],
      ...reasoningParams(model, "low"),
    }, { timeout: 4000, maxRetries: 0 })
    const answer = response.content.map((block) => (block.type === "text" ? block.text : "")).join("").trim().toUpperCase()
    const cost = usageCost(response.usage, model)
    if (!/ALLOW|BLOCK/.test(answer)) throw new Error(`unclear answer "${answer.slice(0, 30)}"`)
    const category = answer.includes("DRIVABILITY") ? "DRIVABILITY" : answer.includes("MECHANICAL") ? "MECHANICAL" : answer.includes("PROMISE") ? "PROMISE" : null
    const result: ScreenResult = category
      ? { allowed: false, category, reason: `classifier: ${answer.toLowerCase()}`, by: "classifier", cost }
      : { allowed: true, category: null, reason: "classifier: allow", by: "classifier", cost }
    cache.set(sentence, { ...result, cost: 0 })
    return result
  } catch (error) {
    // Fail closed for anything about driving on; let plain questions through.
    const risky = DRIVE_WORDS.test(sentence) && !sentence.endsWith("?")
    return {
      allowed: !risky, category: risky ? "DRIVABILITY" : null,
      reason: `classifier unavailable (${error instanceof Error ? error.message.slice(0, 80) : "error"})${risky ? ", blocked to be safe" : ""}`,
      by: "classifier_unavailable", cost: 0,
    }
  }
}
