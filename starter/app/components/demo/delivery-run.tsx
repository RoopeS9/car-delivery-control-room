"use client"

import Link from "next/link"
import { useCallback, useEffect, useState } from "react"
import { labelIn } from "@/lib/present/labels"
import { fmtDateTime } from "@/lib/present/time"
import { Icon } from "../icons"
import { ClaimsList, Scorecard } from "../calls/review-parts"
import { PlayCallButton, PlayTurnButton, useCallPlayer } from "../calls/call-audio"
import type { CallRecord, CallReview } from "@/lib/present/call-types"
import "./delivery-run.css"

// Simulate a whole delivery: the dossier service walks one order through its phases, says at each step what the rules
// derive and what the reasoning step concludes, and places the due robo-calls with counterparts built from the
// dossier. The page polls the run and shows every step as it lands; each call links to its stored transcript.

type RunSummary = { id: string; orderRef: string; mode: string; twist: string; status: string; startedAt: string; finishedAt: string | null; steps: number; planned: number; summary: { callsPlaced: number; completed: number; partial: number; stepsWoken: number; needsPersonSteps: number }; costUsd: number; failures: number }
type Derived = { kind: string; id: string; purpose?: string; state?: string; callee?: { name: string }; line?: string; why?: string }
type Step = {
  index: number; label: string; asOf: string; phase: string; basis: string; derived: Derived[]
  diff: { opened: Derived[]; changed: unknown[]; closed: Derived[] }
  reasoned: { headline: string; needsPerson: { what: string; why: string; options: string[] } | null; watching: { kind: string; line: string; severity: string }[]; calls: { purpose: string; who: string; reason: string }[]; unknowns: string[] } | null
  calls: { derivedId: string; purpose: string; callee: { name: string }; callId: string; attempt: number; outcome: string; slots: number; verdict: string | null; proposedBy: string }[]
  modelOnlyCalls: { purpose: string; who: string; reason: string }[]
  notes: string[]
}
type Run = RunSummary & { plannedSteps: string[]; steps: Step[]; failures: { step: number; what: string }[]; error: string | null }

const TWISTS: { id: string; label: string; hint: string }[] = [
  { id: "cooperative", label: "Cooperative", hint: "the desk and the driver answer from the records" },
  { id: "confused", label: "Confused", hint: "the desk cannot find the car or the keys" },
  { id: "rushed", label: "Rushed", hint: "short answers; the driver cannot make the slot" },
  { id: "wrong_fact", label: "Wrong fact", hint: "what they say contradicts our records" },
]
const PURPOSE_WORDS: Record<string, string> = { PICKUP_READINESS: "Pickup readiness", DRIVER_START_CHECK: "Driver start check", POSITION_CHECK: "Position check", FERRY_CHECKIN: "Ferry check-in", DRIVER_INBOUND: "Driver calls in", RECEIVER_CONFIRMATION: "Receiver confirmation" }
const words = (code: string) => PURPOSE_WORDS[code] ?? labelIn(code)

