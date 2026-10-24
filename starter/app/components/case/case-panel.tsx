"use client"

import { useState } from "react"
import {
  askAgentPath, customerAnswerPath, instructPath, outcomePath,
  type AskAgentRequest, type AskAgentResponse, type CaseActionResponse, type CustomerAnswerRequest, type InstructRequest, type LogOutcomeRequest,
} from "@/lib/cr/types"
import type { CaseView, PromiseView, RecordView } from "@/lib/present/types"
import { Icon } from "../icons"
import { When } from "../ui"
import { DecidedCard, DecisionCard, OutdatedNotice, Sources, UnknownOutcomeNotice } from "./decision-card"
import { OPERATOR } from "./operator"
import { TelemetryStrip } from "./telemetry-strip"
import { Timeline } from "./timeline"

function OutcomeBox({ kase, proposalId, title, onSaved }: { kase: CaseView; proposalId: string; title: string; onSaved: () => void }) {
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  async function save() {
    if (!text.trim()) { setError("Write one line about what happened."); return }
    setBusy(true)
    setError("")
    try {
      const body: LogOutcomeRequest = { proposal_id: proposalId, text: text.trim(), logged_by: OPERATOR.id }
      const response = await fetch(outcomePath(kase.id), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      const data = await response.json().catch(() => null) as CaseActionResponse | null
      if (!response.ok) throw new Error(data?.error ?? "Could not reach the agent service. Nothing was saved.")
      setText("")
      onSaved()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save.")
    } finally {
      setBusy(false)
    }
  }
  return <div className="outcome">
    <label htmlFor={`outcome-${proposalId}`}><Icon name="note" size={14} /><b>Log what happened</b> · you said you would handle “{title}”</label>
    <div className="outcome-row">
      <input id={`outcome-${proposalId}`} value={text} onChange={(event) => setText(event.target.value)} placeholder="Dealer sends their own roadside help, ETA 11:00"
        onKeyDown={(event) => { if (event.key === "Enter") void save() }} />
      <button type="button" className="btn primary" disabled={busy} onClick={save}>Save and hand back to the agent</button>
    </div>
    {error && <p className="dcard-error" role="alert">{error}</p>}
  </div>
}

/** The delivery promise as it stands, with changes proposed to the customer and their answer. */
function PromiseBlock({ promise, onChange }: { promise: PromiseView; onChange: () => void }) {
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  async function answer(effectId: string, value: CustomerAnswerRequest["answer"]) {
    if (!promise.caseId) return
    if (!note.trim()) { setError("Say how the customer answered, in one line. It is kept as the evidence."); return }
    setBusy(true)
    setError("")
    try {
      const body: CustomerAnswerRequest = { answer: value, note: note.trim(), logged_by: OPERATOR.id, effect_id: effectId }
      const response = await fetch(customerAnswerPath(promise.caseId), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      const data = await response.json().catch(() => null) as CaseActionResponse | null
      if (!response.ok) throw new Error(data?.error ?? "Could not reach the agent service. Nothing was saved.")
      setNote("")
      onChange()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save.")
    } finally {
      setBusy(false)
    }
  }
  return <section className="sec promise" aria-label="Delivery promise">
    <div className="sec-head"><h2>Delivery promise</h2><span className="note">An operator&apos;s approval is not the customer&apos;s agreement.</span></div>
    <p className="promise-now"><b>{promise.text}</b> · {promise.basis} <Sources sources={[promise.source]} /></p>
    {promise.pending.map((item) => <div className="promise-pending" key={item.effectId}>
      <p><Icon name="waiting" size={14} /> <b>Proposed to the customer:</b> {item.text}. Not agreed yet, so the promise above still stands. <span className="muted">{item.basis}, <When at={item.proposedAt} withZone={false} />.</span></p>
      <div className="reconcile">
        <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Dealer agreed on the phone with the sales desk" aria-label="How the customer answered" />
        <button type="button" className="btn" disabled={busy} onClick={() => answer(item.effectId, "agreed")}>Customer agreed</button>
        <button type="button" className="btn" disabled={busy} onClick={() => answer(item.effectId, "declined")}>Customer declined</button>
      </div>
    </div>)}
    {error && <p className="dcard-error" role="alert">{error}</p>}
    {promise.history.length > 0 && <details className="more"><summary><Icon name="chevron" size={12} />History ({promise.history.length})</summary>
      <ul className="promise-history">{promise.history.map((item, index) => <li key={index}><When at={item.at} withZone={false} /> · {item.text} · {item.state === "CUSTOMER_AGREED" ? "agreed" : item.state === "CUSTOMER_DECLINED" ? "declined" : "proposed"} · {item.basis}</li>)}</ul>
    </details>}
  </section>
}

/** "Tell the agent": a free-text instruction on an open case with no card waiting. */
function TellAgent({ caseId, onSent, startOpen = false }: { caseId: string; onSent: () => void; startOpen?: boolean }) {
  const [open, setOpen] = useState(startOpen)
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  async function send() {
    if (!text.trim()) { setError("Write what the agent should do."); return }
    setBusy(true)
    setError("")
    try {
      const body: InstructRequest = { text: text.trim(), by: OPERATOR.id }
      const response = await fetch(instructPath(caseId), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      const data = await response.json().catch(() => null) as CaseActionResponse | null
      if (!response.ok) throw new Error(data?.error ?? "Could not reach the agent service. Nothing was sent.")
      setText("")
      setOpen(false)
      onSent()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send.")
    } finally {
      setBusy(false)
    }
  }
  if (!open) return <button type="button" className="btn quiet tell-open" onClick={() => setOpen(true)}><Icon name="message" size={14} />Tell the agent what to do</button>
  return <div className="outcome tell">
    <label htmlFor={`tell-${caseId}`}><Icon name="bot" size={14} /><b>Tell the agent</b> · it follows your instruction on its next turn</label>
    <div className="outcome-row">
      <input id={`tell-${caseId}`} value={text} autoFocus onChange={(event) => setText(event.target.value)} placeholder="Ask the driver to wait in the café until the tow arrives"
        onKeyDown={(event) => { if (event.key === "Enter") void send() }} />
      <button type="button" className="btn primary" disabled={busy} onClick={send}>Send</button>
      <button type="button" className="btn quiet" disabled={busy} onClick={() => { setOpen(false); setError("") }}>Cancel</button>
    </div>
    {error && <p className="dcard-error" role="alert">{error}</p>}
  </div>
}

function AskAgent({ caseId, orderRef }: { caseId: string | null; orderRef: string }) {
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const [answer, setAnswer] = useState<{ q: string; a: string } | null>(null)
  const [error, setError] = useState("")
  async function ask() {
    const question = text.trim()
    if (!question) return
    setBusy(true)
    setError("")
    try {
      const body: AskAgentRequest = { case_id: caseId, order_ref: orderRef, text: question, asked_by: OPERATOR.id }
      const response = await fetch(askAgentPath, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      const data = await response.json().catch(() => null) as AskAgentResponse | null
      if (!response.ok || !data || data.error) throw new Error(data?.error ?? "The agent could not be reached.")
      setAnswer({ q: question, a: data.reply })
      setText("")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The agent could not be reached.")
    } finally {
      setBusy(false)
    }
  }
  return <section className="sec ask" aria-label="Ask the agent">
    <div className="sec-head"><h2>Ask the agent</h2><span className="note">Answers with sources. It never changes anything from here.</span></div>
    {answer && <div className="ask-answer"><p className="ask-q">{answer.q}</p><p className="ask-a">{answer.a}</p></div>}
    <form className="ask-form" onSubmit={(event) => { event.preventDefault(); void ask() }}>
      <input value={text} onChange={(event) => setText(event.target.value)} placeholder="Has the driver sent the photo? What is the promise and who set it?" aria-label="Question for the agent" />
      <button type="submit" className="btn" disabled={busy || !text.trim()}>{busy ? "Asking…" : "Ask"}</button>
    </form>
    {error && <p className="dcard-error" role="alert">{error}</p>}
  </section>
}

/** Cases about the car itself show what the car reports. */
const VEHICLE_KINDS = new Set(["VEHICLE_WARNING", "BREAKDOWN", "ACCIDENT"])

function CaseBlock({ kase, view, onChange }: { kase: CaseView; view: RecordView; onChange: () => void }) {
  const awaiting = kase.decided.filter((card) => card.awaitingOutcome)
  const open = kase.status !== "RESOLVED" && kase.status !== "HANDLED_BY_AGENT"
  return <section className={`case${open ? "" : " closed"}`} data-tone={kase.tone} id={`case-${kase.id}`}>
    <header className="case-head">
      <div className="case-tags">
        <span className={`chip tone-${kase.tone}`}><span className="chip-dot" />{kase.statusLabel}</span>
        <span className="case-kind">{kase.kindLabel}</span>
        {open && (kase.urgency === "CRITICAL" || kase.urgency === "HIGH") && <span className="case-urgency">{kase.urgencyLabel}</span>}
      </div>
      <span className="case-opened">Opened <When at={kase.openedAt} snapshotAt={view.simNow} relative withZone={false} /> · {kase.channelLabel}{kase.owner ? ` · ${kase.owner}` : ""}</span>
    </header>
    <h2 className="case-title">{kase.title}</h2>
    {kase.summary && <p className="case-summary">{kase.summary}</p>}
    {kase.sources.length > 0 && <p className="case-sources">Builds on: <Sources sources={kase.sources} /></p>}
    {open && view.telemetry && VEHICLE_KINDS.has(kase.kind) && <TelemetryStrip telemetry={view.telemetry} />}

    {kase.unknown.map((card) => <UnknownOutcomeNotice key={card.id} card={card} caseId={kase.id} nextStep={kase.nextStep} onSaved={onChange} />)}
    {open && kase.outdated.slice(-1).map((card) => <OutdatedNotice key={card.id} card={card} redrafting={kase.pending.length === 0} />)}
    {kase.pending.map((card) => <DecisionCard key={card.id} card={card} onDecided={onChange} />)}
    {awaiting.map((card) => <OutcomeBox key={card.id} kase={kase} proposalId={card.id} title={card.title} onSaved={onChange} />)}
    {kase.pending.length === 0 && awaiting.length === 0 && kase.unknown.length === 0 && kase.nextStep && open && <div className="decided-line"><Icon name="waiting" size={16} /><div>
      <b>Next:</b> {kase.nextStep}
      {(kase.waitingOn || kase.nextCheckLabel) && <span className={`decided-wait${kase.overdue ? " overdue" : ""}`}>{kase.waitingOn ? `Waiting on ${kase.waitingOn}` : "Waiting"}{kase.nextCheckLabel ? ` · ${kase.nextCheckLabel}` : ""}</span>}
    </div></div>}
    {kase.pending.length === 0 && awaiting.length === 0 && open && <TellAgent caseId={kase.id} onSent={onChange} startOpen={kase.status === "NEEDS_DECISION" && kase.unknown.length === 0} />}
    {kase.decided.length > 0 && <div className="case-history">
      <h3>Decisions on this case</h3>
      {kase.decided.map((card) => <DecidedCard key={card.id} card={card} />)}
    </div>}
  </section>
}

/** Our cases at the top of the order page, then the merged timeline and the Ask box. */
export function CasePanel({ view, onChange }: { view: RecordView; onChange: () => void }) {
  const open = view.cases.filter((kase) => kase.status !== "RESOLVED" && kase.status !== "HANDLED_BY_AGENT")
  const closed = view.cases.filter((kase) => !open.includes(kase))
  const firstOpened = view.cases.length ? view.cases.map((kase) => kase.openedAt).sort()[0] : null
  return <div className="case-panel" id="case">
    {open.map((kase) => <CaseBlock key={kase.id} kase={kase} view={view} onChange={onChange} />)}
    {closed.length > 0 && <details className="more case-closed">
      <summary><Icon name="chevron" size={12} />Closed cases on this order ({closed.length})</summary>
      {closed.map((kase) => <CaseBlock key={kase.id} kase={kase} view={view} onChange={onChange} />)}
    </details>}
    {view.promise && (view.promise.pending.length > 0 || view.promise.changed) && <PromiseBlock promise={view.promise} onChange={onChange} />}
    <section className="sec" id="timeline" aria-label="Timeline">
      <div className="sec-head"><h2>Timeline</h2><span className="note">Recorded messages and events, with the live case log. Each line names its source.</span></div>
      <Timeline entries={view.timeline} since={firstOpened} />
    </section>
    <AskAgent caseId={open[0]?.id ?? null} orderRef={view.header.reference} />
  </div>
}
