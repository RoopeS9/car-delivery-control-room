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

/** The languages the safety instructions are written in. English is the fallback and the operators' reading. */
export type SafetyLanguage = "en" | "fi" | "sv" | "de" | "da" | "fr"

/** The only safety instructions the agent can send on its own. `{name}` is the driver's first name. */
export const SAFETY_TEMPLATES: readonly SafetyTemplate[] = [
  { id: "stop_when_safe", label: "Stop when safe", text: "{name}, please slow down and stop at the next safe place, then switch on your hazard lights." },
  { id: "engine_off", label: "Engine off", text: "Please switch the engine off and leave it off." },
  { id: "do_not_drive_on", label: "Do not drive on", text: "Please do not drive the car any further until an operator has confirmed what happens next." },
  { id: "leave_car_behind_barrier", label: "Leave the car, stand behind the barrier", text: "Please get out on the side away from traffic and stand behind the barrier, well away from the car." },
  { id: "call_112", label: "Call 112", text: "If anyone is hurt, or you see smoke or fire, call 112 now. Your safety comes first." },
  { id: "wait_for_help", label: "Wait near the car", text: "Please stay in a safe place near the car. An operator is working out what happens next, and we will message you soon." },
]

/**
 * The same instructions in the drivers' other languages (Bahn's drivers live in Finland, Germany, France, Denmark,
 * Sweden and Belgium). Fixed text, like the English: the model never writes a safety instruction.
 */
const TRANSLATIONS: Record<Exclude<SafetyLanguage, "en">, Record<string, string>> = {
  fi: {
    stop_when_safe: "{name}, hidasta ja pysähdy seuraavaan turvalliseen paikkaan. Laita sitten hätävilkut päälle.",
    engine_off: "Sammuta moottori ja jätä se sammuksiin.",
    do_not_drive_on: "Älä aja autolla pidemmälle ennen kuin päivystäjämme on vahvistanut, mitä seuraavaksi tehdään.",
    leave_car_behind_barrier: "Nouse autosta liikenteestä poispäin olevalta puolelta ja mene kaiteen taakse, reilusti etäälle autosta.",
    call_112: "Jos joku on loukkaantunut tai näet savua tai tulta, soita heti 112. Turvallisuutesi on tärkeintä.",
    wait_for_help: "Pysy turvallisessa paikassa auton lähellä. Päivystäjämme selvittää, mitä seuraavaksi tehdään, ja viestimme sinulle pian.",
  },
  sv: {
    stop_when_safe: "{name}, sakta ner och stanna på nästa säkra plats. Slå sedan på varningsblinkersen.",
    engine_off: "Stäng av motorn och låt den vara avstängd.",
    do_not_drive_on: "Kör inte bilen längre förrän en operatör hos oss har bekräftat vad som händer härnäst.",
    leave_car_behind_barrier: "Kliv ur på sidan bort från trafiken och ställ dig bakom räcket, en bra bit från bilen.",
    call_112: "Om någon är skadad, eller om du ser rök eller eld, ring 112 nu. Din säkerhet kommer först.",
    wait_for_help: "Stanna på en säker plats nära bilen. En operatör hos oss tar reda på vad som händer härnäst, och vi hör av oss snart.",
  },
  de: {
    stop_when_safe: "{name}, bitte fahren Sie langsamer und halten Sie an der nächsten sicheren Stelle an. Schalten Sie dann die Warnblinkanlage ein.",
    engine_off: "Bitte stellen Sie den Motor ab und lassen Sie ihn aus.",
    do_not_drive_on: "Bitte fahren Sie nicht weiter, bis ein Disponent bestätigt hat, wie es weitergeht.",
    leave_car_behind_barrier: "Bitte steigen Sie auf der verkehrsabgewandten Seite aus und stellen Sie sich hinter die Leitplanke, mit Abstand zum Auto.",
    call_112: "Wenn jemand verletzt ist oder Sie Rauch oder Feuer sehen, rufen Sie sofort die 112 an. Ihre Sicherheit geht vor.",
    wait_for_help: "Bitte bleiben Sie an einem sicheren Ort in der Nähe des Autos. Ein Disponent klärt gerade, wie es weitergeht, und wir melden uns bald.",
  },
  da: {
    stop_when_safe: "{name}, sæt farten ned og stop på det næste sikre sted. Tænd derefter havariblinket.",
    engine_off: "Sluk motoren, og lad den være slukket.",
    do_not_drive_on: "Kør ikke bilen længere, før en disponent hos os har bekræftet, hvad der skal ske.",
    leave_car_behind_barrier: "Stig ud i siden væk fra trafikken, og stil dig bag autoværnet, et godt stykke fra bilen.",
    call_112: "Hvis nogen er kommet til skade, eller du ser røg eller ild, så ring 112 nu. Din sikkerhed kommer først.",
    wait_for_help: "Bliv på et sikkert sted i nærheden af bilen. En disponent hos os finder ud af, hvad der skal ske, og vi skriver til dig snart.",
  },
  fr: {
    stop_when_safe: "{name}, ralentissez et arrêtez-vous au prochain endroit sûr, puis allumez vos feux de détresse.",
    engine_off: "Coupez le moteur et laissez-le éteint.",
    do_not_drive_on: "Ne roulez plus avec la voiture tant qu’un opérateur n’a pas confirmé la suite.",
    leave_car_behind_barrier: "Sortez du côté opposé à la circulation et placez-vous derrière la glissière de sécurité, bien à l’écart de la voiture.",
    call_112: "Si quelqu’un est blessé, ou si vous voyez de la fumée ou du feu, appelez le 112 maintenant. Votre sécurité passe avant tout.",
    wait_for_help: "Restez dans un endroit sûr près de la voiture. Un opérateur organise la suite, et nous vous écrivons très bientôt.",
  },
}

