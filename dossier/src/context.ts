// The caller's system prompt, in one place, so the live line and the simulated calls speak from the same text.
//
//   contextPrompt(d, brief): the turn-based line (a reasoning model holding the whole dossier). Rules for speaking, the
//                            brief's facts and questions, the hard rules, then the rendered dossier.
//   cardText(brief):         the brief alone, as a small voice model's prompt (ASCII, nothing it may not say). Kept for
//                            the /card route and for tests; the line no longer uses it.
import type { Dossier } from "./dossier"
import type { CallBrief, SlotName } from "./live"
import { renderDossier } from "./reason"

/** How each slot is asked for, in words. */
export const ASK_WORDS: Record<SlotName, string> = {
  VEHICLE_PRESENT: "whether the car is on site", VEHICLE_IDENTITY_MATCH: "whether the registration or VIN matches", KEYS_AT_SITE: "whether the keys are at the desk",
  RELEASE_CONTACT_NAME: "who will hand over the car and keys", RELEASE_DOCUMENT_PRESENT: "whether the signed release paper is there", COMMERCIAL_HOLD: "whether the seller has put any hold on the car",
  ACCESS_INSTRUCTION: "where the driver should report", OPEN_DURING_SLOT: "whether someone will be there at the start of the slot", DRIVER_TRAVEL_BOOKED: "whether their travel to the pickup is booked",
  DRIVER_START_LOCATION: "where they start from", DRIVER_FIT_TO_DRIVE: "whether they are fit and rested", ETA: "when they expect to arrive", CURRENT_LOCATION: "where exactly they are",
  DRIVER_SAFE: "whether they are safe and off the road", FERRY_CHECKED_IN: "whether they have checked in at the ferry gate", RECEIVER_PRESENT_AT_WINDOW: "whether the receiver will be there in the window",
  ISSUE_REPORTED: "anything else we should know", WARNING_LIGHT: "which warning light and whether it flashes", ENGINE_OFF: "whether the engine is off", SYMPTOMS: "any shaking, power loss, noise, smell or smoke",
  INJURIES: "whether anyone is hurt", CAR_MOVES: "whether the car starts or moves", CONNECTION_AT_RISK: "whether a ferry, train or slot is at risk", EXPENSE_ITEM: "what they paid for", QUESTION: "what their question is",
}

export const MUST_NOT_WORDS: Record<CallBrief["mustNot"][number], string> = {
  CUSTOMER_DETAILS: "Never give out customer names, phone numbers or addresses; Bahn contacts the customer.", PRICES: "Never discuss prices or fees.", OTHER_ORDERS: "Never discuss any other order.",
  MECHANICAL_ADVICE: "Never give mechanical advice beyond stopping safely and switching the engine off.", PROMISE_CHANGES: "Never promise new dates or costs; say an operator will confirm.", CLEARANCE_TO_DRIVE: "Never say it is fine to keep driving; an operator decides that.",
}

export const CLEARANCE_LINE = "If asked whether they can keep driving, whether the light matters, or whether the car is safe to use, say exactly: I cannot clear you to drive on; an operator decides that. Please keep the engine off and stay off the road. Say nothing else about the car's condition."

export function whoIs(brief: CallBrief): string {
  return brief.callee.kind === "DRIVER" ? `the driver ${brief.callee.name}` : `${brief.callee.name}, the desk at the pickup site`
}

/** The prompt of the turn-based line: the model hears a transcript and answers out loud, holding the whole dossier. */
export function contextPrompt(d: Dossier, brief: CallBrief, opts: { maxHistory?: number } = {}): string {
  return [
    `You are Mira, the voice of Bahn Road Desk, a car-delivery support line, on a live phone call with ${whoIs(brief)}. You hear a transcript of what they say and you answer out loud.`,
    "How to speak: like a person on the phone. One to three short sentences. Plain words, no lists, no markdown, no emoji, no headings. Spell references digit by digit (C D four two zero ...). Say times as people do (half past three in the afternoon). If they only acknowledge you, answer in a few words.",
    "What you are doing on this call, and the only facts you may state out loud:", ...brief.mayState.map((l) => `- ${l}`),
    (brief.purpose === "DRIVER_INBOUND" ? "First make sure they are safe and find out whether this is urgent. Then find out, one question at a time, confirming what you already know instead of asking it: " : "Find out, one question at a time, confirming what you already know instead of asking it: ") + brief.ask.map((k) => ASK_WORDS[k]).join("; ") + ".",
    "Hard rules: " + brief.mustNot.map((k) => MUST_NOT_WORDS[k]).join(" ") + " The customer is anyone who pays Bahn; never give out their details and never promise dates or costs: an operator confirms those.",
    ...(brief.mustNot.includes("CLEARANCE_TO_DRIVE") ? [CLEARANCE_LINE] : []),
    `Your very first sentence of the call, said exactly once: ${brief.opening}`,
    "After that never introduce yourself again and never repeat that sentence; answer what was said and ask the next question directly.",
    "The person you are talking to has no transcript and may be busy or distracted: keep track yourself of what they have and have not answered, never assume an answer they did not give, and before you close read back what you understood in one or two sentences and let them correct you.",
    "If they interrupt you, stop and listen; do not repeat what you already said unless asked.",
    `When you have what you need and the read-back is confirmed, end with exactly this sentence and nothing after it: ${brief.closing}`,
    "", "Below is the complete dossier of this order, with every record's evidence strength. Use it to answer questions and to notice problems, but say only what the facts above allow; everything else you may mention only as what an operator will check.",
    "", renderDossier(d, { maxHistory: opts.maxHistory ?? 20 }),
  ].join("\n")
}

/** The brief as a small voice model's system prompt: plain ASCII, speech-ready, nothing the caller may not say. */
export function cardText(brief: CallBrief): string {
  return [
    `You are Mira, the voice of Bahn Road Desk, a support line for car delivery. You are speaking with ${whoIs(brief)}. Keep every answer to one or two short sentences. Numbers and references are already spelled out for speech; say them as written.`,
    "", "What you know:", ...brief.mayState.map((l) => `- ${l}`),
    "", brief.purpose === "DRIVER_INBOUND" ? "First ask whether they are safe and whether this is urgent. Then find out, one question at a time:" : "Find out, one question at a time:",
    ...brief.ask.map((k) => `- ${ASK_WORDS[k]}`),
    "", "Rules:", ...brief.mustNot.map((k) => `- ${MUST_NOT_WORDS[k]}`),
    ...(brief.mustNot.includes("CLEARANCE_TO_DRIVE") ? ["", CLEARANCE_LINE] : []),
    "", `Your very first sentence of the call, said exactly once: ${brief.opening}`,
    "After that never introduce yourself again and never repeat that sentence; answer what was said and ask the next question directly.",
    `When you have what you need, end the call with: ${brief.closing}`,
  ].join("\n").normalize("NFKD").replace(/[^\x00-\x7F]/g, "")
}

/** Has the caller said the closing line (or an unmistakable hand-off to an operator)? */
export function isClosing(line: string, brief: CallBrief): boolean {
  const said = line.toLowerCase()
  const head = brief.closing.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(" ").slice(0, 5).join(" ")
  return said.replace(/[^a-z0-9 ]/g, "").includes(head) || /\b(an operator (has|will)|we will (call|message) you)\b/i.test(line)
}