export function DeliveryRun({ orders }: { orders: { reference: string; id: string; title: string; phase: string }[] }) {
  const [ref, setRef] = useState(orders[0]?.reference ?? "")
  const [twist, setTwist] = useState("cooperative")
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [run, setRun] = useState<Run | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadRuns = useCallback(async () => {
    const response = await fetch("/api/runs", { cache: "no-store" }).catch(() => null)
    if (response?.ok) setRuns((await response.json()) as RunSummary[])
  }, [])
  useEffect(() => { void loadRuns() }, [loadRuns])

  const open = useCallback(async (id: string) => {
    const response = await fetch(`/api/runs/${encodeURIComponent(id)}`, { cache: "no-store" }).catch(() => null)
    if (response?.ok) setRun((await response.json()) as Run)
  }, [])

  // A running run is polled every 3 s until it is done or failed.
  useEffect(() => {
    if (!run || run.status !== "running") return
    const timer = setInterval(() => void open(run.id), 3000)
    return () => clearInterval(timer)
  }, [run, open])
  useEffect(() => { if (run && run.status !== "running") void loadRuns() }, [run, loadRuns])

  async function start() {
    setBusy(true); setError(null)
    try {
      const response = await fetch("/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ref, twist }) })
      const started = (await response.json()) as { runId?: string; error?: string }
      if (!response.ok || !started.runId) throw new Error(started.error ?? "The run did not start.")
      await open(started.runId)
      void loadRuns()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The run did not start.")
    } finally { setBusy(false) }
  }

  const [shownCall, setShownCall] = useState<string | null>(null)
  const chosen = orders.find((item) => item.reference === ref)
  const orderId = (reference: string) => orders.find((item) => item.reference === reference)?.id ?? null
  return <section className="drun" aria-labelledby="drun-title">
    <header className="drun-head">
      <h2 id="drun-title">Simulate a delivery</h2>
      <p>The dossier service walks one order through its phases: at each step the rules derive what is due, the reasoning step reads the dossier only when that changed, and every due check is placed as a call the model plays on both sides. Claims flow into the next step. Every call lands on the order&apos;s panel on the map.</p>
    </header>
    <div className="drun-controls">
      <label>Order
        <select value={ref} onChange={(event) => setRef(event.target.value)} disabled={busy || run?.status === "running"}>
          {orders.map((item) => <option key={item.reference} value={item.reference}>{item.reference} · {item.title} · {labelIn(item.phase).toLowerCase()}</option>)}
        </select>
      </label>
      <div className="drun-twists" role="group" aria-label="How the other parties behave">
        {TWISTS.map((item) => <button key={item.id} type="button" aria-pressed={twist === item.id} title={item.hint} onClick={() => setTwist(item.id)} disabled={busy || run?.status === "running"}>{item.label}</button>)}
      </div>
      <button type="button" className="btn primary" onClick={() => void start()} disabled={busy || !ref || run?.status === "running"} aria-busy={busy}>
        {run?.status === "running" ? <><span className="spinner" aria-hidden="true" />Running…</> : "Simulate this delivery"}
      </button>
      {chosen && <span className="calls-quiet">{TWISTS.find((item) => item.id === twist)?.hint}. A run takes two to six minutes and costs a few cents.</span>}
      {error && <span className="call-error" role="alert">{error}</span>}
    </div>

    {runs.length > 0 && <div className="drun-history" aria-label="Stored runs">
      {runs.slice(0, 8).map((item) => <button type="button" key={item.id} className={run?.id === item.id ? "active" : undefined} onClick={() => void open(item.id)}>
        <span className="mono">{item.orderRef}</span> · {labelIn(item.twist).toLowerCase()} · {fmtDateTime(item.startedAt)} · {item.status === "running" ? `${item.steps}/${item.planned} steps` : `${item.summary.callsPlaced} calls`}{item.failures ? ` · ${item.failures} failure${item.failures === 1 ? "" : "s"}` : ""}
      </button>)}
    </div>}

    {run && <div className="drun-report" aria-live="polite">
      <div className="drun-facts">
        <span className={`chip tone-${run.status === "done" ? "ok" : run.status === "failed" ? "danger" : "accent"}`}>{run.status === "running" ? "Running" : run.status === "done" ? "Done" : "Failed"}</span>
        <span className="calls-quiet">{run.orderRef} · {labelIn(run.twist).toLowerCase()} · {run.steps.length} of {run.plannedSteps.length} steps · {run.summary.callsPlaced} calls, {run.summary.completed} completed, {run.summary.partial} partial · model woken {run.summary.stepsWoken}× · ${run.costUsd.toFixed(3)}</span>
        {orderId(run.orderRef) && <Link className="ref-link" href={`/?order=${orderId(run.orderRef)}`}>On the map</Link>}
      </div>
      {run.error && <p className="call-error" role="alert">{run.error}</p>}
      <ol className="drun-steps">
        {run.steps.map((step) => <li key={step.index} className={step.reasoned ? "woken" : "quiet"}>
          <div className="drun-step-head">
            <b>{step.label}</b>
            <span className="calls-quiet">{fmtDateTime(step.asOf)} · {labelIn(step.phase).toLowerCase()}</span>
          </div>
          {step.derived.length > 0 && <ul className="drun-derived">
            {step.derived.map((item) => <li key={item.id} className={`dk-${item.kind.toLowerCase()}`}>
              {item.kind === "DUE_CHECK" ? <><Icon name="phone" size={12} />{words(item.purpose ?? "")} to {item.callee?.name} <span className={`chip-s ds-${(item.state ?? "").toLowerCase()}`}>{labelIn(item.state ?? "").toLowerCase()}</span></>
                : <><Icon name={item.kind === "CONFLICT" ? "alert" : item.kind === "SILENT_GAP" ? "waiting" : "flag"} size={12} />{item.line ?? item.why}</>}
            </li>)}
          </ul>}
          {step.reasoned ? <div className="drun-reasoned">
            <p className="drun-headline">{step.reasoned.headline}</p>
            {step.reasoned.needsPerson ? <p className="drun-need"><b>Needs a person:</b> {step.reasoned.needsPerson.what} <span className="calls-quiet">({step.reasoned.needsPerson.options.join(" · ")})</span></p> : <p className="calls-quiet">Nothing needs a person.</p>}
            {step.reasoned.watching.length > 0 && <ul className="drun-watching">{step.reasoned.watching.map((item, index) => <li key={index}><span className="chip-s">{labelIn(item.kind).toLowerCase()}</span> {item.line}</li>)}</ul>}
          </div> : <p className="calls-quiet">{step.notes[0] ?? "Nothing changed; the model was not woken."}</p>}
          {step.calls.length > 0 && <ul className="drun-calls">
            {step.calls.map((call) => <li key={call.callId}>
              <Icon name="phone" size={12} /><b>{words(call.purpose)}</b> to {call.callee.name}: <span className={`chip-s ${call.outcome === "COMPLETED" ? "s-ok" : "s-missed"}`}>{labelIn(call.outcome).toLowerCase()}</span> {call.slots} claim{call.slots === 1 ? "" : "s"}{call.verdict ? <> · review <span className={`chip-s v-${call.verdict.toLowerCase()}`}>{call.verdict}</span></> : null} · {call.proposedBy === "BOTH" ? "rules and model agreed" : "rules only"}{call.attempt > 1 ? ` · attempt ${call.attempt}` : ""}
              <button type="button" className="studio-link" onClick={() => setShownCall((current) => current === call.callId ? null : call.callId)} aria-expanded={shownCall === call.callId}>{shownCall === call.callId ? "Hide the transcript" : "Transcript"}</button>
              {shownCall === call.callId && <RunCall id={call.callId} />}
            </li>)}
          </ul>}
          {step.modelOnlyCalls.map((item, index) => <p key={index} className="calls-quiet">The model also proposed {words(item.purpose).toLowerCase()} to {item.who}: {item.reason}</p>)}
          {step.notes.slice(step.reasoned ? 0 : 1).map((note, index) => <p key={index} className="calls-quiet">{note}</p>)}
        </li>)}
        {run.status === "running" && run.steps.length < run.plannedSteps.length && <li className="pending"><span className="spinner" aria-hidden="true" />{run.plannedSteps[run.steps.length]?.replace(/ \(.*\)$/, "")}…</li>}
      </ol>
      {run.failures.length > 0 && <div className="drun-failures" role="alert">
        <h3>What went wrong</h3>
        <ul>{run.failures.map((item, index) => <li key={index}>Step {item.step}: {item.what}</li>)}</ul>
      </div>}
    </div>}
  </section>
}

/** One of the run's calls, fetched when opened: the transcript with its claims and review, playable when rendered. */
function RunCall({ id }: { id: string }) {
  const [call, setCall] = useState<(CallRecord & { review: CallReview | null }) | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let stopped = false
    fetch(`/api/calls/${encodeURIComponent(id)}`, { cache: "no-store" })
      .then(async (response) => { if (!response.ok) throw new Error("The call could not be read."); return response.json() as Promise<CallRecord & { review: CallReview | null }> })
      .then((body) => { if (!stopped) setCall(body) })
      .catch((failure) => { if (!stopped) setError(failure instanceof Error ? failure.message : "The call could not be read.") })
    return () => { stopped = true }
  }, [id])
  if (error) return <p className="call-error">{error}</p>
  if (!call) return <p className="calls-quiet">Reading the call…</p>
  return <RunCallView call={call} />
}

