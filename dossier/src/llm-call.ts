// A simulated call where BOTH sides are the model, grounded in the dossier:
//   caller  = Mira, running on the model-composed card (the same text the voice line gets), one or two sentences a turn;
//   callee  = the persona (desk or driver), answering only from a fact sheet built from the dossier plus the scenario's twist;
//   then a typed extraction pass turns the transcript into slots that cite turns, and triage for inbound calls.
// Output is the same CallRecord the scripted runner produces, so the UI and the dossier do not care which ran.
import { z } from "zod"
import type { Dossier } from "./dossier"
import { CHECKLISTS, CallRecord, MAX_QUESTIONS, SlotName, SlotValue, Situation, Urgency, type CallBrief } from "./live"
import type { Persona } from "./sim/personas"
import { composeBrief, renderDossier } from "./reason"
import { items } from "./brief"

type Usage = { prompt_tokens: number; completion_tokens: number; cost?: number }
async function complete(apiKey: string, model: string, messages: { role: "system" | "user" | "assistant"; content: string }[], json = false, temperature = 0.6): Promise<{ text: string; cost: number }> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "x-title": "road-dossier sim call" },
    // Spoken turns: no hidden reasoning (it eats the small budget and returns empty text); extraction: JSON mode with room to think.
    body: JSON.stringify({ model, temperature, max_tokens: json ? 2500 : 300, usage: { include: true }, ...(json ? { response_format: { type: "json_object" } } : { reasoning: { enabled: false } }), messages }),
  })
  if (!res.ok) throw new Error(`openrouter ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const body = (await res.json()) as { choices: { message: { content: string } }[]; usage?: Usage }
  return { text: (body.choices[0]?.message.content ?? "").trim(), cost: body.usage?.cost ?? 0 }
}

/** The card text for the caller, same rendering as the service's /card so the simulation and the voice line agree. */
export function cardText(brief: CallBrief, askWords: Record<string, string>): string {
  const who = brief.callee.kind === "DRIVER" ? `the driver ${brief.callee.name}` : `${brief.callee.name}, the desk at the pickup site`
  return [
    `You are Mira, the voice of Bahn Road Desk, a support line for car delivery. You are speaking with ${who}. Keep every answer to one or two short sentences. Numbers and references are already spelled out for speech; say them as written.`,
    "", "What you know:", ...brief.mayState.map((l) => `- ${l}`),
    "", brief.purpose === "DRIVER_INBOUND" ? "First ask whether they are safe and whether this is urgent. Then find out, one question at a time:" : "Find out, one question at a time:",
    ...brief.ask.map((k) => `- ${askWords[k] ?? k}`),
    "", "Rules:", ...brief.mustNot.map((k) => `- ${k.replace(/_/g, " ").toLowerCase()}: never`),
    ...(brief.mustNot.includes("CLEARANCE_TO_DRIVE") ? ["", "If they ask whether they can keep driving, whether the light matters, or whether the car is safe to use, say exactly: I cannot clear you to drive on; an operator decides that. Please keep the engine off and stay off the road. Say nothing else about the car's condition."] : []),
    "", `Your very first sentence of the call, said exactly once: ${brief.opening}`,
    "After that never introduce yourself again and never repeat that sentence; answer what was said and ask the next question directly.",
    `When you have what you need, end the call with: ${brief.closing}`,
  ].join("\n")
}

/** What the callee knows: the dossier's view of their side plus the scenario twist from the persona's scripted answers. */
function calleeSheet(d: Dossier, persona: Persona): string {
  const order = items(d, "orders")[0]!.record
  const site = items(d, "sites").map((i) => i.record).find((s) => s.id === order.pickup_site_id)
  const veh = items(d, "vehicles")[0]?.record
  const facts = Object.values(persona.answers).map((a) => a.text)
  const role = persona.role === "PICKUP_SITE_DESK"
    ? `You are the person at the reception desk of ${site?.name ?? "a car dealership"}. A delivery company calls about collecting a car (${veh ? `${veh.make} ${veh.model}` : "a car"}, their reference ${order.reference}).`
    : `You are ${persona.answers.DRIVER_START_LOCATION ? "a freelance delivery driver" : "the driver"} ${items(d, "drivers")[0]?.record.display_name ?? ""} working for a car delivery company. The support line calls you, or you call them.`
  return [role, `Your mood: ${persona.mood.toLowerCase()}.`, "What you know and will say if asked (never invent beyond this; if you do not know, say so):", ...facts.map((f) => `- ${f}`),
    ...(persona.volunteers ?? []).map((v) => `- You may volunteer: ${v}`),
    "Answer in one or two natural spoken sentences. Do not list facts you were not asked about. Do not use markdown."].join("\n")
}

const askWordsDefault: Record<string, string> = {
  VEHICLE_PRESENT: "whether the car is on site", VEHICLE_IDENTITY_MATCH: "whether the registration or VIN matches", KEYS_AT_SITE: "whether the keys are at the desk",
  RELEASE_CONTACT_NAME: "who will hand over the car and keys", RELEASE_DOCUMENT_PRESENT: "whether the signed release paper is there", COMMERCIAL_HOLD: "whether the seller has put any hold on the car",
  ACCESS_INSTRUCTION: "where the driver should report", OPEN_DURING_SLOT: "whether someone will be there at the start of the slot", DRIVER_TRAVEL_BOOKED: "whether their travel to the pickup is booked",
  DRIVER_START_LOCATION: "where they start from", DRIVER_FIT_TO_DRIVE: "whether they are fit and rested", ETA: "when they expect to arrive", CURRENT_LOCATION: "where exactly they are",
  DRIVER_SAFE: "whether they are safe and off the road", FERRY_CHECKED_IN: "whether they have checked in at the ferry gate", RECEIVER_PRESENT_AT_WINDOW: "whether the receiver will be there in the window",
  ISSUE_REPORTED: "anything else we should know", WARNING_LIGHT: "which warning light and whether it flashes", ENGINE_OFF: "whether the engine is off", SYMPTOMS: "any shaking, power loss, noise, smell or smoke",
  INJURIES: "whether anyone is hurt", CAR_MOVES: "whether the car starts or moves", CONNECTION_AT_RISK: "whether a ferry, train or slot is at risk", EXPENSE_ITEM: "what they paid for", QUESTION: "what their question is",
}

const Extraction = z.object({
  triage: z.object({ urgency: Urgency, situation: Situation, turnSeq: z.number().int().nonnegative(), quote: z.string() }).strict().nullable(),
  slots: z.array(z.object({ slot: SlotName, value: z.union([z.string(), z.boolean()]), turnSeq: z.number().int().nonnegative(), quote: z.string() }).strict()).max(16),
  escalate: z.boolean(),
}).strict()

export async function runLlmCall(d: Dossier, persona: Persona, purpose: CallBrief["purpose"], startedAt: string, opts: { model?: string; apiKey?: string } = {}): Promise<{ record: CallRecord; costUsd: number; briefBy: "MODEL" | "RULE" }> {
  const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY; if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set")
  const model = opts.model ?? process.env.REASON_MODEL ?? "deepseek/deepseek-v4-pro"
  const composed = await composeBrief(d, purpose, { model, apiKey }); let cost = composed.costUsd ?? 0
  const brief = composed.brief
  const inbound = purpose === "DRIVER_INBOUND"
  const callerSys = cardText(brief, askWordsDefault) + "\nYou are on a live call now. Speak only your next line, one or two sentences, no stage directions. When you have what you need, or the call has gone on long enough, say your closing line and nothing after it."
  const calleeSys = calleeSheet(d, persona) + (inbound && persona.inbound ? `\nYou called the support line. Your first words after they answer are: "${persona.inbound.opening}"` : "")
  const turns: CallRecord["turns"] = []; let seq = 0, clock = Date.parse(startedAt)
  const say = (speaker: "CALLER" | "CALLEE", text: string) => { const dur = 1200 + text.length * 55; turns.push({ seq, speaker, startedAt: new Date(clock).toISOString(), endedAt: new Date(clock + dur).toISOString(), text, audioKey: null }); clock += dur + 400; return seq++ }
  const history: { role: "system" | "user" | "assistant"; content: string }[] = []   // from the caller's point of view: assistant = caller
  const asCallee = () => history.map((m) => (m.role === "system" ? m : { role: m.role === "assistant" ? "user" as const : "assistant" as const, content: m.content }))
  // opening
  if (inbound) { say("CALLEE", persona.greeting); history.push({ role: "user", content: persona.greeting }) }
  else { say("CALLEE", persona.greeting); history.push({ role: "user", content: persona.greeting }) }
  const maxTurns = inbound ? 2 + 2 * (MAX_QUESTIONS[persona.inbound?.urgency ?? "ROUTINE"] + 2) : 2 + 2 * (brief.ask.length + 2)
  let done = false
  const minTurnsBeforeClose = inbound ? 3 : Math.max(3, brief.ask.length - 1)
  say("CALLER", brief.opening); history.push({ role: "assistant", content: brief.opening })
  const calleeModel = process.env.CALLEE_MODEL ?? "deepseek/deepseek-v4.1-flash"     // the persona needs no depth; the fast model halves the wall time
  { const r0 = await complete(apiKey, calleeModel, [{ role: "system", content: calleeSys }, ...asCallee()], false, 0.7); cost += r0.cost; const reply0 = r0.text.split("\n")[0]!.trim(); if (reply0) { say("CALLEE", reply0); history.push({ role: "user", content: reply0 }) } }
  for (let i = 0; i < maxTurns && !done; i++) {
    const guard = i < minTurnsBeforeClose ? "\n(You have not asked everything yet: do not close the call on this turn; ask your next question.)" : ""
    const c = await complete(apiKey, model, [{ role: "system", content: callerSys + guard }, ...history], false, 0.5); cost += c.cost
    const line = c.text.replace(/^Mira:\s*/i, "").split("\n")[0]!.trim(); if (!line) break
    say("CALLER", line); history.push({ role: "assistant", content: line })
    const closing = line.toLowerCase().includes(brief.closing.slice(0, 24).toLowerCase()) || /operator (has|will)|we will (call|message) you/i.test(line)
    if (closing && i >= minTurnsBeforeClose) { done = true; break }
    const r = await complete(apiKey, calleeModel, [{ role: "system", content: calleeSys }, ...asCallee()], false, 0.7); cost += r.cost
    const reply = r.text.split("\n")[0]!.trim(); if (!reply) break
    say("CALLEE", reply); history.push({ role: "user", content: reply })
  }
  if (!done) { say("CALLER", brief.closing) }
  const ex = await extractTurns(apiKey, model, brief, turns, inbound, persona.role === "DRIVER" ? "Driver" : "Desk", startedAt); cost += ex.cost
  const extracted = ex.extracted
  const slots = ex.slots
  const missing = (inbound ? (extracted?.triage ? CHECKLISTS[extracted.triage.situation] : []) : brief.ask).filter((k) => !slots.some((x) => x.value.slot === k))
  const outcome: CallRecord["outcome"] = inbound ? (extracted?.escalate ? "ESCALATED" : "COMPLETED") : missing.length ? "PARTIAL" : "COMPLETED"
  const toolCalls: CallRecord["toolCalls"] = extracted?.escalate && inbound ? [{ turnSeq: Math.max(0, seq - 2), name: "ESCALATE_TO_OPERATOR", argument: `${extracted.triage?.urgency ?? ""} ${extracted.triage?.situation ?? ""}: ${slots.map((s) => `${s.value.slot}=${JSON.stringify(s.value.value)}`).join(", ")}` }] : []
  const record = CallRecord.parse({
    id: `call-llm-${persona.id}-${Date.parse(startedAt).toString(36)}`, orderId: brief.orderId, brief, direction: inbound ? "INBOUND" : "OUTBOUND", attempt: 1,
    startedAt, endedAt: new Date(clock).toISOString(), outcome, engine: "SIMULATED_LLM", triage: extracted?.triage ?? null, toolCalls, turns, slots, toneReview: null,
    retryAfter: outcome === "PARTIAL" ? new Date(clock + 2 * 3600e3).toISOString() : null,
  })
  return { record, costUsd: cost, briefBy: composed.by }
}

async function extractTurns(apiKey: string, model: string, brief: CallBrief, turns: CallRecord["turns"], inbound: boolean, calleeLabel: string, startedAt: string): Promise<{ extracted: z.infer<typeof Extraction> | null; slots: CallRecord["slots"]; cost: number }> {
  let cost = 0
  const transcript = turns.map((t) => `${t.seq} ${t.speaker === "CALLER" ? "Mira" : calleeLabel}: ${t.text}`).join("\n")
  const want = inbound ? Array.from(new Set([...Object.values(CHECKLISTS).flat()])) : brief.ask
  const exSys = `You extract facts from a phone transcript into JSON. Extract a slot when the callee (${calleeLabel}) states it directly, including clear negatives and plain paraphrases: "reception doesn't have the keys" is KEYS_AT_SITE=false; "stock control will hand it over" is RELEASE_CONTACT_NAME="stock control"; "we open at eight thirty" with a slot at nine is OPEN_DURING_SLOT=true. Uncertainty is not a value: "I can't see it from here" is NOT VEHICLE_PRESENT=false. Never fill a slot the callee did not address. Each slot cites the turn number and quotes the exact words. Boolean slots are true/false; ETA is an ISO 8601 UTC instant (assume the call date ${startedAt.slice(0, 10)} if only a time is said); WARNING_LIGHT is one of NONE, AMBER_STEADY, AMBER_FLASHING, RED; text slots are short. Slots allowed: ${want.join(", ")}. ${inbound ? "This is an inbound driver call: also classify triage {urgency: EMERGENCY|URGENT|ROUTINE, situation: WARNING_LIGHT|BREAKDOWN|ACCIDENT|DELAY|KEYS_ACCESS|EXPENSE|OTHER_QUESTION, turnSeq, quote} from the driver's first substantive turn, and set escalate true if a person must act." : "triage is null; escalate true only if the callee reported something that blocks the collection."} Answer JSON: {"triage": ..., "slots": [{"slot","value","turnSeq","quote"}], "escalate": boolean}`
  let extracted: z.infer<typeof Extraction> | null = null, feedback = ""
  for (let attempt = 0; attempt < 2 && !extracted; attempt++) {
    const e = await complete(apiKey, model, [{ role: "system", content: exSys }, { role: "user", content: transcript + (feedback ? `\n\nPrevious answer rejected: ${feedback}` : "") }], true, 0); cost += e.cost
    try { const parsed = Extraction.safeParse(JSON.parse(e.text.replace(/^```(?:json)?\s*|```\s*$/g, ""))); if (parsed.success) extracted = parsed.data; else feedback = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") } catch (err) { feedback = "not valid JSON" }
  }
  const slots: CallRecord["slots"] = []
  for (const s of extracted?.slots ?? []) {
    const v = SlotValue.safeParse({ slot: s.slot, value: s.value }); if (!v.success) continue
    if (!turns[s.turnSeq] || turns[s.turnSeq]!.speaker !== "CALLEE") continue
    if (slots.some((x) => x.value.slot === s.slot)) continue
    slots.push({ value: v.data, turnSeq: s.turnSeq, quote: s.quote.slice(0, 300) })
  }
  return { extracted, slots, cost }
}

/** A live phone-line call (VoiceChat): turns from the phone's transcript of record -> typed claims, same CallRecord shape. */
export async function ingestTranscript(d: Dossier, purpose: CallBrief["purpose"], rawTurns: { speaker: string; text: string; startedAt?: string; endedAt?: string }[], opts: { startedAt?: string | undefined; endedAt?: string | undefined; engine?: string | undefined; lineCallId?: string | undefined; model?: string; apiKey?: string } = {}): Promise<{ record: CallRecord; costUsd: number }> {
  const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY; if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set")
  const model = opts.model ?? process.env.REASON_MODEL ?? "deepseek/deepseek-v4-pro"
  const composed = await composeBrief(d, purpose, { model, apiKey }); let cost = composed.costUsd ?? 0
  const brief = composed.brief
  const inbound = purpose === "DRIVER_INBOUND"
  const startedAt = opts.startedAt ?? rawTurns[0]?.startedAt ?? new Date().toISOString()
  let clock = Date.parse(startedAt)
  const turns: CallRecord["turns"] = rawTurns.filter((t) => t.text && t.text.trim()).map((t, i) => {
    const speaker: "CALLER" | "CALLEE" = /^(caller|model|agent|mira)$/i.test(t.speaker) ? "CALLER" : "CALLEE"
    const s = t.startedAt ? Date.parse(t.startedAt) : clock; const e = t.endedAt ? Date.parse(t.endedAt) : s + 1200 + t.text.length * 55; clock = e + 400
    return { seq: i, speaker, startedAt: new Date(s).toISOString(), endedAt: new Date(e).toISOString(), text: t.text.trim(), audioKey: null }
  })
  if (!turns.length) throw new Error("no spoken turns")
  const ex = await extractTurns(apiKey, model, brief, turns, inbound, brief.callee.kind === "DRIVER" ? "Driver" : "Desk", startedAt); cost += ex.cost
  const missing = (inbound ? (ex.extracted?.triage ? CHECKLISTS[ex.extracted.triage.situation] : []) : brief.ask).filter((k) => !ex.slots.some((x) => x.value.slot === k))
  const outcome: CallRecord["outcome"] = inbound ? (ex.extracted?.escalate ? "ESCALATED" : "COMPLETED") : missing.length ? "PARTIAL" : "COMPLETED"
  const engine = (["VOICECHAT_11B", "PERSONAPLEX", "CHAINED_STT_LLM_TTS"].includes(opts.engine ?? "") ? opts.engine : "VOICECHAT_11B") as CallRecord["engine"]
  const record = CallRecord.parse({
    id: `call-line-${(opts.lineCallId ?? Date.parse(startedAt).toString(36)).replace(/[^a-z0-9-]/gi, "")}`, orderId: brief.orderId, brief, direction: inbound ? "INBOUND" : "OUTBOUND", attempt: 1,
    startedAt, endedAt: opts.endedAt ?? new Date(clock).toISOString(), outcome, engine, triage: ex.extracted?.triage ?? null,
    toolCalls: ex.extracted?.escalate && inbound ? [{ turnSeq: Math.max(0, turns.length - 1), name: "ESCALATE_TO_OPERATOR", argument: `${ex.extracted.triage?.urgency ?? ""} ${ex.extracted.triage?.situation ?? ""}` }] : [],
    turns, slots: ex.slots, toneReview: null, retryAfter: outcome === "PARTIAL" ? new Date(clock + 2 * 3600e3).toISOString() : null,
  })
  return { record, costUsd: cost }
}
