// A delivery run: one order walked through its phases, the dossier rebuilt at each step as of that time, the derived
// layer diffed, the reasoning step woken only on a change, and every due check placed as a model-played call whose
// claims flow back into the next step. The output is a typed report of what happened, what the rules said, what the
// model said, and where they disagreed. Nothing here touches the dataset: a run's "world" is an overlay (status) plus
// the live input (phone state, the run's own calls).
//
// Two modes:
//   TIMELINE  the run advances asOf itself through the order's key instants (slot - 48 h, the day before, pickup,
//             a silent stretch on the road, the ferry cutoff, delivery), overlaying the status the world would have.
//   LIVE      one tick as of the app's clock, with what the app has recorded: the production loop, run once.
import { z } from "zod"
import type { Dataset, Overlay } from "./build"
import { buildDossier } from "./build"
import { derive, diffDerived, DerivedDiff, DerivedItem } from "./derived"
import { CallPurpose, CallRecord, Callee, emptyLive, type Live } from "./live"
import { pullLive } from "./livepull"
import { items } from "./brief"
import { runLlmCall } from "./llm-call"
import { reason, ReasonOutput } from "./reason"
import { reviewCall } from "./review"
import { personaFor, Twist } from "./sim/persona-from-dossier"
import { IsoDateTime, Text } from "./primitives"

export const RunMode = z.enum(["TIMELINE", "LIVE"])
export type RunMode = z.infer<typeof RunMode>

const PlacedCall = z.object({
  derivedId: Text, purpose: CallPurpose, callee: Callee, callId: Text, attempt: z.number().int(),
  outcome: Text, slots: z.number().int(), verdict: z.enum(["PASS", "PARTIAL", "FAIL"]).nullable(), costUsd: z.number(),
  /** Whether the model also proposed this call on this step. BOTH means rules and model agreed. */
  proposedBy: z.enum(["RULES", "BOTH"]),
}).strict()

export const RunStep = z.object({
  index: z.number().int(), label: Text, asOf: IsoDateTime, phase: Text, basis: Text,
  derived: z.array(DerivedItem), diff: DerivedDiff,
  /** Null when the derived layer did not change: the model was not woken. */
  reasoned: ReasonOutput.nullable(), reasonCostUsd: z.number(),
  calls: z.array(PlacedCall),
  /** Calls the model proposed that the rules did not derive: noted, never placed. */
  modelOnlyCalls: z.array(z.object({ purpose: CallPurpose, who: Text, reason: Text }).strict()),
  notes: z.array(Text),
}).strict()
export type RunStep = z.infer<typeof RunStep>

export const RunReport = z.object({
  id: Text, orderRef: Text, mode: RunMode, twist: Twist, status: z.enum(["running", "done", "failed"]),
  startedAt: IsoDateTime, finishedAt: IsoDateTime.nullable(), plannedSteps: z.array(Text),
  steps: z.array(RunStep),
  failures: z.array(z.object({ step: z.number().int(), what: Text }).strict()),
  costUsd: z.number(),
  summary: z.object({ callsPlaced: z.number().int(), completed: z.number().int(), partial: z.number().int(), stepsWoken: z.number().int(), needsPersonSteps: z.number().int() }).strict(),
  error: Text.nullable(),
}).strict()
export type RunReport = z.infer<typeof RunReport>

const H = 3600e3, MIN = 60e3
type Instant = { label: string; at: number; overlay: Overlay; phone?: Live["phone"] | undefined }