/** Whole words in any script: `\b` in JavaScript only knows ASCII letters, so it fails on "är", "rök" or "fumée". */
export function anyWord(words: string, flags = "giu"): RegExp {
  return new RegExp(`(?<!\\p{L})(?:${words})(?!\\p{L})`, flags)
}

/** Words that mark a language in a driver's own message; a few distinctive ones each, so Swedish and Danish part. */
const LANGUAGE_WORDS: Record<SafetyLanguage, RegExp> = {
  en: anyWord("the|and|is|my|you|what|with|have|not|there|i'm|it's|car|light|engine"),
  fi: anyWord("ja|ei|on|ole|olen|mä|minä|auto|autossa|nyt|että|mitä|voin|kanssa|tämä|vilkkuu|palaa|moottori|valo"),
  sv: anyWord("och|jag|inte|är|vad|lampan|någon|motorn|bilen|stannat"),
  da: anyWord("og|jeg|ikke|hvad|lampen|nogen|også|motoren|holder"),
  de: anyWord("und|ich|nicht|ist|das|der|die|ein|eine|wagen|jetzt|lampe|leuchtet|bin|habe"),
  fr: anyWord("et|je|ne|pas|est|le|la|les|une|voiture|voyant|maintenant|suis|allumé"),
}

/** The language a driver wrote in, when the words make it clear; otherwise null. */
export function detectLanguage(text: string): SafetyLanguage | null {
  const scores = (Object.keys(LANGUAGE_WORDS) as SafetyLanguage[])
    .map((language) => ({ language, score: text.match(LANGUAGE_WORDS[language])?.length ?? 0 }))
    .sort((a, b) => b.score - a.score)
  return scores[0].score >= 2 && scores[0].score > scores[1].score ? scores[0].language : null
}

const COUNTRY_LANGUAGE: Record<string, SafetyLanguage> = { FI: "fi", SE: "sv", DE: "de", AT: "de", DK: "da", FR: "fr", BE: "fr" }

/**
 * Which languages a safety instruction goes out in: the one the driver writes in, when their messages show it;
 * otherwise their home country's language with English after it, since a guess must still be readable.
 */
