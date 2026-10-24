// Run one simulated call: a brief on the caller side, a persona on the callee side, deterministic turns.
// Outbound: opening, state the facts, ask each slot in order, closing. Inbound: urgency first, pick the
// situation's checklist, ask at most MAX_QUESTIONS, then escalate with a tool call. Output is a validated CallRecord.
import { CHECKLISTS, CallRecord, MAX_QUESTIONS, type CallBrief, type SlotName } from "../live"
import type { Persona } from "./personas"

const QUESTION: Record<SlotName, string> = {
  VEHICLE_PRESENT: "Is the car on site right now?",
  VEHICLE_IDENTITY_MATCH: "Could you check the registration or the last digits of the VIN against your list?",
  KEYS_AT_SITE: "Are the keys at your desk?",
  RELEASE_CONTACT_NAME: "Who will hand over the car and keys to our driver?",
  RELEASE_DOCUMENT_PRESENT: "Do you have the signed release paper for this car?",
  COMMERCIAL_HOLD: "Is there any hold on the car from the seller?",
  ACCESS_INSTRUCTION: "Where should the driver report when they arrive?",
  OPEN_DURING_SLOT: "Will someone be there at the start of the slot?",
  DRIVER_TRAVEL_BOOKED: "Do you have your travel to the pickup booked?",
  DRIVER_START_LOCATION: "Where will you be starting from?",
  DRIVER_FIT_TO_DRIVE: "Are you fit and rested for the job?",
  ETA: "When do you expect to arrive?",
  CURRENT_LOCATION: "Where exactly are you?",
  DRIVER_SAFE: "Are you somewhere safe, off the road?",
  FERRY_CHECKED_IN: "Have you checked in at the ferry gate?",
  RECEIVER_PRESENT_AT_WINDOW: "Will the named receiver be there during the delivery window?",
  ISSUE_REPORTED: "Is there anything else we should know?",
  WARNING_LIGHT: "Which warning light is on, and is it flashing or steady?",
  ENGINE_OFF: "Is the engine switched off now?",
  SYMPTOMS: "Any shaking, loss of power, noise, smell or smoke?",
  INJURIES: "Is anyone hurt?",
  CAR_MOVES: "Does the car start or move at all?",
  CONNECTION_AT_RISK: "Is a ferry, train or pickup slot at risk?",
  EXPENSE_ITEM: "What did you pay for, and how much?",
  QUESTION: "What is your question?",
}

export function runSimulatedCall(brief: CallBrief, persona: Persona, startedAt: string): CallRecord {
  const t0 = Date.parse(startedAt)
  let seq = 0, clock = t0
  const turns: CallRecord["turns"] = []
  const slots: CallRecord["slots"] = []
  const toolCalls: CallRecord["toolCalls"] = []
  const say = (speaker: "CALLER" | "CALLEE", text: string) => {
    const dur = 1200 + text.length * 55
    turns.push({ seq, speaker, startedAt: new Date(clock).toISOString(), endedAt: new Date(clock + dur).toISOString(), text, audioKey: null })
    clock += dur + 400
    return seq++
  }
  const ask = (slot: SlotName) => {
    say("CALLER", QUESTION[slot])
    const a = persona.answers[slot]
    const text = a?.text ?? "I do not know."
    const at = say("CALLEE", text)
    if (a?.value) slots.push({ value: a.value, turnSeq: at, quote: text })
  }

  const inbound = brief.purpose === "DRIVER_INBOUND"
  let triage: CallRecord["triage"] = null
  let outcome: CallRecord["outcome"] = "COMPLETED"

  if (inbound) {
    const ib = persona.inbound; if (!ib) throw new Error(`${persona.id} has no inbound script`)
    say("CALLEE", persona.greeting)
    say("CALLER", brief.opening)
    const at = say("CALLEE", ib.opening)
    triage = { urgency: ib.urgency, situation: ib.situation, turnSeq: at, quote: ib.opening }
    if (triage.urgency === "EMERGENCY") {
      say("CALLER", "If anyone is hurt or there is fire or smoke, call one one two now. Get away from the road. I am alerting an operator this second.")
      toolCalls.push({ turnSeq: seq - 1, name: "ESCALATE_TO_OPERATOR", argument: "EMERGENCY: " + ib.opening })
    }
    // Confirm what the job card already says instead of asking, then fill the situation's checklist.
    say("CALLER", `Understood. ${brief.mayState[0] ?? ""}`)
    // The opening already answered "are you safe": record it from that turn instead of asking twice.
    const saidSafe = /\b(i am|i'm) safe\b/i.test(ib.opening)
    if (saidSafe) slots.push({ value: { slot: "DRIVER_SAFE", value: true }, turnSeq: at, quote: ib.opening })
    const list = CHECKLISTS[triage.situation].filter((s) => s !== "DRIVER_SAFE" || !saidSafe)
    for (const slot of list.slice(0, MAX_QUESTIONS[triage.urgency])) ask(slot)
    if (triage.urgency !== "ROUTINE") {
      const light = slots.find((s) => s.value.slot === "WARNING_LIGHT")?.value.value
      if (light === "AMBER_FLASHING" || light === "RED") say("CALLER", "Please keep the engine off and stay off the road. I cannot clear you to drive on; an operator decides that.")
      toolCalls.push({ turnSeq: seq - 1, name: "ESCALATE_TO_OPERATOR", argument: `${triage.urgency} ${triage.situation}: ${slots.map((s) => `${s.value.slot}=${JSON.stringify(s.value.value)}`).join(", ")}` })
      outcome = "ESCALATED"
    }
    say("CALLER", brief.closing)
  } else {
    say("CALLEE", persona.greeting)
    say("CALLER", brief.opening)
    say("CALLER", brief.mayState.slice(0, 2).join(" "))
    for (const slot of brief.ask) ask(slot)
    for (const line of persona.volunteers ?? []) say("CALLEE", line)
    say("CALLER", brief.closing)
    const unanswered = brief.ask.filter((s) => !slots.some((x) => x.value.slot === s))
    if (unanswered.length) outcome = "PARTIAL"
  }

  return CallRecord.parse({
    id: `call-sim-${persona.id}-${t0.toString(36)}`, orderId: brief.orderId, brief, direction: inbound ? "INBOUND" : "OUTBOUND",
    attempt: 1, startedAt, endedAt: new Date(clock).toISOString(), outcome, engine: "SIMULATED",
    triage, toolCalls, turns, slots, toneReview: null,
    retryAfter: outcome === "PARTIAL" ? new Date(clock + 2 * 3600e3).toISOString() : null,
  })
}