/** The instants worth looking at for this order, from its records; the ones already in the past at the snapshot are kept when the order is still before them. */
export function planTimeline(ds: Dataset, orderId: string): Instant[] {
  const order = ds.rows.orders.find((o) => o.id === orderId)!
  const windows = ds.rows.time_windows.filter((w) => w.order_id === orderId && w.is_selected)
  const slot = windows.find((w) => w.purpose === "SELECTED_PICKUP_SLOT")
  const promise = windows.find((w) => w.purpose === "CUSTOMER_DELIVERY_PROMISE")
  const ferry = ds.rows.travel_reservations.find((r) => r.order_id === orderId && r.kind === "FERRY" && r.status === "BOOKED")
  const assignment = ds.rows.work_assignments.find((a) => a.order_id === orderId && (a.status === "IN_PROGRESS" || a.status === "ASSIGNED"))
  const snapshot = Date.parse(ds.snapshotAt)
  const out: Instant[] = []
  const beforePickup = order.status === "NEW" || order.status === "WAITING_FOR_PICKUP"
  if (beforePickup && slot) {
    const slotAt = Date.parse(slot.start_at)
    out.push({ label: "two days before the pickup slot", at: Math.max(snapshot, slotAt - 47 * H), overlay: {} })
    if (assignment) out.push({ label: "the day before the pickup", at: Math.max(snapshot + MIN, slotAt - 26 * H), overlay: { status: "WAITING_FOR_PICKUP", note: "driver booked" } })
    out.push({ label: "the car is collected (simulated)", at: slotAt + 30 * MIN, overlay: { status: "IN_TRANSIT", note: "the run assumes the collection happened at the slot" } })
  } else if (order.status === "IN_TRANSIT") {
    out.push({ label: "now, on the road", at: snapshot, overlay: {} })
  }
  const onRoadFrom = out.length ? out[out.length - 1]!.at : snapshot
  if (assignment && (beforePickup ? !!slot : order.status === "IN_TRANSIT")) {
    // a silent stretch: the phone goes quiet for 70 minutes somewhere on the road
    const quietAt = onRoadFrom + 90 * MIN
    out.push({ label: "the phone has been quiet for over an hour", at: quietAt, overlay: { status: "IN_TRANSIT", note: "on the road" }, phone: { kind: "PHONE", state: "QUIET", quietFrom: new Date(quietAt - 70 * MIN).toISOString(), note: "simulated: no position reports for 70 minutes" } })
    if (ferry?.check_in_cutoff_at) {
      const cutoff = Date.parse(ferry.check_in_cutoff_at)
      if (cutoff - 5 * H > onRoadFrom) out.push({ label: "five hours before the ferry check-in closes", at: cutoff - 5 * H, overlay: { status: "IN_TRANSIT", note: "on the road, before the ferry" }, phone: { kind: "PHONE", state: "LIVE", quietFrom: null, note: null } })
      else out.push({ label: "before the ferry check-in closes", at: Math.max(onRoadFrom + 2 * H, cutoff - 90 * MIN), overlay: { status: "IN_TRANSIT", note: "on the road, before the ferry" }, phone: { kind: "PHONE", state: "LIVE", quietFrom: null, note: "simulated: the app receives position reports normally; the run lists no fixes" } })
    }
    if (promise) {
      const promiseAt = Date.parse(promise.start_at)
      out.push({ label: "the delivery is due", at: Math.max(onRoadFrom + 3 * H, promiseAt - 2 * H), overlay: { status: "IN_TRANSIT", note: "approaching delivery" }, phone: { kind: "PHONE", state: "LIVE", quietFrom: null, note: "simulated: the app receives position reports normally; the run lists no fixes" } })
      out.push({ label: "delivered", at: Math.max(onRoadFrom + 4 * H, promiseAt + H), overlay: { status: "DELIVERED", note: "handed over inside the promise" }, phone: null })
    }
  }
  // in time order; two instants within an hour of each other are one step (the later one's world, both labels)
  out.sort((a, b) => a.at - b.at)
  const merged: Instant[] = []
  for (const i of out) {
    const last = merged[merged.length - 1]
    if (last && i.at - last.at < H) merged[merged.length - 1] = { ...i, at: Math.max(last.at, i.at), label: `${last.label}; ${i.label}`, phone: i.phone ?? last.phone, overlay: { ...last.overlay, ...i.overlay } }
    else merged.push(i)
  }
  return merged
}

export type RunOptions = { mode?: RunMode; twist?: Twist; model?: string | undefined; apiKey?: string | undefined; onStep?: (report: RunReport) => void; store?: (call: CallRecord) => void; maxAttempts?: number }
const modelOpts = (o: RunOptions) => ({ ...(o.model ? { model: o.model } : {}), ...(o.apiKey ? { apiKey: o.apiKey } : {}) })

