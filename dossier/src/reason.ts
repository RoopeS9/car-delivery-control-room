// The reasoning step over a dossier: one model call with the whole dossier as static context, a closed set of typed
// outputs. No tools: everything the model may know is in the rendered dossier. Output is validated with zod; a
// malformed answer is a failure, never a loose note.
import { z } from "zod"
import type { Dossier, DossierItem } from "./dossier"
import { CallBrief, CallPurpose, Urgency } from "./live"
import { briefFor, items } from "./brief"
import { IsoDateTime, Text } from "./primitives"
import { derive, renderDerived, type DerivedItem } from "./derived"

// ------------------------------------------------------------------ typed outputs

export const Severity = z.enum(["INFO", "WATCH", "NEEDS_PERSON", "URGENT"])

export const ReasonOutput = z.object({
  /** One sentence of state in plain words, as the operator should read it. */
  headline: Text.max(240),
  /** The one thing a person must do now, or null. Only for what the agent may never do itself. */
  needsPerson: z.object({ what: Text.max(300), why: Text.max(400), options: z.array(Text.max(160)).min(1).max(4), basis: z.array(Text).max(6) }).strict().nullable(),
  /** Up to three derived items: deadlines at risk, conflicts between facts, silent gaps. */
  watching: z.array(z.object({ kind: z.enum(["DEADLINE", "CONFLICT", "GAP", "RISK"]), line: Text.max(260), severity: Severity, basis: z.array(Text).max(6) }).strict()).max(3),
  /** Calls the agent should place now (drivers and non-customer sites only). The brief builder turns these into cards. */
  calls: z.array(z.object({ purpose: CallPurpose, who: Text.max(120), reason: Text.max(300), urgency: Urgency }).strict()).max(2),
  /** Internal working note, free prose, never shown to the operator by default. */
  note: Text.max(1200).nullable(),
  /** What the model says it is not sure about. */
  unknowns: z.array(Text.max(160)).max(5),
}).strict()
export type ReasonOutput = z.infer<typeof ReasonOutput>

export const ReasonRun = z.object({
  orderRef: Text, model: Text, at: IsoDateTime, asOf: IsoDateTime, inputTokens: z.number().int(), outputTokens: z.number().int(), costUsd: z.number().nullable(),
  output: ReasonOutput, raw: Text,
}).strict()
export type ReasonRun = z.infer<typeof ReasonRun>

// ------------------------------------------------------------------ rendering the dossier as static context

