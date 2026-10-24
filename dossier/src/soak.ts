// The soak: many delivery runs, each read for signs that the loop commits garbage to the dossier or runs away.
// A run is the engine's own report (src/run.ts); the checks here are what a person would look for in it, written
// down once so a night of runs reads as one table. Nothing here calls a model; the checks are pure over the report
// and a rebuilt dossier.
import { z } from "zod"
import type { Dataset } from "./build"
import { buildDossier } from "./build"
import { emptyLive } from "./live"
import type { RunReport } from "./run"
import { Text } from "./primitives"

export const Finding = z.object({
  /** What kind of garbage or runaway this is. */
  kind: z.enum([
    "PHANTOM_CITATION",    // the model cited a dossier item id that does not exist
    "ID_IN_PROSE",         // an id other than the order reference in text an operator reads
    "REPROPOSED_CLOSED",   // the model proposed a check the rules hold as DONE, RETRY or BLOCKED
    "UNCALLABLE_PARTY",    // the model proposed calling someone the agent may not call
    "FORBIDDEN_LINE",      // the caller said something the brief forbids
    "REPEAT_CALL",         // the same subject was called more often than the retry rule allows
    "CLAIM_FLOOD",         // one call produced more claims than the brief asked for
    "WOKEN_WITHOUT_CHANGE",// the model was woken although nothing in the derived layer changed
    "CONFLICT_ON_COOPERATIVE", // a cooperative counterpart's claims contradicted the records: the extraction invented something
    "NEEDS_PERSON_FOR_ROUTINE",// needsPerson set on a step with no deadline at risk, conflict, gap or failed call
    "UNPLACEABLE",         // a due check could not be placed (brief or persona failed)
    "RUN_FAILED",
  ]),
  step: z.number().int().nullable(), what: Text,
}).strict()
export type Finding = z.infer<typeof Finding>

export const RunVerdict = z.object({
  runId: Text, orderRef: Text, twist: Text, status: Text, steps: z.number().int(), woken: z.number().int(), calls: z.number().int(),
  completed: z.number().int(), partial: z.number().int(), claims: z.number().int(), conflictsOpened: z.number().int(),
  costUsd: z.number(), seconds: z.number(), findings: z.array(Finding),
}).strict()
export type RunVerdict = z.infer<typeof RunVerdict>

/** Every item id a dossier holds, in the two spellings the model sees: "id" and "collection:id". */
function knownIds(ds: Dataset, orderId: string, asOf: string, overlay: Parameters<typeof buildDossier>[4]): Set<string> {
  const d = buildDossier(ds, orderId, emptyLive(), asOf, overlay)
  const out = new Set<string>([d.order.reference, d.order.id])
  for (const list of Object.values(d.classes)) for (const item of list) { out.add(item.id); out.add(`${item.collection}:${item.id}`) }
  return out
}

// Record ids: a collection prefix with a hex tail ("res-x16b8…") or a number ("drv-055"), or an app id ("case-7367eeb07655"). Plain hyphenated words are not ids.
const ID_LIKE = /\b(?:[a-z]{2,10}-x[0-9a-f]{6,}|(?:drv|cus|site|asg|msg|conv|alert|doc|inc|res|tw|addr|veh|ord|ep|tel|evt|win|track)-\d{2,}|(?:case|prop|evt|tel|call)-[0-9a-f]{8,})\b/gi