/** Runs the whole delivery. The report is mutated as steps complete, so a holder of the object can show progress. */
export async function runDelivery(ds: Dataset, orderId: string, report: RunReport, opts: RunOptions = {}): Promise<RunReport> {
  const order = ds.rows.orders.find((o) => o.id === orderId)!
  const twist = opts.twist ?? "cooperative"
  const maxAttempts = opts.maxAttempts ?? 2
  const instants: Instant[] = report.mode === "LIVE" ? [{ label: "now, as the control room sees it", at: Date.now(), overlay: {} }] : planTimeline(ds, orderId)
  report.plannedSteps = instants.map((i) => `${i.label} (${new Date(i.at).toISOString()})`)
  const runCalls: CallRecord[] = []
  const attempts = new Map<string, number>()
  let previous: DerivedItem[] = []
  try {
    for (const [index, instant] of instants.entries()) {
      let live: Live, asOf: string, overlay = instant.overlay
      if (report.mode === "LIVE") {
        const pulled = await pullLive(ds, orderId, order.reference, runCalls)
        if (pulled) { live = pulled.live; asOf = pulled.asOf } else { live = { ...emptyLive(), calls: runCalls }; asOf = new Date().toISOString() }
      } else { live = { ...emptyLive(), calls: runCalls, phone: instant.phone ?? null }; asOf = new Date(instant.at).toISOString() }
      const d = buildDossier(ds, orderId, live, asOf, overlay)
      const derived = derive(d)
      const diff = diffDerived(previous, derived)
      previous = derived
      const step: RunStep = { index, label: instant.label, asOf, phase: d.phase.phase, basis: d.phase.basis, derived, diff, reasoned: null, reasonCostUsd: 0, calls: [], modelOnlyCalls: [], notes: [] }
      if (report.mode === "LIVE" && !live.pulledFrom) step.notes.push("the app did not answer: built from the dataset and stored calls only")
      report.steps.push(step)
      // A check that turned DONE is not news on its own (the call that closed it was the news); anything else
      // closing (a deadline no longer at risk, a gap filled, a conflict gone) still is.
      const newsworthyClosed = diff.closed.filter((i) => i.kind !== "DUE_CHECK")
      const woken = diff.opened.length + diff.changed.length + newsworthyClosed.length > 0 || index === 0
      if (!woken) { step.notes.push("nothing changed in the derived layer: the model was not woken"); opts.onStep?.(report); continue }
      // 1. the reasoning step reads the dossier and the derived items
      try {
        const run = await reason(d, { ...modelOpts(opts), derived })
        step.reasoned = run.output; step.reasonCostUsd = run.costUsd ?? 0; report.costUsd += run.costUsd ?? 0
      } catch (e) { report.failures.push({ step: index, what: `reasoning failed: ${(e as Error).message.slice(0, 300)}` }) }
      // 2. the rules place the due checks; the model's agreement is recorded, its extra proposals noted
      const due = derived.filter((i): i is Extract<DerivedItem, { kind: "DUE_CHECK" }> => i.kind === "DUE_CHECK" && (i.state === "DUE" || i.state === "OVERDUE"))
      const proposed = step.reasoned?.calls ?? []
      for (const item of due) {
        const n = (attempts.get(item.subject) ?? 0) + 1
        if (n > maxAttempts) { step.notes.push(`${item.purpose} to ${item.callee.name} skipped: already tried ${maxAttempts} times`); continue }
        attempts.set(item.subject, n)
        try {
          const persona = personaFor(d, item.purpose, twist)
          const r = await runLlmCall(d, persona, item.purpose, asOf, modelOpts(opts))
          const record = { ...r.record, attempt: n, id: `${r.record.id}-${index}` }
          runCalls.push(record); opts.store?.(record); report.costUsd += r.costUsd
          const review = record.direction === "OUTBOUND" ? reviewCall(record) : null
          step.calls.push({ derivedId: item.id, purpose: item.purpose, callee: item.callee, callId: record.id, attempt: n, outcome: record.outcome, slots: record.slots.length, verdict: review?.verdict ?? null, costUsd: r.costUsd, proposedBy: proposed.some((p) => p.purpose === item.purpose) ? "BOTH" : "RULES" })
          if (review?.violations.length) report.failures.push({ step: index, what: `the caller said a forbidden line on ${record.id}: ${review.violations.map((v) => v.text).join(" | ").slice(0, 200)}` })
        } catch (e) { report.failures.push({ step: index, what: `${item.purpose} to ${item.callee.name} could not be placed: ${(e as Error).message.slice(0, 300)}` }) }
      }
      for (const p of proposed) {
        if (due.some((i) => i.purpose === p.purpose)) continue
        step.modelOnlyCalls.push({ purpose: p.purpose, who: p.who, reason: p.reason })
        const callable = callableNames(d)
        if (!callable.some((name) => p.who.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(p.who.toLowerCase()))) report.failures.push({ step: index, what: `the model proposed calling "${p.who}" (${p.purpose}), who is not a callable party on this order` })
      }
      // 3. the next step sees the calls: rebuild the derived layer now so the diff at the next step reflects them
      if (step.calls.length) previous = derive(buildDossier(ds, orderId, { ...live, calls: runCalls }, asOf, overlay))
      opts.onStep?.(report)
    }
    report.status = "done"
  } catch (e) {
    report.status = "failed"; report.error = (e as Error).message.slice(0, 500)
  }
  report.finishedAt = new Date().toISOString()
  const placed = report.steps.flatMap((s) => s.calls)
  report.summary = {
    callsPlaced: placed.length, completed: placed.filter((c) => c.outcome === "COMPLETED").length, partial: placed.filter((c) => c.outcome === "PARTIAL").length,
    stepsWoken: report.steps.filter((s) => s.reasoned).length, needsPersonSteps: report.steps.filter((s) => s.reasoned?.needsPerson).length,
  }
  opts.onStep?.(report)
  return RunReport.parse(report)
}