export function safetyLanguages(driverTexts: string[], homeCountry: string | null | undefined): SafetyLanguage[] {
  const written = detectLanguage(driverTexts.slice(-3).join(" "))
  if (written) return [written]
  const local = COUNTRY_LANGUAGE[String(homeCountry ?? "").toUpperCase()]
  return local ? [local, "en"] : ["en"]
}

export function renderSafetyTemplate(id: string, driverFirstName: string | null, languages: SafetyLanguage[] = ["en"]): string | null {
  const template = SAFETY_TEMPLATES.find((entry) => entry.id === id)
  if (!template) return null
  const name = driverFirstName?.trim()
  const fill = (text: string) => name ? text.replace("{name}", name) : text.replace(/^\{name\}, (.)/, (_, first: string) => first.toUpperCase())
  return [...new Set(languages)].map((language) => fill(language === "en" ? template.text : TRANSLATIONS[language][id] ?? template.text)).join("\n")
}

const LANGUAGE_NAMES: Record<SafetyLanguage, string> = { en: "English", fi: "Finnish", sv: "Swedish", de: "German", da: "Danish", fr: "French" }

/**
 * What the agent reads for a safety line the server sent in another language: the English text and which languages
 * went out. Shown the Finnish line itself, the model took it as the conversation's language and answered a driver who
 * writes English in Finnish.
 */
export function safetyLineForModel(body: string, data: Record<string, unknown>): string {
  const languages = (Array.isArray(data.languages) ? data.languages : []).filter((language): language is SafetyLanguage => language in LANGUAGE_NAMES)
  if (typeof data.template_id !== "string" || !languages.some((language) => language !== "en")) return body
  const english = renderSafetyTemplate(data.template_id, null) ?? body
  return `${english} (sent in ${languages.map((language) => LANGUAGE_NAMES[language]).join(" and ")}, their home country's language; it does not set the language you write in)`
}

/**
 * The instructions a reported fault calls for, from the code guide and the light alone: what the rulebook says to
 * give for the severity (warning-light.md). Codes the guide does not know, and monitor-level ones, call for none.
 */
export function faultSafetyTemplates(codes: string[], mil: string | null | undefined): string[] {
  const severities = codes.map((code) => troubleCode(code)?.severity)
  if (mil === "FLASHING" || severities.includes("STOP_NOW")) return ["stop_when_safe", "engine_off"]
  if (severities.includes("DRIVE_TO_SAFE_STOP")) return ["stop_when_safe"]
  return []
}

/** A driver who reports fire, smoke or someone hurt gets the 112 line before the model reads anything. */
const EMERGENCY = anyWord("smoke|smoking|fire|flames?|burning|hurt|injured|bleeding|savua?|tulta|liekk\\p{L}*|loukkaantu\\p{L}*|rök|eld|brinner|skadad|røg|ild|brænder|kommet til skade|rauch|feuer|brennt|verletzt|fumée|feu|brûle|blessée?s?")
const NO_EMERGENCY = /(?<!\p{L})(?:no|not|ei|eikä|inget|ingen|keine?|kein|ikke|pas de|aucune?)\s+(?:\p{L}+\s+)?$/iu

export function reportsEmergency(text: string): boolean {
  for (const match of text.matchAll(EMERGENCY)) {
    if (!NO_EMERGENCY.test(text.slice(Math.max(0, (match.index ?? 0) - 25), match.index))) return true
  }
  return false
}

// ---------------------------------------------------------------- patterns