/** Reads one finished report. Dossier ids are checked against a rebuild as of each step (no model, a few ms). */
export function judgeRun(ds: Dataset, r: RunReport): RunVerdict {
  const order = ds.rows.orders.find((o) => o.reference === r.orderRef)
  const findings: Finding[] = []
  const f = (kind: Finding["kind"], step: number | null, what: string) => findings.push({ kind, step, what: what.slice(0, 300) })
  if (r.status !== "done") f("RUN_FAILED", null, r.error ?? "not done")
  const calledSubjects = new Map<string, number>()
  let claims = 0, conflicts = 0
  for (const s of r.steps) {
    const changed = s.diff.opened.length + s.diff.changed.length + s.diff.closed.length > 0 || s.index === 0
    if (s.reasoned && !changed) f("WOKEN_WITHOUT_CHANGE", s.index, s.label)
    conflicts += s.diff.opened.filter((i) => i.kind === "CONFLICT").length
    if (r.twist === "cooperative") for (const c of s.diff.opened.filter((i) => i.kind === "CONFLICT")) f("CONFLICT_ON_COOPERATIVE", s.index, c.kind === "CONFLICT" ? `${c.line}: said "${c.said}", record "${c.record}"` : c.kind)
    for (const c of s.calls) {
      claims += c.slots
      calledSubjects.set(c.derivedId, (calledSubjects.get(c.derivedId) ?? 0) + 1)
      if (c.slots > 8) f("CLAIM_FLOOD", s.index, `${c.purpose} to ${c.callee.name}: ${c.slots} claims`)
    }
    if (s.reasoned && order) {
      const ids = knownIds(ds, order.id, s.asOf, {})
      // ids the run itself created (its own calls) are legitimate citations too
      for (const c of s.calls) { ids.add(c.callId); ids.add(`calls:${c.callId}`) }
      for (const prior of r.steps.slice(0, s.index)) for (const c of prior.calls) { ids.add(c.callId); ids.add(`calls:${c.callId}`) }
      const cited = [...(s.reasoned.needsPerson?.basis ?? []), ...s.reasoned.watching.flatMap((w) => w.basis)]
      for (const id of cited) {
        const bare = id.includes(":") ? id.slice(id.indexOf(":") + 1) : id
        // The live sections (PHONE, TELEMETRY, CALLS, APP TIMELINE, OPEN CASES) and the derived items are in the text the model read: citing them is not a phantom.
        if (!ids.has(id) && !ids.has(bare) && !/^(DUE_CHECK|DEADLINE|SILENT|CONFLICT|derived|phone|telemetry|calls?|call-|app|case|live)\b/i.test(id)) f("PHANTOM_CITATION", s.index, id)
      }
      const prose = [s.reasoned.headline, ...s.reasoned.watching.map((w) => w.line), s.reasoned.needsPerson?.what ?? "", s.reasoned.needsPerson?.why ?? "", ...(s.reasoned.needsPerson?.options ?? [])].join(" ")
      for (const m of prose.match(ID_LIKE) ?? []) if (m !== r.orderRef) f("ID_IN_PROSE", s.index, m)
      const closed = new Set(s.derived.filter((i) => i.kind === "DUE_CHECK" && i.state !== "DUE" && i.state !== "OVERDUE").map((i) => i.kind === "DUE_CHECK" ? i.purpose : ""))
      for (const p of s.reasoned.calls) if (closed.has(p.purpose) && !s.derived.some((i) => i.kind === "DUE_CHECK" && i.purpose === p.purpose && (i.state === "DUE" || i.state === "OVERDUE"))) f("REPROPOSED_CLOSED", s.index, `${p.purpose} to ${p.who}`)
      const routine = !s.derived.some((i) => i.kind !== "DUE_CHECK") && !s.calls.some((c) => c.outcome !== "COMPLETED") && !s.diff.opened.some((i) => i.kind === "CONFLICT")
      // A needsPerson that cites records is the model's judgement about something the rules have no rule for; only one with no basis at all is noise.
      if (s.reasoned.needsPerson && routine && r.twist === "cooperative" && s.phase !== "DELIVERED" && s.reasoned.needsPerson.basis.length === 0) f("NEEDS_PERSON_FOR_ROUTINE", s.index, s.reasoned.needsPerson.what)
    }
  }
  for (const [subject, n] of calledSubjects) if (n > 2) f("REPEAT_CALL", null, `${subject} called ${n} times`)
  for (const fail of r.failures) {
    if (/forbidden line/.test(fail.what)) f("FORBIDDEN_LINE", fail.step, fail.what)
    else if (/not a callable party/.test(fail.what)) f("UNCALLABLE_PARTY", fail.step, fail.what)
    else if (/could not be placed/.test(fail.what)) f("UNPLACEABLE", fail.step, fail.what)
    else if (/reasoning failed/.test(fail.what)) f("RUN_FAILED", fail.step, fail.what)
  }
  const seconds = r.finishedAt ? (Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000 : 0
  return RunVerdict.parse({
    runId: r.id, orderRef: r.orderRef, twist: r.twist, status: r.status, steps: r.steps.length, woken: r.summary.stepsWoken, calls: r.summary.callsPlaced,
    completed: r.summary.completed, partial: r.summary.partial, claims, conflictsOpened: conflicts, costUsd: r.costUsd, seconds: Math.round(seconds), findings,
  })
}

/** The night as one page: a table of runs, then every finding grouped by kind. */
export function renderSoak(verdicts: RunVerdict[], note = ""): string {
  const out: string[] = [`# Soak: ${verdicts.length} runs, $${verdicts.reduce((a, v) => a + v.costUsd, 0).toFixed(2)}${note ? ` · ${note}` : ""}`, ""]
  out.push("| run | order | twist | status | steps | woken | calls | ok | partial | claims | conflicts | findings | $ | s |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
  for (const v of verdicts) out.push(`| ${v.runId} | ${v.orderRef} | ${v.twist} | ${v.status} | ${v.steps} | ${v.woken} | ${v.calls} | ${v.completed} | ${v.partial} | ${v.claims} | ${v.conflictsOpened} | ${v.findings.length ? v.findings.map((x) => x.kind).join(", ") : "none"} | ${v.costUsd.toFixed(3)} | ${v.seconds} |`)
  const byKind = new Map<string, string[]>()
  for (const v of verdicts) for (const x of v.findings) byKind.set(x.kind, [...(byKind.get(x.kind) ?? []), `${v.orderRef} (${v.twist}${x.step != null ? `, step ${x.step}` : ""}): ${x.what}`])
  out.push("", `## Findings (${[...byKind.values()].reduce((a, l) => a + l.length, 0)})`)
  if (!byKind.size) out.push("", "None: no phantom citations, no ids in prose, no re-proposed closed checks, no forbidden lines, no repeat calls, nothing invented on cooperative runs.")
  for (const [kind, lines] of [...byKind.entries()].sort((a, b) => b[1].length - a[1].length)) out.push("", `### ${kind} (${lines.length})`, ...lines.map((l) => `- ${l}`))
  return out.join("\n")
}
