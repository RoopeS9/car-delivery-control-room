// Fixed lines the interviewer always says the same way (PLAN.md 4.6 steps 1
// and 5). They are rendered once and cached, so they play without waiting.
// Evidence-honest: the closing says what happens next and who does it. A time
// is only said when the call stores it as `next_check_at`.

import type { CallDirection, Situation, Urgency } from "../types"
import { SAFETY_TEMPLATES, type SafetyId } from "./safety"

export function openingLine(input: { direction: CallDirection; firstName: string | null; telemetryFault: boolean; vehicleLabel: string | null }): string {
  const hi = input.firstName ? `Hi ${input.firstName}, this is Road Desk.` : "Hi, this is Road Desk."
  if (input.direction === "AGENT_INITIATED") {
    if (input.telemetryFault) return `${hi} Your car just reported an engine fault. Are you and the car safe right now, or is this an emergency?`
    return `${hi} I'm calling about your ${input.vehicleLabel ?? "car"}. First: are you safe, and is anything urgent?`
  }
  return "Road Desk here. First: are you safe, and is this urgent?"
}

/** Said at once when the driver describes an emergency, before anything else. */
export const EMERGENCY_SAFETY: SafetyId[] = ["CALL_112", "LEAVE_CAR_BARRIER"]

export const FILLERS = ["One moment.", "One moment, I'm checking the car's data."]

/** The neutral line that replaces anything the drivability screen blocks. */
export const SCREEN_REPLACEMENT = "An operator will decide the next step; please stay where you are."
/** Replaces a blocked diagnosis or promise, where "stay where you are" would not fit. */
export const SCREEN_REPLACEMENT_OTHER = "An operator will look at that and decide the next step."
export const READBACK_ACK = "Thanks, that's noted."

export const REPROMPT_PREFIX = "Sorry, I didn't hear you."
export const NO_RESPONSE_LINES = [
  "I can't hear you, so I'll end the call now.",
  "An operator has what you told us so far and will message you in the app.",
]

const PHOTO_SITUATIONS: Situation[] = ["WARNING_LIGHT", "BREAKDOWN", "ACCIDENT"]

export type ClosingLine = { text: string; safetyId?: SafetyId }

/** Minutes until we said we'd get back to the driver, or null when no time is promised. */
export function nextCheckMinutes(urgency: Urgency | null): number | null {
  return urgency === "URGENT" ? 15 : null
}

export function nextStepLines(urgency: Urgency | null, situation: Situation | null): ClosingLine[] {
  if (urgency === "EMERGENCY") {
    return [
      { text: "I've alerted an operator, and your case comes first." },
      { text: SAFETY_TEMPLATES.WAIT_FOR_HELP, safetyId: "WAIT_FOR_HELP" },
      { text: "An operator will look at this now and contact you." },
    ]
  }
  if (urgency === "URGENT") {
    const lines: ClosingLine[] = [{ text: "An operator will look at this now and decide the next step." }]
    if (situation && PHOTO_SITUATIONS.includes(situation)) lines.push({ text: "Please send a photo of the dashboard in the app." })
    lines.push({ text: `We'll message you in the app within ${nextCheckMinutes(urgency)} minutes.` })
    return lines
  }
  return [{ text: "If anything else comes up, write to us in the app." }]
}

export function goodbyeLine(urgency: Urgency | null): string {
  return urgency === "ROUTINE" ? "Thanks for calling. Drive safely, goodbye." : "Thank you. Goodbye for now."
}

/** Everything fixed, for pre-rendering. Openings with names are rendered at call start. */
export function fixedPhrases(): string[] {
  const urgencies: (Urgency | null)[] = ["EMERGENCY", "URGENT", "ROUTINE"]
  const situations: (Situation | null)[] = ["WARNING_LIGHT", "DELAY", null]
  const lines = new Set<string>([
    openingLine({ direction: "DRIVER_INITIATED", firstName: null, telemetryFault: false, vehicleLabel: null }),
    ...Object.values(SAFETY_TEMPLATES), ...FILLERS, SCREEN_REPLACEMENT, SCREEN_REPLACEMENT_OTHER, READBACK_ACK, REPROMPT_PREFIX, ...NO_RESPONSE_LINES,
  ])
  for (const urgency of urgencies) {
    lines.add(goodbyeLine(urgency))
    for (const situation of situations) for (const line of nextStepLines(urgency, situation)) lines.add(line.text)
  }
  return [...lines]
}