const CLEARANCE = /\b(you can|you may|you could|you(?:'re| are) (?:fine|ok|okay|good|clear|cleared) to|it(?:'s| is) (?:safe|fine|ok|okay) to|(?:ok|okay|safe|fine) to|feel free to|go ahead and|cleared to)\b[^.!?\n]{0,40}?\b(drive|driving|continue|carry on|keep going|move the car|restart|go on)\b/gi
const NEGATED = /\b(not|n't|never|no one|nobody|cannot|can't)\s+(?:\w+\s+){0,2}$/i
const CONDITIONAL = /\b(?:until|unless|before|once|after|when)\b[^.!?\n]{0,25}\b(?:operator|operations)\b[^.!?\n]{0,30}(?:confirms?|approves?|decides?|clears?)[^.!?\n]{0,15}$|\b(?:operator|operations)\b[^.!?\n]{0,20}(?:will decide|must confirm|has to confirm)[^.!?\n]{0,20}$/i

/** The car as the subject: "the car can keep going", "it is still drivable", "the car is fine to drive". */
const CAR_CLEARANCE = /\b(?:the car|your car|the vehicle|it)\s+(?:can|may|could|should be able to|is (?:fine|ok|okay|safe|good|able) to)\s+(?:keep going|continue|carry on|be driven|drive on|keep driving|go on|make it)\b|\b(?:the car|your car|the vehicle|it)\s+is\s+(?:still\s+|normally\s+|perfectly\s+)?(?:drivable|driveable|roadworthy|fine to drive|safe to drive)\b/gi

/**
 * The same clearance in the drivers' other languages: "Sie können weiterfahren", "voit jatkaa", "du kan köra vidare",
 * "du kan fortsætte", "vous pouvez repartir", and "safe to drive" in each.
 */
