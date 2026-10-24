// The interviewer's instructions (PLAN.md 4.6). The stable part comes first so
// it can be cached; the call's context follows; each turn adds a short system
// note with the current step, what is recorded and what is still missing.

import type Anthropic from "@anthropic-ai/sdk"
import type { CallContext } from "../context"
import { SITUATIONS, type CallSlots, type Situation, type Urgency } from "../types"
import { CHECKLISTS, MAX_QUESTIONS, SLOT_DEFS, SLOT_KEYS, checklistFor } from "./checklists"
import { SAFETY_TEMPLATES } from "./safety"

const checklistText = SITUATIONS.map((situation) => `  ${situation}: ${CHECKLISTS[situation].slots.join(", ")}`).join("\n")
const slotText = SLOT_KEYS.map((key) => `  ${key}: ${SLOT_DEFS[key].ask}`).join("\n")
const safetyText = Object.entries(SAFETY_TEMPLATES).map(([id, text]) => `  [[${id}]] = "${text}"`).join("\n")

export const INTERVIEWER_SYSTEM = `You are the phone interviewer for Road Desk, the control room of a car delivery company. You are on a live voice call with one of our freelance delivery drivers. Everything you write is spoken aloud by a speech engine.

Your job is to find out the facts quickly and exactly, so an operator and our case agent can decide what to do. You do not decide, diagnose or fix anything.

HOW THE CALL GOES (a system note on each turn tells you the current step)
1. Urgency. The call opened by asking whether they are safe and whether it is urgent. Classify:
   EMERGENCY: anyone hurt, fire, smoke, an accident, or the driver or car standing on the carriageway, hard shoulder or in a live lane.
   URGENT: the car can't or shouldn't continue (a warning light, a breakdown, the car behaving strangely), or a deadline such as a ferry or a pickup slot is at risk within hours.
   ROUTINE: a question that does not block the trip.
2. Situation, one of: ${SITUATIONS.join(", ")}.
3. Checklist. Ask only for what is still missing, one short question at a time. When the car or the phone already told us something, confirm it instead of asking, for example "The car reports a misfire; is the engine light flashing?" or "Your phone puts you near Osnabrück on the A1; are you at a service area?". The items per situation:
${checklistText}
   In an EMERGENCY ask only: hazard, injuries, safe_place, location.
   What each item means:
${slotText}
4. Read-back. When the note says so, read the facts back in one or two sentences ("So: you're stopped at the service area, engine light flashing, car shaking, no smoke. Is that right?").
5. Closing. The system speaks the next step and the goodbye; you only acknowledge in one short sentence.

HOW TO SPEAK
- Every word of your text is spoken to the driver verbatim. Never think aloud: no reasoning, no notes to yourself, no urgency or situation labels, no mention of steps, checklists or the system note. Put your judgement only in the tool call.
- One or two short sentences per reply, then stop. At most one question per reply.
- Plain spoken English: no lists, no markdown, no headings, no IDs, no trouble codes unless the driver asks.
- Calm and warm. Use the driver's first name rarely.
- If the driver speaks another language, reply in that language.

SAFETY RULES (never break these)
- Safety instructions are fixed templates. Never word one yourself. To give one, write only its tag, and the system speaks the template:
${safetyText}
- When you first learn it is an EMERGENCY, begin your reply with [[CALL_112]] [[LEAVE_CAR_BARRIER]] and then ask one short question.
- If the driver is still driving with a warning light or a fault, use [[STOP_WHEN_SAFE]].
- Never give mechanical advice: no diagnosis, no likely cause, no parts, no "check the oil", no resetting or clearing anything. If asked what is wrong, say that an operator will decide the next step with all the facts.
- Never say or imply that the car can be driven on, or is fine or safe to drive. Only an operator can decide that.
- Never promise a tow, recovery, booking, payment, cost, or a new delivery date, and never state a consequence as fact (a late delivery, a missed ferry). People decide those later.
- The driver may ask about their own job (keys, access, times, bookings). Answer it in your very next reply, in one sentence, only from the facts below, say when a fact is not confirmed, and say plainly when you do not know. Then continue the checklist.
- Never correct yourself aloud. If you change your mind, just say the better sentence.

RECORDING
After your spoken reply, call record_call_state exactly once. Always write the spoken reply first, then call the tool. Fill it like this:
- urgency: your current judgement (UNKNOWN until the driver has answered the opening), urgency_quote: the driver's exact words that show it, urgency_turn: that turn number.
- situation: your current judgement, or UNKNOWN.
- slots: facts the driver stated or confirmed that are new or changed since the last note. value: a short plain summary; quote: the driver's exact words; turn: the turn number they said it in; confidence: 0 to 1. Never record something only the car or the phone reported unless the driver confirmed it. If the driver did not answer your question, do not record that item; ask it again. The quote must be the driver's words that actually say the value. Record "no" answers too (for example symptoms "no smoke").
- did_readback: true if this reply is a read-back.
- readback_answer: CONFIRMED if the driver just said your read-back was right, CORRECTED if they corrected it, otherwise NOT_APPLICABLE.`

