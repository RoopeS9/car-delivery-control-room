"use client"

import Link from "next/link"
import { useState } from "react"
import { readToolArgument, slotLabel, slotValue, type CallRecord, type CallScenario } from "@/lib/present/call-types"
import { labelIn } from "@/lib/present/labels"
import { fmtDateTime } from "@/lib/present/time"
import { Icon } from "../icons"
import "./calls.css"

const ROLE_WORDS: Record<string, string> = { PICKUP_SITE_DESK: "Pickup desk", DRIVER: "Driver", DELIVERY_RECEIVER: "Receiver" }
const PURPOSE_WORDS: Record<string, string> = { PICKUP_READINESS: "Pickup readiness", DRIVER_START_CHECK: "Driver start check", DRIVER_INBOUND: "Driver calls in" }
const words = (map: Record<string, string>, code: string) => map[code] ?? labelIn(code)

/** Pick a robo-call scenario, run it, and read what the call established and from which turn. */
export function CallSimulator({ scenarios, stored, orderIds }: { scenarios: CallScenario[] | null; stored: Record<string, CallRecord[]>; orderIds: Record<string, string> }) {
  const [selected, setSelected] = useState<string | null>(scenarios?.[0]?.id ?? null)
  const [running, setRunning] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [calls, setCalls] = useState(stored)
  const [shown, setShown] = useState<Record<string, string>>({})
  const scenario = scenarios?.find((item) => item.id === selected) ?? null
  const history = scenario ? calls[scenario.orderRef] ?? [] : []
  const call = scenario ? history.find((item) => item.id === shown[scenario.id]) ?? history[0] ?? null : null

  async function run(item: CallScenario) {
    setRunning(item.id)
    setError(null)
    try {
      const response = await fetch("/api/calls/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ personaId: item.id }) })
      const body = (await response.json()) as CallRecord | { error: string }
      if (!response.ok || "error" in body) throw new Error("error" in body ? body.error : "The call did not run.")
      setCalls((current) => ({ ...current, [item.orderRef]: [body, ...(current[item.orderRef] ?? []).filter((known) => known.id !== body.id)] }))
      setShown((current) => ({ ...current, [item.id]: body.id }))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The call did not run.")
    } finally {
      setRunning(null)
    }
  }

  return <main className="page calls-page">
    <header className="q-head">
      <div>
        <h1>Call simulator</h1>
        <p className="q-sub">Try the robo-calls the agent makes and takes. Both sides are simulated; nothing is dialled. Each answer it takes cites the turn it came from.</p>
      </div>
    </header>

    {!scenarios && <div className="calls-empty"><b>The call service is not running.</b><p>It answers on this machine at port 8799. Start it, then reload this page.</p></div>}

    {scenarios && <div className="calls-layout">
      <ul className="calls-list" aria-label="Scenarios">
        {scenarios.map((item) => {
          const count = calls[item.orderRef]?.length ?? 0
          return <li key={item.id}>
            <button type="button" className={`call-card${item.id === selected ? " active" : ""}`} onClick={() => setSelected(item.id)} aria-pressed={item.id === selected}>
              <span className="call-card-top"><b>{words(PURPOSE_WORDS, item.purpose)}</b><span className="q-ref">{item.orderRef}</span></span>
              <span className="call-card-who">{item.inbound ? "Calls in" : "Calls"}: {words(ROLE_WORDS, item.role)} · {labelIn(item.mood).toLowerCase()}</span>
              <q className="call-card-line">{item.title}</q>
              <span className="call-card-foot">{count ? `${count} stored call${count === 1 ? "" : "s"}` : "Not run yet"}</span>
            </button>
          </li>
        })}
      </ul>

      {scenario && <section className="call-view" aria-label="Call">
        <div className="call-view-head">
          <div>
            <h2>{words(PURPOSE_WORDS, scenario.purpose)} · {orderIds[scenario.orderRef] ? <Link className="ref-link" href={`/orders/${orderIds[scenario.orderRef]}`}>{scenario.orderRef}</Link> : <span className="mono">{scenario.orderRef}</span>}</h2>
            <p>{scenario.inbound ? `${words(ROLE_WORDS, scenario.role)} calls Road Desk` : `Road Desk calls the ${words(ROLE_WORDS, scenario.role).toLowerCase()}`}, {labelIn(scenario.mood).toLowerCase()}.</p>
          </div>
          <button type="button" className="btn primary" onClick={() => void run(scenario)} disabled={!!running}>
            {running === scenario.id ? "Calling…" : call ? "Run again" : "Run the call"}
          </button>
        </div>
        {error && <p className="call-error" role="alert">{error}</p>}
        {running === scenario.id && <p className="call-running" aria-live="polite">The call is running. Both sides are simulated, so this takes a little while.</p>}
        {history.length > 1 && <div className="call-history" aria-label="Stored calls">
          {history.map((item) => <button type="button" key={item.id} className={item.id === call?.id ? "active" : undefined} onClick={() => setShown((current) => ({ ...current, [scenario.id]: item.id }))}>
            {fmtDateTime(item.startedAt)} · {labelIn(item.outcome).toLowerCase()}
          </button>)}
        </div>}
        {call ? <CallRecordView call={call} /> : running !== scenario.id && <p className="calls-quiet">No call stored for this order yet. Run it to see the transcript.</p>}
      </section>}
    </div>}
  </main>
}

function CallRecordView({ call }: { call: CallRecord }) {
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
      <span className="calls-quiet">{fmtDateTime(call.startedAt)}{call.endedAt ? ` to ${fmtDateTime(call.endedAt).split(" ").slice(-2).join(" ")}` : ""} · {call.engine === "SIMULATED" ? "simulated call" : "call"} · attempt {call.attempt ?? 1}</span>
    </div>
    {triage?.quote && <p className="call-quote">Triage rests on turn {String(triage.turnSeq ?? "")}: <q>{String(triage.quote)}</q></p>}

    <div className="call-columns">
      <ol className="transcript" aria-label="Transcript">
        {call.turns.map((turn) => <li key={turn.seq} id={`turn-${turn.seq}`} className={ours(turn.speaker) ? "us" : "them"}>
          <span className="turn-who">{nameOf(turn.speaker)} <span>turn {turn.seq} · {fmtDateTime(turn.startedAt).split(" ").slice(-2).join(" ")}</span></span>
          <p>{turn.text}</p>
          {slotsByTurn.get(turn.seq)?.map((slot) => <span key={slot.value.slot} className="turn-slot"><Icon name="check" size={12} />{slotLabel(slot.value.slot)}: {slotValue(slot.value.value)}</span>)}
          {toolsByTurn.get(turn.seq)?.map((tool, index) => <span key={index} className={`turn-tool${tool.name === "ESCALATE_TO_OPERATOR" ? " escalate" : ""}`}><Icon name="alert" size={12} />{tool.name === "ESCALATE_TO_OPERATOR" ? "Handed to an operator" : labelIn(String(tool.name ?? "tool"))}{tool.argument ? `: ${readToolArgument(tool.argument)}` : ""}</span>)}
        </li>)}
      </ol>

      <aside className="call-side">
        <h3>What the call established</h3>
        {call.slots.length === 0 ? <p className="calls-quiet">Nothing was established.</p> : <ul className="slot-list">
          {call.slots.map((slot) => <li key={`${slot.value.slot}-${slot.turnSeq}`}>
            <b>{slotLabel(slot.value.slot)}</b><span className="slot-value">{slotValue(slot.value.value)}</span>
            <a href={`#turn-${slot.turnSeq}`} className="slot-cite"><span className="chip-s s-claim">Claim</span> turn {slot.turnSeq}: <q>{slot.quote}</q></a>
          </li>)}
        </ul>}
        {missing.length > 0 && <>
          <h3>Not established</h3>
          <ul className="slot-missing">{missing.map((slot) => <li key={slot}>{slotLabel(slot)}</li>)}</ul>
        </>}
        {call.retryAfter && <p className="call-retry"><Icon name="waiting" size={13} />Tries again {fmtDateTime(call.retryAfter)}</p>}
        {call.toolCalls.length > 0 && <>
          <h3>Actions the caller took</h3>
          <ul className="slot-list">{call.toolCalls.map((tool, index) => <li key={index} className={tool.name === "ESCALATE_TO_OPERATOR" ? "escalate" : undefined}>
            <b>{tool.name === "ESCALATE_TO_OPERATOR" ? "Handed to an operator" : labelIn(String(tool.name ?? "tool"))}</b>
            {tool.argument ? <span className="slot-value">{readToolArgument(tool.argument)}</span> : null}
            {typeof tool.turnSeq === "number" && <a href={`#turn-${tool.turnSeq}`} className="slot-cite">turn {tool.turnSeq}</a>}
          </li>)}</ul>
        </>}
        {call.brief && <details className="call-brief">
          <summary>The brief the caller was given</summary>
          {call.brief.mayState?.length ? <><h4>May say</h4><ul>{call.brief.mayState.map((line) => <li key={line}>{line}</li>)}</ul></> : null}
          {call.brief.mustNot?.length ? <><h4>Must not</h4><p>{call.brief.mustNot.map((code) => labelIn(code).toLowerCase()).join(", ")}</p></> : null}
        </details>}
        <p className="calls-quiet">A spoken answer is a claim. It is not a scan or a signed record.</p>
      </aside>
    </div>
  </div>
}