const CLEARANCE_OTHER: readonly RegExp[] = [
  anyWord("(?:du kannst|sie können|können sie|kannst du|dürfen sie|darfst du)[^.!?\\n]{0,40}?(?:weiterfahren|weiter fahren|losfahren|fahren)", "iu"),
  anyWord("(?:ist|wäre) (?:es )?(?:sicher|unbedenklich|kein problem|in ordnung)[^.!?\\n]{0,20}(?:weiterzufahren|zu fahren)|(?:ruhig|problemlos|bedenkenlos) weiter(?:fahren)?", "iu"),
  anyWord("(?:voit|voitte|saat|saatte)[^.!?\\n]{0,40}?(?:jatkaa|ajaa|ajella|lähteä)|turvallista (?:ajaa|jatkaa)", "iu"),
  anyWord("(?:du kan|ni kan|du får|ni får)[^.!?\\n]{0,40}?(?:köra|fortsätta|åka vidare)|säkert att (?:köra|fortsätta)", "iu"),
  anyWord("(?:du kan|i kan|du må|i må)[^.!?\\n]{0,40}?(?:køre|fortsætte)|sikkert at (?:køre|fortsætte)", "iu"),
  anyWord("(?:vous pouvez|tu peux)[^.!?\\n]{0,40}?(?:continuer|rouler|repartir|conduire|reprendre la route)|(?:sans danger|sûr) de (?:rouler|conduire|continuer)", "iu"),
]
const NEGATION_OTHER = anyWord("nicht|kein\\p{L}*|ei|älä|inte|ikke|pas|jamais|aldrig|never|not", "iu")
const OPERATOR_WORD = anyWord("disponent\\p{L}*|päivystäjä\\p{L}*|operaattori\\p{L}*|operatör\\p{L}*|opérateur\\p{L}*|operator\\p{L}*|operations", "iu")
const CONDITION_WORD = anyWord("bis|sobald|erst|wenn|kunnes|ennen|kun|jälkeen|tills|innan|när|indtil|før|når|jusqu\\p{L}*|avant|quand|dès que|until|unless|before|once|after|when", "iu")

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
  // With the car as the subject the negation sits inside the phrase ("the car cannot keep going"); words before it
  // ("not critical and the car can keep going") do not negate it. A question about it ("whether the car can
  // continue") or a condition ("until an operator confirms") does not clear anyone.
  for (const match of text.matchAll(CAR_CLEARANCE)) {
    const before = text.slice(Math.max(0, (match.index ?? 0) - 50), match.index)
    if (/\b(?:not|n't|cannot)\b/i.test(match[0]) || /\b(?:whether|if)\s*$/i.test(before) || CONDITIONAL.test(before)) continue
    return match[0]
  }
  // In the other languages a negation inside the phrase ("Sie können nicht weiterfahren") and a sentence about an
  // operator deciding first ("erst wenn der Disponent es bestätigt") do not clear anyone.
  for (const pattern of CLEARANCE_OTHER) {
    const match = pattern.exec(text)
    if (!match) continue
    const start = Math.max(text.lastIndexOf(".", match.index), text.lastIndexOf("!", match.index), text.lastIndexOf("?", match.index), text.lastIndexOf("\n", match.index)) + 1
    const ends = [".", "!", "?", "\n"].map((mark) => text.indexOf(mark, match.index + match[0].length)).filter((at) => at >= 0)
    const sentence = text.slice(start, ends.length ? Math.min(...ends) : text.length)
    if (NEGATION_OTHER.test(match[0]) || /(?<!\p{L})(?:ob|jos|om|si)\s*$/iu.test(text.slice(start, match.index))) continue
    if (OPERATOR_WORD.test(sentence) && CONDITION_WORD.test(sentence)) continue
    return match[0]
  }
  return null
}

/** An explicit instruction to stop: pull over, next safe place, engine off, hazards, behind the barrier, do not drive. */
const STOP_INSTRUCTION = /\b(pull (over|in)|next safe place|stop (at|in|the car|now|safely)|switch (the engine|it) off|engine off|hazard lights|behind the barrier|do not (drive|continue|move the car)|don't (drive|continue|move the car)|stay (stopped|where you are|with the car))\b|(?<!\p{L})(?:halten sie an|motor ab|warnblink\p{L}*|leitplanke|nicht weiter|pysähdy|sammuta moottori|hätävilk\p{L}*|älä aja|stanna|stäng av motorn|varningsblink\p{L}*|kör inte|stop på|sluk motoren|havariblink\p{L}*|kør ikke|arrêtez-vous|coupez le moteur|feux de détresse|ne roulez plus)(?!\p{L})/iu

/** A driver reporting a fault in their own language: a light, a breakdown, smoke, a shaking car, power loss. */
const FAULT_REPORT_OTHER = anyWord("\\p{L}*(?:warnleuchte|kontrollleuchte)|panne|rauch|ruckelt|leistung|varoitusvalo|merkkivalo|vika\\p{L}*|savu\\p{L}*|tärisee|varningslampa|lampan lyser|rök|skakar|advarselslampe|lampen lyser|røg|ryster|voyant|fumée|tremble|perte de puissance", "iu")

/** Words that make a message worth a closer look when the classifier is unavailable. */
export const DRIVING_WORDS = /\b(driv\w*|continu\w*|carry on|keep going|go on|head (?:to|on|off|for)|move on|restart\w*|journey|on your way|get going|set off)\b|(?<!\p{L})(?:fahr\p{L}*|losfahr\p{L}*|weiter\p{L}*|aja\p{L}*|ajele\p{L}*|jatka\p{L}*|matka\p{L}*|kör\p{L}*|fortsätt\p{L}*|kør\p{L}*|fortsæt\p{L}*|roul\p{L}*|repart\p{L}*|conduir\p{L}*|reprendre la route)(?!\p{L})/iu
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

When the context says every active code is CONTINUE_AND_MONITOR, saying in neutral words which system a code concerns and asking diagnostic questions (is the light steady, does the car drive differently, any smell or sound, is the fuel cap tight) are allowed, as long as the message does not say they may continue. Saying an operator confirms whether they continue is allowed. Reassurance about the fault is not: calling it harmless, minor, usually not critical, nothing to worry about, or not something that should stop them is BLOCK, because the driver reads it as permission.

Allow it if it only tells them to stop, stay safe, wait, send information, or says an operator will decide. Allow questions that do not give permission. A message that refuses or forbids driving is allowed, even when it mentions driving many times. Telling them to pull over, get to the next safe place, stop, switch the engine off, put the hazard lights on or get behind the barrier is a stop instruction, never permission, in every context, even when it also reports codes or asks what the dashboard shows.

Examples:
- "Please don't drive on, not even the 15 km. I can't clear you to drive." ALLOW
- "An operator has to confirm before you drive on. Stay with the car." ALLOW
- "Are you safe? Is the car still moving?" ALLOW
- RESTRICTED, "The car is reporting a flashing check-engine light and engine shaking, so please follow the stop instructions I just sent: get to the next safe place, switch the engine off and put your hazard lights on. Are you safe and out of traffic?" ALLOW
- "The amber light is fine for now, head to the ferry when you're ready." BLOCK
- "If it feels normal again you can carry on slowly." BLOCK
- ROUTINE, "Use the marked vehicle entrance at Norvessia in Turku." ALLOW
- ROUTINE, "The site is open until 18:00; call reception before arrival." ALLOW
- RESTRICTED, "Drive to the courtyard gate now." BLOCK
- RESTRICTED, only CONTINUE_AND_MONITOR codes, "P0135 concerns the oxygen sensor heater. An operator confirms whether you continue. Is the light steady, and does the car drive any differently?" ALLOW
- RESTRICTED, only CONTINUE_AND_MONITOR codes, "P0135 is usually not critical; it is not something that should stop you immediately." BLOCK
- RESTRICTED, "Sie können ruhig weiterfahren, die Lampe ist nicht schlimm." BLOCK
- RESTRICTED, "Pysähdy seuraavaan turvalliseen paikkaan ja sammuta moottori. Oletko turvassa?" ALLOW
- RESTRICTED, only CONTINUE_AND_MONITOR codes, "It's only the oxygen sensor, so you can keep going." BLOCK

The message may be in any language (Finnish, Swedish, German, Danish, French, English); judge it the same way.

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
  if (safety.mode === "routine" && (/\b(?:warning light|engine fault|reduced power|overheat\w*|smoke|burning smell|broken down|unsafe|not safe|can(?:not|'t) continue|safe to drive|should I (?:drive|continue))\b/i.test(context?.driverSaid ?? "")
    || FAULT_REPORT_OTHER.test(context?.driverSaid ?? ""))) {
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
    if (answer.startsWith("BLOCK")) {
      // A message that plainly tells the driver to stop is asked about once more before it is held: holding a stop
      // instruction and replacing it with a fallback is worse than a second, cheap look.
      if (STOP_INSTRUCTION.test(text)) {
        const second = await client.messages.create({
          model: classifierModel(), max_tokens: 400, output_config: { effort: "low" }, system: CLASSIFIER_PROMPT,
          messages: [{ role: "user", content: `Trusted safety context: ${safety.mode.toUpperCase()}\n${safety.reasons.join(" ")}\n\nThis message contains an explicit instruction to stop or switch off. Does it ALSO give permission to drive on or dismiss the warning? If it only tells them to stop, wait, or answer questions, answer ALLOW.\n\nMessage to the driver:\n"""${text.slice(0, 2000)}"""` }],
        }, { timeout: 15000 })
        const again = second.content.filter((block) => block.type === "text").map((block) => (block as { text: string }).text).join("").trim().toUpperCase()
        const total = cost + usageCost(second.usage)
        if (again.startsWith("ALLOW")) return { allowed: true, layer: "classifier", reason: null, costUsd: total }
        return { allowed: false, layer: "classifier", reason: "the classifier read it as permission to drive on, twice", costUsd: total }
      }
      return { allowed: false, layer: "classifier", reason: "the classifier read it as permission to drive on", costUsd: cost }
    }
    if (answer.startsWith("ALLOW")) return { allowed: true, layer: "classifier", reason: null, costUsd: cost }
    throw new Error(`unexpected classifier answer: ${answer.slice(0, 40)}`)
  } catch (error) {
    return fallback(`The classifier was unavailable (${error instanceof Error ? error.message : "error"})`)
  }
}