const SKIP: Record<string, string[]> = { // noisy fields that carry no decision value in the rendering
  operational_events: ["id", "order_id"], messages: ["id", "order_id", "conversation_id"], tracking_observations: ["id", "order_id", "assignment_id", "segment_id"],
}
function line(item: DossierItem): string {
  const r = item.record as Record<string, unknown>
  const skip = new Set(["id", "order_id", ...(SKIP[item.collection] ?? [])])
  const fields = Object.entries(r).filter(([k, v]) => !skip.has(k) && v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join("; ")
  return `- [${item.collection} ${item.id} · ${item.strength}${item.membership !== "DIRECT" ? " · " + item.membership : ""}${item.at ? " · " + item.at : ""}] ${fields}`.slice(0, 700)
}

export function renderDossier(d: Dossier, opts: { maxHistory?: number } = {}): string {
  const out: string[] = [
    `# Dossier for order ${d.order.reference}, as of ${d.asOf}. Phase: ${d.phase.phase} (${d.phase.basis}).`,
    "Every item carries its evidence strength. Ladder: REFERENCE (profile), REQUEST, PLAN, QUOTE (not a booking), BOOKING (not proof of movement), COMMITMENT (customer agreed), CLAIM (someone said), OBSERVATION (device/system saw), VERIFIED, REJECTED, DECISION, SIGNAL (look, not a diagnosis), PROPOSAL (not a change), RECORD.",
    "",
  ]
  for (const [cls, items] of Object.entries(d.classes) as [string, DossierItem[]][]) {
    if (!items.length) continue
    const shown = cls === "HISTORY" ? items.slice(0, opts.maxHistory ?? 25) : items
    out.push(`## ${cls} (${items.length})`, ...shown.map(line))
    if (shown.length < items.length) out.push(`- (${items.length - shown.length} older history items omitted)`)
    out.push("")
  }
  if (d.live.calls.length) {
    out.push(`## CALLS (${d.live.calls.length})`)
    for (const c of d.live.calls) out.push(`- [call ${c.id} · ${c.direction} · ${c.outcome} · ${c.startedAt}] purpose=${c.brief.purpose}; callee=${c.brief.callee.name}; slots=${c.slots.map((s) => `${s.value.slot}=${JSON.stringify(s.value.value)}`).join(", ") || "none"}${c.triage ? `; triage=${c.triage.urgency}/${c.triage.situation}` : ""}`)
    out.push("")
  }
  if (d.live.telemetry.length) {
    out.push(`## TELEMETRY (${d.live.telemetry.length} samples, simulated; the latest six)`)
    for (const t of d.live.telemetry.slice(-6)) out.push(`- ${JSON.stringify(t)}`)
    out.push("")
  }
  if (d.live.phone) out.push(`## PHONE\n- the driver's app is ${d.live.phone.state}${d.live.phone.quietFrom ? ` since ${d.live.phone.quietFrom}` : ""}${d.live.phone.note ? `: ${d.live.phone.note}` : ""}`, "")
  if (d.live.events.length) {
    out.push(`## APP TIMELINE (${d.live.events.length}; messages and decisions recorded in the control room since the snapshot)`)
    for (const e of d.live.events.slice(-30)) out.push(`- [${e.eventKind} · ${e.channel} · ${e.actor}${e.actorId ? ` ${e.actorId}` : ""} · ${e.at}] ${e.text.slice(0, 300)}`)
    out.push("")
  }
  if (d.live.cases.length) {
    out.push(`## OPEN CASES IN THE CONTROL ROOM (${d.live.cases.length})`)
    for (const c of d.live.cases) out.push(`- [${c.status} · ${c.urgency} · ${c.caseKind}] ${c.title}: ${c.summary}${c.waitingFor ? ` (waiting for ${c.waitingFor})` : ""}`)
    out.push("")
  }
  return out.join("\n")
}

// ------------------------------------------------------------------ the call

export const RULES = `You are the reasoning step of Bahn's Road Desk, a car-delivery operations desk. You read one order's complete dossier and decide what, if anything, should happen. You have no tools: everything you may know is in the dossier.
Rules you must follow:
1. Weigh evidence by its strength label. A QUOTE is not a booking; a BOOKING is not proof the car moved; a CLAIM is what someone said; an OBS ERVATION is coarse; only VERIFIED is checked. A SYSTEM or OPS delivery window is not customer agreement; only a COMMITMENT is.
2. The agent may call drivers and sites that are not the paying customer. It may never contact the customer; anyone who pays is a customer, including a delivery site owned by the customer. Promise changes, money, recovery of a broken car and any customer message need a person.
3. needsPerson is for exactly those things. Routine work is not a needsPerson. If nothing needs a person, needsPerson is null.
4. watching holds at most three derived items, each citing the dossier item ids it rests on (basis). A deadline is at risk when a cutoff, slot or promise is within reach of the latest ETA or there is no position for over an hour on a moving car.
5. calls: propose at most two calls the agent should place now, and only to a party named in the "Callable parties" list below, written as it is named there. Never the receiver, a delivery contact, a handoff contact or the customer: those are a person's to contact, and belong in needsPerson instead. The DERIVED section lists the checks the rules say are due; a DUE_CHECK in state DUE or OVERDUE belongs in calls unless the dossier shows it is pointless, and a check in state DONE, RETRY or BLOCKED is never proposed again.
6. headline is one plain sentence an operator reads first. No ids in headline, watching lines or needsPerson text except the order reference.
7. Answer with JSON only, matching the schema exactly. No markdown.`.replace("OBS ERVATION", "OBSERVATION")

export const OUTPUT_SCHEMA_TEXT = `{"headline": string, "needsPerson": {"what": string, "why": string, "options": string[1..4], "basis": string[]} | null, "watching": [{"kind": "DEADLINE"|"CONFLICT"|"GAP"|"RISK", "line": string, "severity": "INFO"|"WATCH"|"NEEDS_PERSON"|"URGENT", "basis": string[]}] (max 3), "calls": [{"purpose": ${CallPurpose.options.map((p) => `"${p}"`).join("|")}, "who": string, "reason": string, "urgency": "EMERGENCY"|"URGENT"|"ROUTINE"}] (max 2), "note": string | null, "unknowns": string[] (max 5)}`

/** Who the agent may call on this order, derived from the dossier: the booked driver, and a pickup desk that is not the customer. */
export function callableParties(d: Dossier): string[] {
  const out: string[] = []
  const order = items(d, "orders")[0]?.record
  const a = items(d, "work_assignments").map((i) => i.record).find((x) => x.status === "IN_PROGRESS" || x.status === "ASSIGNED")
  const drv = a ? items(d, "drivers").map((i) => i.record).find((x) => x.id === a.driver_id) : undefined
  if (drv) out.push(`driver ${drv.display_name} (purposes: DRIVER_START_CHECK before pickup, POSITION_CHECK while moving, FERRY_CHECKIN near the ferry)`)
  const site = order ? items(d, "sites").map((i) => i.record).find((x) => x.id === order.pickup_site_id) : undefined
  if (site && order && site.customer_id !== order.customer_id) out.push(`pickup desk ${site.name} (purpose: PICKUP_READINESS)`)
  else if (site) out.push(`pickup desk ${site.name} belongs to the paying customer: NOT callable`)
  out.push("the receiver and the customer: NOT callable by the agent (a person does that)")
  return out
}

const FORBIDDEN_OPTION = /\b(keep driving|continue driving|drive on|attempt to continue|carry on driving|cleared? to drive)\b/i

export async function chat(apiKey: string, model: string, system: string, user: string, feedback?: string, extra: Record<string, unknown> = {}): Promise<{ raw: string; usage: { prompt_tokens: number; completion_tokens: number; cost?: number } | undefined }> {
  const messages: { role: string; content: string }[] = [{ role: "system", content: system }, { role: "user", content: user }]
  if (feedback) messages.push({ role: "user", content: `Your previous answer was rejected: ${feedback}\nAnswer again with JSON only, matching the schema exactly.` })
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "x-title": "road-dossier reason" },
    body: JSON.stringify({ model, temperature: 0.2, response_format: { type: "json_object" }, usage: { include: true }, messages, ...extra }),
  })
  if (!res.ok) throw new Error(`openrouter ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const body = (await res.json()) as { choices: { message: { content: string } }[]; usage?: { prompt_tokens: number; completion_tokens: number; cost?: number } }
  return { raw: body.choices[0]?.message.content ?? "", usage: body.usage }
}
const stripFence = (raw: string) => raw.replace(/^```(?:json)?\s*|```\s*$/g, "").trim()

export async function reason(d: Dossier, opts: { model?: string; apiKey?: string; derived?: DerivedItem[] } = {}): Promise<ReasonRun> {
  const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set")
  const model = opts.model ?? process.env.REASON_MODEL ?? "deepseek/deepseek-v4-pro"
  const derived = opts.derived ?? derive(d)
  const rendered = renderDossier(d) + "\n" + renderDerived(derived) + "\n## Callable parties on this order\n" + callableParties(d).map((l) => `- ${l}`).join("\n")
  const system = RULES + "\n\nOutput schema:\n" + OUTPUT_SCHEMA_TEXT
  let feedback: string | undefined, raw = "", usage: { prompt_tokens: number; completion_tokens: number; cost?: number } | undefined, parsedOut: ReasonOutput | undefined
  let cost = 0, inTok = 0, outTok = 0
  for (let attempt = 0; attempt < 2 && !parsedOut; attempt++) {
    const r = await chat(apiKey, model, system, rendered, feedback); raw = r.raw; usage = r.usage
    cost += usage?.cost ?? 0; inTok += usage?.prompt_tokens ?? 0; outTok += usage?.completion_tokens ?? 0
    let json: unknown
    try { json = JSON.parse(stripFence(raw)) } catch (e) { feedback = `not valid JSON (${(e as Error).message})`; continue }
    const parsed = ReasonOutput.safeParse(json)
    if (!parsed.success) { feedback = parsed.error.issues.slice(0, 4).map((i) => `${i.path.join(".")}: ${i.message}`).join("; "); continue }
    const bad = parsed.data.needsPerson?.options.find((o) => FORBIDDEN_OPTION.test(o))
    if (bad) { feedback = `option "${bad}" clears the driver to drive on, which no one but an operator may decide and which is never an option to offer; remove it`; continue }
    parsedOut = parsed.data
  }
  if (!parsedOut) throw new Error(`model output failed after retry: ${feedback}\n${raw.slice(0, 500)}`)
  const body = { usage: { prompt_tokens: inTok, completion_tokens: outTok, cost } }
  const parsed = { data: parsedOut }
  return ReasonRun.parse({ orderRef: d.order.reference, model, at: new Date().toISOString(), asOf: d.asOf, inputTokens: body.usage.prompt_tokens, outputTokens: body.usage.completion_tokens, costUsd: body.usage.cost, output: parsed.data, raw })
}

// ------------------------------------------------------------------ model-composed call briefs

const BRIEF_RULES = `You write the brief for an outbound robo-call placed by Bahn's Road Desk voice agent (a small speech model that recalls facts well and reasons badly). You get the order dossier, the purpose, the callee, and a rule-built draft brief whose facts are the only facts you may use. Improve the draft: phrase mayState for speech (short, concrete, numbers and references spelled out exactly as in the draft, conclusions precomputed), choose the ask order (safety first, then what the operator needs), write a warm two-sentence opening and a closing that says what happens next. Never add facts that are not in the draft or the dossier. Never promise dates or costs. Never mention other orders or any customer detail. Answer with JSON only: {"opening": string, "mayState": string[1..12], "ask": string[1..6] (subset of the draft's ask, reordered), "closing": string, "maxDurationS": 30..180}`

export async function composeBrief(d: Dossier, purpose: CallPurpose, opts: { model?: string; apiKey?: string } = {}): Promise<{ brief: CallBrief; by: "MODEL" | "RULE"; costUsd: number | null; error?: string | undefined }> {
  const draft = briefFor(d, purpose)
  const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY
  if (!apiKey) return { brief: draft, by: "RULE", costUsd: null, error: "no api key" }
  const model = opts.model ?? process.env.REASON_MODEL ?? "deepseek/deepseek-v4-pro"
  const user = `Purpose: ${purpose}\nCallee: ${JSON.stringify(draft.callee)}\n\nDraft brief (facts allowed):\n${JSON.stringify({ opening: draft.opening, mayState: draft.mayState, ask: draft.ask, mustNot: draft.mustNot, closing: draft.closing }, null, 1)}\n\n${renderDossier(d, { maxHistory: 10 })}`
  const Part = z.object({ opening: Text.max(300), mayState: z.array(Text.max(300)).min(1).max(12), ask: z.array(z.string()).min(1).max(6), closing: Text.max(300), maxDurationS: z.number().int().min(30).max(180) }).strict()
  let feedback: string | undefined, cost = 0
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await chat(apiKey, model, BRIEF_RULES, user, feedback); cost += r.usage?.cost ?? 0
    let json: unknown; try { json = JSON.parse(stripFence(r.raw)) } catch (e) { feedback = `not valid JSON`; continue }
    const part = Part.safeParse(json)
    if (!part.success) { feedback = part.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; "); continue }
    const ask = part.data.ask.filter((a): a is CallBrief["ask"][number] => (draft.ask as string[]).includes(a))
    if (!ask.length) { feedback = "ask must be a subset of the draft's ask"; continue }
    const candidate = CallBrief.safeParse({ ...draft, id: draft.id + "-m", createdBy: "REASONING_MODEL", opening: part.data.opening, mayState: part.data.mayState, ask, closing: part.data.closing, maxDurationS: part.data.maxDurationS })
    if (!candidate.success) { feedback = candidate.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; "); continue }
    return { brief: candidate.data, by: "MODEL", costUsd: cost }
  }
  return { brief: draft, by: "RULE", costUsd: cost, error: feedback }
}
