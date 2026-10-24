"use client"

import { useState } from "react"
import { askAgentPath, type AskAgentRequest, type AskAgentResponse } from "@/lib/cr/types"
import type { CaseView, RecordView } from "@/lib/present/types"
import { Icon } from "../icons"
import { When } from "../ui"
import { DecidedCard, DecisionCard, Sources } from "./decision-card"
import { OPERATOR } from "./operator"
import { Timeline } from "./timeline"

/** Proposed in PLAN.md 4.2b; stream A owns the route. */
const outcomePath = (caseId: string) => `/api/cases/${caseId}/outcome`

function OutcomeBox({ kase, proposalId, title, onSaved }: { kase: CaseView; proposalId: string; title: string; onSaved: () => void }) {
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  async function save() {
    if (!text.trim()) { setError("Write one line about what happened."); return }
    setBusy(true)
    setError("")
    try {
      const response = await fetch(outcomePath(kase.id), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ proposal_id: proposalId, text: text.trim(), logged_by: OPERATOR.id }),
      })
      if (!response.ok) throw new Error("Could not reach the agent service. Nothing was saved.")
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

    {kase.pending.map((card) => <DecisionCard key={card.id} card={card} onDecided={onChange} />)}
    {awaiting.map((card) => <OutcomeBox key={card.id} kase={kase} proposalId={card.id} title={card.title} onSaved={onChange} />)}
    {kase.pending.length === 0 && awaiting.length === 0 && kase.nextStep && open && <div className="decided-line"><Icon name="waiting" size={16} /><div><b>Next:</b> {kase.nextStep}</div></div>}
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
    <section className="sec" id="timeline" aria-label="Timeline">
      <div className="sec-head"><h2>Timeline</h2><span className="note">Recorded messages and events, with the live case log. Each line names its source.</span></div>
      <Timeline entries={view.timeline} since={firstOpened} />
    </section>
    <AskAgent caseId={open[0]?.id ?? null} orderRef={view.header.reference} />
  </div>
}