function RunCallView({ call }: { call: CallRecord & { review: CallReview | null } }) {
  const player = useCallPlayer(call)
  const callee = call.brief?.callee.name ?? "Other party"
  const slotsByTurn = new Map<number, CallRecord["slots"]>()
  for (const slot of call.slots) slotsByTurn.set(slot.turnSeq, [...(slotsByTurn.get(slot.turnSeq) ?? []), slot])
  return <div className="drun-call">
    <div className="call-facts"><span className="calls-quiet">{call.engine === "SIMULATED_LLM" ? "The model played both sides" : labelIn(call.engine ?? "call")} · {fmtDateTime(call.startedAt)}</span><PlayCallButton player={player} /></div>
    {call.review && <Scorecard review={call.review} compact />}
    <ol className="transcript" aria-label="Transcript">
      {call.turns.map((turn) => <li key={turn.seq} className={turn.speaker === "CALLER" ? "us" : "them"}>
        <span className="turn-who">{turn.speaker === "CALLER" ? "Mira" : callee} <span>turn {turn.seq}</span><PlayTurnButton player={player} seq={turn.seq} has={!!turn.audioKey} /></span>
        <p>{turn.text}</p>
        {slotsByTurn.get(turn.seq)?.map((slot) => <span key={slot.value.slot} className="turn-slot"><Icon name="check" size={12} />{labelIn(slot.value.slot)}: {String(slot.value.value)}</span>)}
      </li>)}
    </ol>
    <div className="call-side"><ClaimsList call={call} /></div>
  </div>
}