/** Names the agent may call on this order: the booked driver, and a pickup desk that is not the customer. */
function callableNames(d: Dossier): string[] {
  const order = items(d, "orders")[0]?.record
  const a = items(d, "work_assignments").map((i) => i.record).find((x) => x.status === "IN_PROGRESS" || x.status === "ASSIGNED")
  const drv = a ? items(d, "drivers").map((i) => i.record).find((x) => x.id === a.driver_id) : undefined
  const site = order ? items(d, "sites").map((i) => i.record).find((x) => x.id === order.pickup_site_id) : undefined
  const out: string[] = ["driver", "the driver"]
  if (drv) out.push(drv.display_name, drv.display_name.split(" ")[0]!)
  if (site && order && site.customer_id !== order.customer_id) out.push(site.name, "pickup desk", "the pickup desk", "pickup site")
  return out
}
import type { Dossier } from "./dossier"

export function newRunReport(orderRef: string, mode: RunMode, twist: Twist): RunReport {
  return { id: `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, orderRef, mode, twist, status: "running", startedAt: new Date().toISOString(), finishedAt: null, plannedSteps: [], steps: [], failures: [], costUsd: 0, summary: { callsPlaced: 0, completed: 0, partial: 0, stepsWoken: 0, needsPersonSteps: 0 }, error: null }
}

/** The report as a few lines a person reads first. */
export function summarizeRun(r: RunReport): string {
  const lines = [`${r.orderRef} · ${r.mode} · ${r.twist} · ${r.status} · ${r.steps.length} steps, ${r.summary.callsPlaced} calls (${r.summary.completed} completed, ${r.summary.partial} partial), model woken ${r.summary.stepsWoken}×, $${r.costUsd.toFixed(3)}`]
  for (const s of r.steps) {
    const due = s.derived.filter((i) => i.kind === "DUE_CHECK").map((i) => i.kind === "DUE_CHECK" ? `${i.purpose}:${i.state}` : "")
    lines.push(`  ${s.index}. ${s.label} · ${s.asOf} · ${s.phase}${due.length ? ` · due ${due.join(", ")}` : ""}${s.reasoned ? ` · "${s.reasoned.headline}"` : " · (not woken)"}${s.reasoned?.needsPerson ? ` · NEEDS PERSON: ${s.reasoned.needsPerson.what}` : ""}`)
    for (const c of s.calls) lines.push(`       call ${c.purpose} -> ${c.callee.name}: ${c.outcome}, ${c.slots} claims${c.verdict ? `, review ${c.verdict}` : ""}, ${c.proposedBy === "BOTH" ? "rules and model agreed" : "rules only"} (${c.callId})`)
    for (const m of s.modelOnlyCalls) lines.push(`       model also proposed ${m.purpose} to ${m.who}: ${m.reason}`)
    for (const n of s.notes) lines.push(`       note: ${n}`)
  }
  for (const f of r.failures) lines.push(`  FAILURE at step ${f.step}: ${f.what}`)
  return lines.join("\n")
}
