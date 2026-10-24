// Suggested replies for the operator's helpdesk: one model call over the order dossier and the conversation so far,
// answering with a few candidate messages the operator may send as they are, each with a stance, the dossier items it
// rests on and a caution where the facts are thin. The operator chooses, edits and sends; nothing here is sent by itself.
import { z } from "zod"
import type { Dossier } from "./dossier"
import { derive, renderDerived } from "./derived"
import { chat, renderDossier } from "./reason"

/** The conversation as the app holds it, flattened for the prompt. */
export const SuggestThread = z.object({
  category: z.string(), channel: z.string(),
  counterparty: z.object({ kind: z.string(), name: z.string() }).nullable(),
  messages: z.array(z.object({ who: z.string(), kind: z.string(), at: z.string(), body: z.string(), internal: z.boolean().optional() })).max(60),
  /** What the operator wants to say, in their words, when they have started typing or picked an intent. */
  intent: z.string().max(600).optional(),
  /** Orders that may be the one this thread is about, when none is linked yet (the inbox). */
  candidates: z.array(z.object({ reference: z.string(), line: z.string() })).max(6).optional(),
}).strict()
export type SuggestThread = z.infer<typeof SuggestThread>

export const Suggestion = z.object({
  stance: z.enum(["ANSWER", "ASK", "HOLD", "ESCALATE", "IDENTIFY"]),
  label: z.string().min(1).max(60),
  body: z.string().min(1).max(1600),
  /** Dossier item ids (or "thread") the reply rests on. */
  basis: z.array(z.string()).max(8),
  caution: z.string().max(240).nullable(),
}).strict()
export type Suggestion = z.infer<typeof Suggestion>

export const SuggestResult = z.object({
  language: z.string(), summary: z.string(), suggestions: z.array(Suggestion).min(1).max(3), internalNote: z.string().nullable(),
  model: z.string(), costUsd: z.number().nullable(), at: z.string(),
}).strict()
export type SuggestResult = z.infer<typeof SuggestResult>

const Output = SuggestResult.omit({ model: true, costUsd: true, at: true })

const RULES = `You draft replies for a human operator at Bahn Road Desk, the support desk of a car-delivery company. You get one conversation (a customer, a driver, a pickup or delivery site, or a handoff contact writing to the desk) and, when the conversation belongs to a known order, that order's complete dossier with every record's evidence strength. The operator reads your drafts, picks one, edits it and sends it. Nothing you write is sent by itself.

Write up to three candidate replies, each with a different stance, in this order when they make sense:
- ANSWER: resolves the matter with facts the dossier supports.
- ASK: acknowledges, asks precisely for the one thing missing, says what happens once it arrives.
- HOLD or ESCALATE: when a person must decide first (a new date, money, a refund, a condition claim, releasing a car against a hold, anything about another party's personal details): say what the desk is doing and when they will hear back, without committing.
- IDENTIFY: only when no order is linked: ask for the reference, registration or VIN, or name the likely order and ask them to confirm it. If candidate orders are given, use them.
Skip a stance that would be empty or dishonest. Never write two replies that say the same thing.

Rules:
1. Reply in the language the counterparty wrote in (the latest message of theirs decides). Address them as who they are.
2. State only facts the dossier supports and cite their item ids in basis. Weigh strength: a QUOTE is not a booking; a BOOKING is not proof the car moved; a CLAIM is what someone said; a PLAN is not a promise; only a COMMITMENT is agreed with the customer. Say "planned" or "booked" when that is what the record is.
3. Never promise a new date, slot or price. Never confirm a delivery time beyond the recorded promise window. An operator may change these; the draft may say the desk will confirm.
4. Never give a driver or a site any customer detail (name, phone, address, price). Never give a customer the driver's phone or personal details; the driver's first name is fine. Never discuss other orders.
5. Never tell a driver a car is safe to drive on or that a warning light does not matter; an operator decides that.
6. Match the channel: chat and WhatsApp replies are one to three short sentences; an email has a one-line greeting, two to five sentences, and ends with "Bahn Road Desk". No markdown, no emoji, no placeholders in brackets: if a fact is missing, do not invent it, ask for it or leave it out.
7. caution says in one sentence what the operator must check before sending this draft, or is null when nothing is thin.
8. summary is one line for the operator: what they want, and what the dossier says about it. internalNote is one line the operator may file as an internal note on the thread, or null.
9. Answer with JSON only, matching the schema exactly. No markdown.`

const SCHEMA = `{"language": string (BCP-47, e.g. "de"), "summary": string, "suggestions": [{"stance": "ANSWER"|"ASK"|"HOLD"|"ESCALATE"|"IDENTIFY", "label": string (<= 6 words, names the stance for the operator), "body": string, "basis": string[] (dossier item ids, or "thread"), "caution": string|null}] (1..3), "internalNote": string|null}`

export function renderThread(t: SuggestThread): string {
  const who = t.counterparty ? `${t.counterparty.name} (${t.counterparty.kind})` : "an unknown sender"
  const out = [`## The conversation (${t.category}, over ${t.channel}) with ${who}`]
  for (const m of t.messages) out.push(`- [${m.at} · ${m.who} · ${m.kind}${m.internal ? " · INTERNAL NOTE, not seen by them" : ""}] ${m.body.replace(/\s+/g, " ").slice(0, 1200)}`)
  if (!t.messages.length) out.push("- (no messages yet: the operator is opening this conversation)")
  if (t.intent) out.push("", `## What the operator wants to say`, t.intent)
  if (t.candidates?.length) out.push("", `## Orders this may be about (not linked; hypotheses)`, ...t.candidates.map((c) => `- ${c.reference}: ${c.line}`))
  return out.join("\n")
}

/**
 * Drafts replies. `d` is the linked order's dossier, or null for an inbox thread with no link yet. One model call,
 * one retry on a malformed answer; a few tenths of a cent.
 */
export async function suggestReplies(d: Dossier | null, thread: SuggestThread, opts: { model?: string; apiKey?: string } = {}): Promise<SuggestResult> {
  const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set")
  // Drafting is a chat reply over a rendered dossier, not a judgement call: the flash model answers in seconds where the
  // pro model takes minutes, and the operator reads and edits every word anyway. SUGGEST_MODEL overrides.
  const model = opts.model ?? process.env.SUGGEST_MODEL ?? "deepseek/deepseek-v4-flash"
  const user = [
    renderThread(thread), "",
    d ? renderDossier(d, { maxHistory: 15 }) + "\n" + renderDerived(derive(d)) : "## No order is linked to this conversation\nThere is no dossier. Identify the order or answer general policy; state no order facts.",
  ].join("\n")
  const system = RULES + "\n\nOutput schema:\n" + SCHEMA
  let feedback: string | undefined, cost = 0, parsed: z.infer<typeof Output> | undefined, raw = ""
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    const r = await chat(apiKey, model, system, user, feedback)
    raw = r.raw; cost += r.usage?.cost ?? 0
    let json: unknown
    try { json = JSON.parse(raw.replace(/^```(?:json)?\s*|```\s*$/g, "").trim()) } catch { feedback = "not valid JSON"; continue }
    const p = Output.safeParse(json)
    if (p.success) parsed = p.data; else feedback = p.error.issues.slice(0, 4).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
  }
  if (!parsed) throw new Error(`model output failed after retry: ${feedback}\n${raw.slice(0, 400)}`)
  return SuggestResult.parse({ ...parsed, model, costUsd: cost || null, at: new Date().toISOString() })
}
