"use client"

import Link from "next/link"
import { useEffect, useRef, useState } from "react"
import { readToolArgument, slotLabel, slotValue, type CallJob, type CallRecord, type CallReview, type CallScenario, type RunStart } from "@/lib/present/call-types"
import { labelIn } from "@/lib/present/labels"
import { fmtDateTime } from "@/lib/present/time"
import { Icon } from "../icons"
import { CallOverlay, type CallTarget } from "../line/call-screen"
import { recall, remember } from "../role-memory"
import "./calls.css"
import { ClaimsList, MUST_NOT_WORDS, Scorecard } from "./review-parts"



const ROLE_WORDS: Record<string, string> = { PICKUP_SITE_DESK: "Pickup desk", DRIVER: "Driver", DELIVERY_RECEIVER: "Receiver" }
const PURPOSE_WORDS: Record<string, string> = { PICKUP_READINESS: "Pickup readiness", DRIVER_START_CHECK: "Driver start check", DRIVER_INBOUND: "Driver calls in" }
const words = (map: Record<string, string>, code: string) => map[code] ?? labelIn(code)

/** Pick a robo-call scenario, run it, and read what the call established and from which turn. */
export type PhoneFocus = { kind: "driver"; driverId: string; orderRef: string } | { kind: "desk"; name: string; call: CallRecord | null }