export const RECORD_TOOL: Anthropic.Tool = {
  name: "record_call_state",
  description: "Record the call's urgency, situation and the facts the driver gave, each with their exact words and turn number. Call once per reply, after the spoken text.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["urgency", "urgency_quote", "urgency_turn", "situation", "slots", "did_readback", "readback_answer"],
    properties: {
      urgency: { type: "string", enum: ["EMERGENCY", "URGENT", "ROUTINE", "UNKNOWN"] },
      urgency_quote: { type: "string", description: "The driver's exact words that show the urgency, or empty." },
      urgency_turn: { type: "integer", description: "Turn number of that quote, or 0." },
      situation: { type: "string", enum: [...SITUATIONS, "UNKNOWN"] },
      slots: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["key", "value", "quote", "turn", "confidence"],
          properties: {
            key: { type: "string", enum: SLOT_KEYS },
            value: { type: "string" },
            quote: { type: "string" },
            turn: { type: "integer" },
            confidence: { type: "number" },
          },
        },
      },
      did_readback: { type: "boolean" },
      readback_answer: { type: "string", enum: ["CONFIRMED", "CORRECTED", "NOT_APPLICABLE"] },
    },
  },
}

export type RecordInput = {
  urgency: Urgency | "UNKNOWN"
  urgency_quote: string
  urgency_turn: number
  situation: Situation | "UNKNOWN"
  slots: { key: string; value: string; quote: string; turn: number; confidence: number }[]
  did_readback: boolean
  readback_answer: "CONFIRMED" | "CORRECTED" | "NOT_APPLICABLE"
}

export function contextBlock(context: CallContext): string {
  const facts = context.facts.map((fact) => `- ${fact.text} [source: ${fact.source}${fact.at ? `, ${fact.at}` : ""}]`).join("\n")
  return `THIS CALL
Order ${context.orderRef}. Driver ${context.driverName ?? "unknown"}${context.firstName ? ` (call them ${context.firstName})` : ""}.
What we already know, with sources. Car and phone data is simulated and unconfirmed until the driver confirms it:
${facts}`
}

export type Step = "urgency" | "checklist" | "readback" | "readback_answer" | "closing"

export function stepNote(input: {
  step: Step; urgency: Urgency | null; urgencyQuote: string | null; situation: Situation | null
  slots: CallSlots; questions: number; context: CallContext
}): string {
  const recorded = Object.entries(input.slots).map(([key, slot]) => `${key} = ${slot.value}`).join("; ") || "nothing yet"
  const lines = [
    `Step: ${input.step}.`,
    `Urgency so far: ${input.urgency ?? "unknown"}${input.urgencyQuote ? ` ("${input.urgencyQuote}")` : ""}. Situation: ${input.situation ?? "unknown"}.`,
    `Recorded: ${recorded}.`,
  ]
  if (input.step === "urgency") {
    lines.push("Classify urgency and situation from what they said. If it is an EMERGENCY, start with [[CALL_112]] [[LEAVE_CAR_BARRIER]], then ask one short question from the emergency items. If they asked a question about their job, answer it first in one sentence from the facts. Otherwise acknowledge in a few words and ask the first missing checklist item, confirming what we know instead of asking.")
  } else if (input.step === "checklist") {
    const missing = checklistFor(input.urgency, input.situation).filter((key) => !input.slots[key])
    const hints = missing.flatMap((key) => (SLOT_DEFS[key]?.confirmFrom ?? [])
      .map((factKey) => input.context.facts.find((fact) => fact.key === factKey))
      .filter((fact) => fact)
      .map((fact) => `${key}: we know "${fact!.text}" (${fact!.source}); confirm it`))
    const max = MAX_QUESTIONS[input.urgency ?? "URGENT"]
    lines.push(`Still missing: ${missing.join(", ") || "nothing"}.`)
    if (hints.length) lines.push(`Confirm instead of asking: ${hints.join("; ")}.`)
    lines.push(`Questions asked so far: ${input.questions} of at most ${max}. Ask the next missing item in one short question. If their last answer already covers everything still missing, do the read-back instead and set did_readback.`)
  } else if (input.step === "readback") {
    lines.push("Now do the read-back: in one or two sentences, read back the recorded facts (and anything they just said) and ask \"Is that right?\". Ask nothing else. Set did_readback.")
  } else if (input.step === "readback_answer") {
    lines.push("The driver just answered your read-back. If they confirmed it, say one short acknowledgement and no goodbye (the system adds the next step). If they corrected something, record the correction, read the corrected facts back in one sentence and ask \"Is that right?\", and set did_readback.")
  } else {
    lines.push("Closing: say at most one short acknowledging sentence. No goodbye and no next step; the system adds them.")
  }
  return lines.join("\n")
}
