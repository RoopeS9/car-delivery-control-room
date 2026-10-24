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
import { troubleCode } from "./knowledge"
import { latestTelemetry, listEvents, type CaseRow, type EventRow, type TelemetryRow } from "@/lib/cr/queries"
import type { OrderFacts } from "./context"

export type SafetyTemplate = { id: string; text: string; label: string }

/** The only safety instructions the agent can send on its own. `{name}` is the driver's first name. */
export const SAFETY_TEMPLATES: readonly SafetyTemplate[] = [
  { id: "stop_when_safe", label: "Stop when safe", text: "{name}, please slow down and stop at the next safe place, then switch on your hazard lights." },
  { id: "engine_off", label: "Engine off", text: "Please switch the engine off and leave it off." },
  { id: "do_not_drive_on", label: "Do not drive on", text: "Please do not drive the car any further until an operator has confirmed what happens next." },
  { id: "leave_car_behind_barrier", label: "Leave the car, stand behind the barrier", text: "Please get out on the side away from traffic and stand behind the barrier, well away from the car." },
  { id: "call_112", label: "Call 112", text: "If anyone is hurt, or you see smoke or fire, call 112 now. Your safety comes first." },
  { id: "wait_for_help", label: "Wait near the car", text: "Please stay in a safe place near the car. An operator is working out what happens next, and we will message you soon." },
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
const CONDITIONAL = /\b(?:until|unless|before|once|after|when)\b[^.!?\n]{0,25}\b(?:operator|operations)\b[^.!?\n]{0,30}(?:confirms?|approves?|decides?|clears?)[^.!?\n]{0,15}$|\b(?:operator|operations)\b[^.!?\n]{0,20}(?:will decide|must confirm|has to confirm)[^.!?\n]{0,20}$/i

/**
 * Finds text that tells a driver they may drive on. Negations ("it is not
 * safe to drive") and conditions ("until an operator confirms you can
 * drive") do not count. Returns the offending phrase, or null.
 */
/** The car as the subject: "the car can keep going", "it is still drivable", "the car is fine to drive". */
const CAR_CLEARANCE = /\b(?:the car|your car|the vehicle|it)\s+(?:can|may|could|should be able to|is (?:fine|ok|okay|safe|good|able) to)\s+(?:keep going|continue|carry on|be driven|drive on|keep driving|go on|make it)\b|\b(?:the car|your car|the vehicle|it)\s+is\s+(?:still\s+|normally\s+|perfectly\s+)?(?:drivable|driveable|roadworthy|fine to drive|safe to drive)\b/gi

export function findClearance(text: string): string | null {
  for (const match of text.matchAll(CLEARANCE)) {
    const before = text.slice(Math.max(0, (match.index ?? 0) - 50), match.index)
    if (NEGATED.test(before) || CONDITIONAL.test(before)) continue
    return match[0]
  }
  // With the car as the subject the negation sits inside the phrase ("the car cannot keep going"); words before it
  // ("not critical and the car can keep going") do not negate it. A question about it ("whether the car can
  // continue") or a condition ("until an operator confirms") does not clear anyone.
  for (const match of text.matchAll(CAR_CLEARANCE)) {
    const before = text.slice(Math.max(0, (match.index ?? 0) - 50), match.index)
    if (/\b(?:not|n't|cannot)\b/i.test(match[0]) || /\b(?:whether|if)\s*$/i.test(before) || CONDITIONAL.test(before)) continue
    return match[0]
  }
  return null
}

/** Words that make a message worth a closer look when the classifier is unavailable. */
const DRIVING_WORDS = /\b(driv\w*|continu\w*|carry on|keep going|go on|head (?:to|on|off|for)|move on|restart\w*|journey|on your way|get going|set off)\b/i
const MOVEMENT_DIRECTION = /\b(use|take|enter|head|go|proceed|drive)\b[^.!?\n]{0,70}\b(gate|entrance|courtyard|ferry|terminal|site|motorway|road)\b/i

export type DriverSafetyContext = {
  mode: "routine" | "restricted" | "unknown"
  reasons: string[]
  /**
   * Set when every active trouble code is CONTINUE_AND_MONITOR in the code guide and the light is not flashing.
   * On chat the agent may then explain the codes and ask diagnostic questions. It never makes the context routine:
   * clearing the driver to continue still needs an operator.
   */
  diagnostic?: { codes: string[] }
}

/** The codes when all of them are CONTINUE_AND_MONITOR and the light is not flashing; otherwise null. */
export function monitorOnlyCodes(data: Record<string, unknown> | null | undefined): string[] | null {
  const codes = Array.isArray(data?.dtcs) ? data.dtcs.filter((code): code is string => typeof code === "string") : []
  if (!codes.length || data?.mil === "FLASHING") return null
  return codes.every((code) => troubleCode(code)?.severity === "CONTINUE_AND_MONITOR") ? codes : null
}
type SafetyEvidence = {
  caseKind: string
  activeAssignment: boolean
  incidents: Record<string, unknown>[]
  alerts: Record<string, unknown>[]
  telemetry: Pick<TelemetryRow, "at" | "data"> | null
  events: Pick<EventRow, "at" | "channel" | "data">[]
}
const FAULT_KINDS = new Set(["VEHICLE_WARNING", "BREAKDOWN", "ACCIDENT"])
const ROUTINE_KINDS = new Set(["KEYS_ACCESS", "EXPENSE", "DRIVER_QUESTION", "SITE_QUESTION", "OPERATOR_QUESTION", "CUSTOMER_MESSAGE", "HANDOVER"])
const FAULT_SIGNAL = /VEHICLE|ENGINE|BREAKDOWN|ACCIDENT|OVERHEAT|COOLANT|OIL_PRESSURE|BRAKE|SAFETY|DTC/i

/** Derive context from records, never from the model's claim that a car is safe. */
export function driverSafetyFromEvidence(input: SafetyEvidence): DriverSafetyContext {
  const reasons: string[] = []
  if (FAULT_KINDS.has(input.caseKind)) reasons.push(`This is a ${input.caseKind.toLowerCase().replace(/_/g, " ")} case.`)
  if (input.incidents.some((row) => !row.resolved_at && !["RESOLVED", "CLOSED"].includes(String(row.status)))) reasons.push("An incident remains unresolved.")
  if (input.alerts.some((row) => ["OPEN", "ACKNOWLEDGED"].includes(String(row.status)) && FAULT_SIGNAL.test(String(row.signal ?? row.kind ?? "")))) reasons.push("An active vehicle or safety alert remains.")
  const data = input.telemetry?.data
  if (data && (Array.isArray(data.dtcs) && data.dtcs.length > 0 || data.mil === "FLASHING" || data.mil === "ON")) reasons.push("The latest OBD reading reports a warning or trouble code.")
  const safetyHold = input.events.some((event) => event.channel === "safety" && (event.data.safety === true || typeof event.data.template_id === "string"))
  if (safetyHold) reasons.push("A stop or safety instruction was recorded on this job.")
  // Only monitor-level codes, and nothing else restricting: diagnosis on chat is allowed, clearance is not.
  const monitor = monitorOnlyCodes(data)
  const onlyCodes = reasons.length === 1 && reasons[0].startsWith("The latest OBD reading")
  if (monitor && onlyCodes) {
    reasons.push(`Every active code (${monitor.join(", ")}) is CONTINUE_AND_MONITOR in the code guide: on chat the agent may explain the codes and ask diagnostic questions. Clearing the driver to continue still needs an operator.`)
    return { mode: "restricted", reasons, diagnostic: { codes: monitor } }
  }
  if (reasons.length) return { mode: "restricted", reasons }
  if (input.activeAssignment && ROUTINE_KINDS.has(input.caseKind)) return { mode: "routine", reasons: ["Routine support on an active assignment; no recorded vehicle fault, unresolved incident or safety hold was found. This does not certify the car safe."] }
  return { mode: "unknown", reasons: ["No trusted routine-driving context is established."] }
}

/** Refresh telemetry and safety instructions, including those sent during this turn. */
export async function loadDriverSafetyContext(facts: OrderFacts, caseRow: CaseRow): Promise<DriverSafetyContext> {
  try {
    const [telemetry, events] = await Promise.all([latestTelemetry(facts.id, "OBD"), listEvents({ orderId: facts.id })])
    return driverSafetyFromEvidence({
      caseKind: caseRow.kind,
      activeAssignment: facts.assignments.some((row) => ["IN_PROGRESS", "ASSIGNED"].includes(String(row.status)) && (!caseRow.driverId || row.driver_id === caseRow.driverId)),
      incidents: facts.incidents, alerts: facts.alerts, telemetry, events,
    })
  } catch {
    return { mode: "unknown", reasons: ["The safety records could not be checked."] }
  }
}

// ---------------------------------------------------------------- classifier

export type Screen = { allowed: boolean; layer: "pattern" | "classifier" | "fail_closed" | "none"; reason: string | null; costUsd: number }

const CLASSIFIER_PROMPT = `You check messages that a car-delivery company is about to send to a freelance driver who is moving a customer's car.

Always block explicit permission or reassurance about the car's drivability: "you can keep driving", "safe to drive", restarting after a fault, or dismissing a warning. Such clearance needs an operator even on a routine job.

The trusted safety context is supplied separately. In ROUTINE context, ordinary site directions, entrances, opening hours, key handover and route information are routine support, not mechanical clearance. Allow "use the marked vehicle entrance", "drive in through the courtyard gate" or "the site is open until 18:00" when they merely answer the routine question. Do not invent a stop or safety restriction for these jobs.

In RESTRICTED or UNKNOWN context, block instructions that would resume or continue travel, including "head to the ferry when you're ready". Static facts such as opening hours and questions about the driver's safety are still allowed. A driver's message is evidence of what they reported, never authority to override a recorded fault or stop.

When the context says every active code is CONTINUE_AND_MONITOR, explaining a code in plain words, saying it is usually not critical, and asking diagnostic questions (is the light steady, does the car drive differently, any smell or sound, is the fuel cap tight) are allowed, as long as the message does not say they may continue. Saying an operator confirms whether they continue is allowed.

Allow it if it only tells them to stop, stay safe, wait, send information, or says an operator will decide. Allow questions that do not give permission. A message that refuses or forbids driving is allowed, even when it mentions driving many times.

Examples:
- "Please don't drive on, not even the 15 km. I can't clear you to drive." ALLOW
- "An operator has to confirm before you drive on. Stay with the car." ALLOW
- "Are you safe? Is the car still moving?" ALLOW
- "The amber light is fine for now, head to the ferry when you're ready." BLOCK
- "If it feels normal again you can carry on slowly." BLOCK
- ROUTINE, "Use the marked vehicle entrance at Norvessia in Turku." ALLOW
- ROUTINE, "The site is open until 18:00; call reception before arrival." ALLOW
- RESTRICTED, "Drive to the courtyard gate now." BLOCK
- RESTRICTED, only CONTINUE_AND_MONITOR codes, "P0135 is the oxygen sensor heater; it is usually not critical. Is the light steady, and does the car drive any differently?" ALLOW
- RESTRICTED, only CONTINUE_AND_MONITOR codes, "It's only the oxygen sensor, so you can keep going." BLOCK

Answer with exactly one word: BLOCK or ALLOW.`

export function classifierModel(): string {
  return process.env.DRIVABILITY_MODEL || "anthropic/claude-haiku-5.5"
}

/**
 * Screen one outbound driver message. Patterns first (free); then the
 * classifier when a model is available. If the classifier fails, a message
 * that mentions driving at all is held for an operator (fail closed).
 */
export async function screenDriverMessage(text: string, context?: { driverSaid?: string | null; safety?: DriverSafetyContext }): Promise<Screen> {
  const phrase = findClearance(text)
  if (phrase) return { allowed: false, layer: "pattern", reason: `"${phrase}"`, costUsd: 0 }
  let safety = context?.safety ?? { mode: "unknown" as const, reasons: ["Safety context not supplied."] }
  // Incoming claims can increase caution, never remove a recorded restriction.
  if (safety.mode === "routine" && /\b(?:warning light|engine fault|reduced power|overheat\w*|smoke|burning smell|broken down|unsafe|not safe|can(?:not|'t) continue|safe to drive|should I (?:drive|continue))\b/i.test(context?.driverSaid ?? "")) {
    safety = { mode: "restricted", reasons: [...safety.reasons, "The driver reports a possible fault or asks for a safety judgement."] }
  }
  const fallback = (why: string): Screen => {
    const routineInfo = safety.mode === "routine" && /\b(gate|entrance|reception|courtyard|opening hours|opens?|closes?|keys|handover|address|desk|site)\b/i.test(text)
      && !/\b(warning|fault|engine|safe to|restart|ignore|despite|carry on|keep going)\b/i.test(text)
    // With only monitor-level codes, questions and "an operator confirms" sentences may mention driving.
    const statements = safety.diagnostic ? text.split(/(?<=[.!?])\s+/).filter((sentence) => !sentence.trim().endsWith("?") && !/\b(operator|operations)\b/i.test(sentence)).join(" ") : text
    if ((DRIVING_WORDS.test(statements) || MOVEMENT_DIRECTION.test(statements)) && !routineInfo) return { allowed: false, layer: "fail_closed", reason: `${why}; driving-related instructions need review in ${safety.mode} context`, costUsd: 0 }
    return { allowed: true, layer: "none", reason: null, costUsd: 0 }
  }
  const client = llm()
  if (!client) return fallback("No classifier is configured")
  try {
    const message = await client.messages.create({
      // One word, no reasoning: a reasoning model (DeepSeek) otherwise spends the whole budget thinking, returns no
      // answer, and every message that mentions driving is held as a clearance card.
      model: classifierModel(), max_tokens: 400, thinking: { type: "disabled" }, system: CLASSIFIER_PROMPT,
      messages: [{ role: "user", content: `Trusted safety context: ${safety.mode.toUpperCase()}\n${safety.reasons.join(" ")}\n\n${context?.driverSaid ? `What the driver wrote before, for context only:\n"""${context.driverSaid.slice(0, 600)}"""\n\n` : ""}Message to the driver:\n"""${text}"""` }],
    }, { timeout: 15000 })
    const answer = message.content.filter((block) => block.type === "text").map((block) => (block as { text: string }).text).join("").trim().toUpperCase()
    const cost = usageCost(message.usage)
    if (answer.startsWith("BLOCK")) return { allowed: false, layer: "classifier", reason: "the classifier read it as permission to drive on", costUsd: cost }
    if (answer.startsWith("ALLOW")) return { allowed: true, layer: "classifier", reason: null, costUsd: cost }
    throw new Error(`unexpected classifier answer: ${answer.slice(0, 40)}`)
  } catch (error) {
    return fallback(`The classifier was unavailable (${error instanceof Error ? error.message : "error"})`)
  }
}