export function CallSimulator({ scenarios, stored, orderIds, callees, drivers, onFocus }: {
  scenarios: CallScenario[] | null; stored: Record<string, CallRecord[]>; orderIds: Record<string, string>; callees: Record<string, string | null>
  /** Scenario id to the driver called or calling, when the other party is a driver. */
  drivers: Record<string, string>
  /** Optional: told which phone belongs to the chosen scenario. */
  onFocus?: (focus: PhoneFocus) => void
}) {
  const [selected, setSelected] = useState<string | null>((scenarios?.find((item) => !item.inbound) ?? scenarios?.[0])?.id ?? null)
  // Reviews of outbound calls, by call id: from the run itself, or fetched for a stored call when it is shown.
  const [reviews, setReviews] = useState<Record<string, CallReview | null>>({})
  const [running, setRunning] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [calls, setCalls] = useState(stored)
  const [shown, setShown] = useState<Record<string, string>>({})
  const [fresh, setFresh] = useState<string | null>(null)
  const [live, setLive] = useState<CallTarget | null>(null)
  // The model plays both sides by default (20 to 60 s); the scripted run is quick.
  const [mode, setMode] = useState<"llm" | "scripted">("llm")
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!running) { setElapsed(0); return }
    const started = Date.now()
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [running])
  // The chosen scenario survives switching roles and back.
  useEffect(() => { const saved = recall<string>("calls:selected"); if (saved && scenarios?.some((item) => item.id === saved)) setSelected(saved) }, [scenarios])
  useEffect(() => { if (selected) remember("calls:selected", selected) }, [selected])
  const record = useRef<HTMLDivElement>(null)
  const scenario = scenarios?.find((item) => item.id === selected) ?? null
  const history = scenario ? calls[scenario.orderRef] ?? [] : []
  const call = scenario ? history.find((item) => item.id === shown[scenario.id]) ?? history[0] ?? null : null

  async function run(item: CallScenario) {
    setRunning(item.id)
    setError(null)
    try {
      const response = await fetch("/api/calls/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ personaId: item.id, mode }) })
      const started = (await response.json()) as RunStart | { error: string }
      if (!response.ok || "error" in started) throw new Error("error" in started ? started.error : "The call did not run.")
      let body: CallRecord
      let review: CallReview | null = null
      if ("jobId" in started) {
        // A model-played run: poll the job every 2 s until it is done or failed (give up after four minutes).
        const deadline = Date.now() + 4 * 60_000
        for (;;) {
          await new Promise((resolve) => setTimeout(resolve, 2000))
          const poll = await fetch(`/api/calls/jobs/${encodeURIComponent(started.jobId)}`, { cache: "no-store" })
          const job = (await poll.json()) as CallJob | { error: string }
          // Jobs live in the call service's memory: a restart mid-run loses them.
          if (poll.status === 404) throw new Error("The call service restarted during the run and lost it. Simulate the call again.")
          if ("error" in job && !("status" in job)) throw new Error(job.error)
          const current = job as CallJob
          if (current.status === "done" && current.call) { body = current.call; review = current.review; break }
          if (current.status === "failed") throw new Error(current.error ?? "The model could not finish the call.")
          if (Date.now() > deadline) throw new Error("The call took too long; it may still finish on the call service.")
        }
      } else {
        body = started
        review = started.review ?? null
      }
      const finished = body
      setReviews((current) => ({ ...current, [finished.id]: review }))
      setCalls((current) => ({ ...current, [item.orderRef]: [finished, ...(current[item.orderRef] ?? []).filter((known) => known.id !== finished.id)] }))
      setShown((current) => ({ ...current, [item.id]: finished.id }))
      setFresh(finished.id)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The call did not run.")
    } finally {
      setRunning(null)
    }
  }

  // A stored outbound call shown without its review fetches it once.
  useEffect(() => {
    if (!call || call.direction !== "OUTBOUND" || call.id in reviews) return
    let stopped = false
    fetch(`/api/calls/review?id=${encodeURIComponent(call.id)}`, { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<CallReview> : null)
      .then((review) => { if (!stopped) setReviews((current) => ({ ...current, [call.id]: review })) })
      .catch(() => undefined)
    return () => { stopped = true }
  }, [call, reviews])

  // The middle phone follows the chosen scenario: the driver's app, or the desk's side of the call.
  const focusKey = `${scenario?.id ?? ""}|${call?.id ?? ""}`
  useEffect(() => {
    if (!scenario) return
    const driverId = drivers[scenario.id]
    onFocus?.(driverId ? { kind: "driver", driverId, orderRef: scenario.orderRef } : { kind: "desk", name: callees[scenario.id] ?? words(ROLE_WORDS, scenario.role), call })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey])

  // A finished call is selected, scrolled into view and highlighted for a moment.
  useEffect(() => {
    if (!fresh) return
    record.current?.scrollIntoView({ behavior: "smooth", block: "start" })
    const timer = setTimeout(() => setFresh(null), 2400)
    return () => clearTimeout(timer)
  }, [fresh])

  return <section id="calls" className="calls-page" aria-labelledby="calls-title">
    <header className="calls-head">
      <h2 id="calls-title">Calls</h2>
      <p>Simulate the robo-calls the agent makes and takes. Both sides are simulated; nothing is dialled. Each answer cites the turn it came from, and the call shows up on the map in that order&apos;s panel.</p>
    </header>

    {!scenarios && <div className="calls-empty"><b>The call service is not running.</b><p>It answers on this machine at port 8799. Start it, then reload this page.</p></div>}

    {scenarios && <div className="calls-layout">
      <div className="calls-list" aria-label="Scenarios">
        {[{ title: "Outbound checks", items: scenarios.filter((item) => !item.inbound) }, { title: "Inbound: the driver calls in", items: scenarios.filter((item) => item.inbound) }].map((group) => group.items.length > 0 && <section key={group.title}>
          <h2 className="calls-group">{group.title}</h2>
          <ul>{group.items.map((item) => {
            const count = calls[item.orderRef]?.length ?? 0
            return <li key={item.id}>
              <button type="button" className={`call-card${item.id === selected ? " active" : ""}`} onClick={() => setSelected(item.id)} aria-pressed={item.id === selected}>
                <span className="call-card-top"><b>{words(PURPOSE_WORDS, item.purpose)}</b><span className="q-ref">{item.orderRef}</span></span>
                <span className="call-card-who">{callees[item.id] ?? words(ROLE_WORDS, item.role)} · {labelIn(item.mood).toLowerCase()}</span>
                <q className="call-card-line">{item.title}</q>
                <span className="call-card-foot">{count ? `${count} stored call${count === 1 ? "" : "s"}` : "Not simulated yet"}</span>
              </button>
            </li>
          })}</ul>
        </section>)}
      </div>

      {scenario && <section className="call-view" aria-label="Call">
        <div className="call-view-head">
          <div>
            <h2>{words(PURPOSE_WORDS, scenario.purpose)}{callees[scenario.id] ? ` with ${callees[scenario.id]}` : ""} · {orderIds[scenario.orderRef] ? <Link className="ref-link" href={`/orders/${orderIds[scenario.orderRef]}`}>{scenario.orderRef}</Link> : <span className="mono">{scenario.orderRef}</span>}</h2>
            <p>{scenario.inbound ? `${words(ROLE_WORDS, scenario.role)} calls Road Desk` : `Road Desk calls the ${words(ROLE_WORDS, scenario.role).toLowerCase()}`}, {labelIn(scenario.mood).toLowerCase()}.
              {drivers[scenario.id] && <> <Link className="studio-link" href={`/driver?driver=${encodeURIComponent(drivers[scenario.id])}&job=${scenario.orderRef}`}>Show the driver</Link></>}</p>
          </div>
          <div className="call-run">
            {!scenario.inbound && <button type="button" className="btn" disabled={!!running || !!live} title="A live call: Mira from Bahn calls, and you answer as the desk"
              onClick={() => setLive({ orderRef: scenario.orderRef, purpose: scenario.purpose, calleeName: "Mira from Bahn", purposeLabel: words(PURPOSE_WORDS, scenario.purpose),
                cardUrl: `http://127.0.0.1:8799/card/${scenario.orderRef}/${scenario.purpose}?by=model`,
                youAre: `You are ${callees[scenario.id] ?? "the pickup desk"}. Mira from Bahn calls you about this collection; answer as the desk would.` })}>
              Simulate outbound call (you answer)
            </button>}
            <div className="call-mode" role="group" aria-label="How both sides are played">
              <button type="button" aria-pressed={mode === "llm"} onClick={() => setMode("llm")} disabled={!!running}>Model</button>
              <button type="button" aria-pressed={mode === "scripted"} onClick={() => setMode("scripted")} disabled={!!running}>Scripted</button>
            </div>
            <button type="button" className="btn primary" onClick={() => void run(scenario)} disabled={!!running} aria-busy={running === scenario.id}>
              {running === scenario.id ? <><span className="spinner" aria-hidden="true" />Simulating…</> : "Simulate call"}
            </button>
            {running === scenario.id && <span className="call-running" aria-live="polite">
              {scenario.inbound ? `${callees[scenario.id] ?? "The driver"} is talking to Road Desk…` : `Mira is talking to ${callees[scenario.id] ?? "the other party"}…`} {elapsed}s{mode === "llm" ? " · the model plays both sides; this takes 20 to 60 s" : ""}
            </span>}
            {error && <span className="call-error" role="alert">{error}</span>}
          </div>
        </div>
        {history.length > 1 && <div className="call-history" aria-label="Stored calls">
          {history.slice(0, 6).map((item) => <button type="button" key={item.id} className={item.id === call?.id ? "active" : undefined} onClick={() => setShown((current) => ({ ...current, [scenario.id]: item.id }))}>
            {fmtDateTime(item.startedAt)} · {labelIn(item.outcome).toLowerCase()}
          </button>)}
        </div>}
        {call ? <div ref={record} className={`call-record-wrap${fresh === call.id ? " fresh-call" : ""}`}><CallRecordView call={call} review={reviews[call.id] ?? null} /></div>
          : running !== scenario.id && <p className="calls-quiet">No call stored for this order yet. Simulate one to see the transcript.</p>}
      </section>}
    </div>}
    {live && <CallOverlay target={live} onClose={() => setLive(null)} />}
  </section>
}

/** The card Mira was given, to read beside what she said. */
function CardColumn({ brief }: { brief: NonNullable<CallRecord["brief"]> }) {
  return <aside className="call-card-col" aria-label="The card Mira was given">
    <h3>Mira&apos;s card</h3>
    {brief.opening && <><h4>Opening</h4><p>{brief.opening}</p></>}
    {brief.mayState?.length ? <><h4>May say</h4><ul>{brief.mayState.map((line) => <li key={line}>{line}</li>)}</ul></> : null}
    {brief.ask?.length ? <><h4>Must find out</h4><ul>{brief.ask.map((slot) => <li key={slot}>{slotLabel(slot)}</li>)}</ul></> : null}
    {brief.mustNot?.length ? <><h4>Must not</h4><p>{brief.mustNot.map((code) => (MUST_NOT_WORDS[code] ?? labelIn(code)).toLowerCase()).join(", ")}</p></> : null}
    {brief.closing && <><h4>Closing</h4><p>{brief.closing}</p></>}
  </aside>
}

function CallRecordView({ call, review }: { call: CallRecord; review: CallReview | null }) {
  const callee = call.brief?.callee.name ?? "Other party"
  const said = new Set(call.slots.map((slot) => slot.value.slot))
  const missing = (call.brief?.ask ?? []).filter((slot) => !said.has(slot))
  const triage = typeof call.triage === "object" && call.triage ? call.triage : null
  const slotsByTurn = new Map<number, CallRecord["slots"]>()
  for (const slot of call.slots) slotsByTurn.set(slot.turnSeq, [...(slotsByTurn.get(slot.turnSeq) ?? []), slot])
  const toolsByTurn = new Map<number, CallRecord["toolCalls"]>()
  for (const tool of call.toolCalls) if (typeof tool.turnSeq === "number") toolsByTurn.set(tool.turnSeq, [...(toolsByTurn.get(tool.turnSeq) ?? []), tool])
  // The service always records Road Desk's voice as CALLER and the other party as CALLEE, whoever dialled.
  const nameOf = (speaker: string) => speaker === "CALLER" ? "Road Desk" : callee
  const ours = (speaker: string) => speaker === "CALLER"

  return <div className="call-record">
    <div className="call-facts">
      <span className={`chip tone-${call.outcome === "COMPLETED" ? "ok" : call.outcome === "ESCALATED" ? "danger" : "warn"}`}>{labelIn(call.outcome)}</span>
      {triage && <span className={`chip triage triage-${String(triage.urgency ?? "").toLowerCase()}`}>Triage: {labelIn(String(triage.urgency ?? "unknown"))}{triage.situation ? `, ${labelIn(String(triage.situation)).toLowerCase()}` : ""}</span>}
      <span className="calls-quiet">{fmtDateTime(call.startedAt)}{call.endedAt ? ` to ${fmtDateTime(call.endedAt).split(" ").slice(-2).join(" ")}` : ""} · {call.engine === "SIMULATED_LLM" ? "Model-simulated" : call.engine === "SIMULATED" ? "Scripted" : "Call"} · attempt {call.attempt ?? 1}</span>
    </div>
    {triage?.quote && <p className="call-quote">Triage rests on turn {String(triage.turnSeq ?? "")}: <q>{String(triage.quote)}</q></p>}
    {call.direction === "OUTBOUND" && (review ? <Scorecard review={review} /> : <p className="calls-quiet">Reviewing the call…</p>)}

    <div className={`call-columns${call.direction === "OUTBOUND" && call.brief ? " with-card" : ""}`}>
      {call.direction === "OUTBOUND" && call.brief && <CardColumn brief={call.brief} />}
      <ol className="transcript" aria-label="Transcript">
        {call.turns.map((turn) => <li key={turn.seq} id={`turn-${turn.seq}`} className={ours(turn.speaker) ? "us" : "them"}>
          <span className="turn-who">{nameOf(turn.speaker)} <span>turn {turn.seq} · {fmtDateTime(turn.startedAt).split(" ").slice(-2).join(" ")}</span></span>
          <p>{turn.text}</p>
          {slotsByTurn.get(turn.seq)?.map((slot) => <span key={slot.value.slot} className="turn-slot"><Icon name="check" size={12} />{slotLabel(slot.value.slot)}: {slotValue(slot.value.value)}</span>)}
          {toolsByTurn.get(turn.seq)?.map((tool, index) => <span key={index} className={`turn-tool${tool.name === "ESCALATE_TO_OPERATOR" ? " escalate" : ""}`}><Icon name="alert" size={12} />{tool.name === "ESCALATE_TO_OPERATOR" ? "Handed to an operator" : labelIn(String(tool.name ?? "tool"))}{tool.argument ? `: ${readToolArgument(tool.argument)}` : ""}</span>)}
        </li>)}
      </ol>

      <aside className="call-side">
        <ClaimsList call={call} />
        {call.brief && call.direction !== "OUTBOUND" && <details className="call-brief">
          <summary>The brief the caller was given{call.engine === "SIMULATED_LLM" ? " (composed by the model)" : ""}</summary>
          {call.brief.mayState?.length ? <><h4>May say</h4><ul>{call.brief.mayState.map((line) => <li key={line}>{line}</li>)}</ul></> : null}
          {call.brief.mustNot?.length ? <><h4>Must not</h4><p>{call.brief.mustNot.map((code) => labelIn(code).toLowerCase()).join(", ")}</p></> : null}
        </details>}
        <p className="calls-quiet">A spoken answer is a claim. It is not a scan or a signed record.</p>
      </aside>
    </div>
  </div>
}

/** The other party's phone during a desk call: the conversation as it was heard. */
export function DeskPhone({ name, call }: { name: string; call: CallRecord | null }) {
  return <div className="desk-phone">
    <header><span className="desk-avatar" aria-hidden="true">{name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2)}</span><div><b>{name}</b><small>{call ? `Call with Road Desk · ${labelIn(call.outcome).toLowerCase()}` : "No call yet"}</small></div></header>
    <ol>{(call?.turns ?? []).map((turn) => <li key={turn.seq} className={turn.speaker === "CALLER" ? "them" : "me"}>{turn.text}</li>)}</ol>
    {!call && <p>Simulate the call to hear it from this side.</p>}
  </div>
}
