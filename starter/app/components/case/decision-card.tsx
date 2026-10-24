"use client"

import { useState } from "react"
import { decisionPath, type DecisionRequest, type DecisionResponse } from "@/lib/cr/types"
import type { DecisionCardView, SourceChip } from "@/lib/present/types"
import { Icon } from "../icons"
import { When } from "../ui"
import { OPERATOR } from "./operator"

type CardDecision = DecisionRequest["decision"]
type Mode = "idle" | "edit" | "reject" | "instruct"

export function Sources({ sources }: { sources: SourceChip[] }) {
  if (!sources.length) return null
  return <span className="sources">{sources.map((source) => {
    const body = <>{source.label}{source.at && <> · <When at={source.at} withZone={false} /></>}</>
    return source.href
      ? <a key={`${source.kind}-${source.id}`} className="source" href={source.href} title="Show in the timeline">{body}</a>
      : <span key={`${source.kind}-${source.id}`} className="source">{body}</span>
  })}</span>
}

async function send(card: DecisionCardView, body: DecisionRequest): Promise<DecisionResponse> {
  const response = await fetch(decisionPath(card.caseId, card.id), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  })
  const data = await response.json().catch(() => null) as DecisionResponse | null
  if (response.status === 409) throw new Error("Someone already decided this card. The page will refresh.")
  if (!response.ok || !data) throw new Error(data?.error ?? "Could not reach the agent service. Nothing was changed.")
  return data
}

/** One decision the agent brings to a person: what happened, the facts with sources, and the choices. */
export function DecisionCard({ card, onDecided }: { card: DecisionCardView; onDecided: () => void }) {
  const recommended = card.options.find((option) => option.recommended) ?? card.options[0] ?? null
  const [mode, setMode] = useState<Mode>("idle")
  const [optionId, setOptionId] = useState<string | null>(recommended?.id ?? null)
  const [draft, setDraft] = useState(card.draft?.body ?? "")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [done, setDone] = useState<string | null>(null)
  const call = card.draft?.channelLabel === "Phone call"
  const customer = card.draft?.isCustomer ?? card.actionType === "CONTACT_CUSTOMER"

  async function decide(decision: CardDecision) {
    if ((decision === "reject" || decision === "instruct") && !note.trim()) {
      setError(decision === "reject" ? "Write a short reason. It goes back to the agent." : "Write what the agent should do instead.")
      return
    }
    setBusy(true)
    setError("")
    try {
      const edited = mode === "edit" && card.draft && draft.trim() !== card.draft.body.trim()
      const result = await send(card, {
        decision, decided_by: OPERATOR.id, note: note.trim() || null, option_id: optionId,
        edited_draft_message: edited && card.draft ? { ...card.draft.original, body: draft.trim() } : null,
      })
      setDone(result.next_step || (decision === "reject" ? card.nextIfRejected : card.nextIfApproved))
      onDecided()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not record the decision.")
      if (cause instanceof Error && cause.message.startsWith("Someone already")) onDecided()
    } finally {
      setBusy(false)
    }
  }

  if (done) return <div className="decided-line" role="status"><Icon name="check" size={16} /><div><b>Recorded.</b> {done}</div></div>

  return <article className="dcard" data-tone={card.tone} aria-labelledby={`card-${card.id}`}>
    <header className="dcard-head">
      <span className="dcard-eyebrow"><Icon name="proposal" size={13} />The agent recommends · {card.actionLabel}</span>
      <span className="dcard-rule" title={card.approvalRule}>{customer ? <><Icon name="key" size={12} />Customer contact · needs a person</> : "Needs your yes"}</span>
    </header>
    <h2 className="dcard-title" id={`card-${card.id}`}>{card.title}</h2>
    {card.whatHappened && <p className="dcard-what">{card.whatHappened}</p>}
    {card.recommendation && card.recommendation !== card.title && <p className="dcard-rec">{card.recommendation}</p>}

    {card.facts.length > 0 && <section className="dcard-sec">
      <h3>What we know</h3>
      <ul className="dcard-facts">{card.facts.map((fact, index) => <li key={index}><span>{fact.text}</span><Sources sources={fact.sources} /></li>)}</ul>
    </section>}

    {card.unknowns.length > 0 && <section className="dcard-sec">
      <h3>Still unknown</h3>
      <ul className="dcard-unknowns">{card.unknowns.map((item, index) => <li key={index}>{item}</li>)}</ul>
    </section>}

    {card.changes.length > 0 && <section className="dcard-sec">
      <h3>What changes if you approve</h3>
      <dl className="dcard-changes">{card.changes.map((change, index) => <div key={index}>
        <dt>{change.label}</dt>
        <dd><span className="before">{change.before ?? "Not set"}</span><Icon name="arrow" size={13} /><span className="after">{change.after}</span></dd>
      </div>)}</dl>
    </section>}

    {card.options.length > 1 && <fieldset className="dcard-sec dcard-options">
      <legend>Choose</legend>
      {card.options.map((option) => <label key={option.id} className={`dcard-option${optionId === option.id ? " on" : ""}`}>
        <input type="radio" name={`opt-${card.id}`} checked={optionId === option.id} onChange={() => setOptionId(option.id)} />
        <span><b>{option.label}</b>{option.recommended && <em> · recommended</em>}{option.description && <small>{option.description}</small>}</span>
      </label>)}
    </fieldset>}

    {card.draft && <section className="dcard-sec">
      <h3>{call ? "Talking points for the call" : "Drafted message"} <span className="dcard-to">to {card.draft.toName} ({card.draft.toRole}) · {card.draft.channelLabel}</span></h3>
      {mode === "edit"
        ? <textarea className="dcard-draft-edit" value={draft} onChange={(event) => setDraft(event.target.value)} rows={6} aria-label="Edit the drafted message" />
        : <blockquote className="dcard-draft">{card.draft.subject && <b>{card.draft.subject}</b>}{card.draft.body}</blockquote>}
      {customer && <p className="dcard-hint">Nothing reaches the customer until a person says yes.</p>}
    </section>}

    {card.agentDid.length > 0 && <details className="dcard-sec dcard-did">
      <summary><Icon name="chevron" size={12} />What the agent already did ({card.agentDid.length})</summary>
      <ul>{card.agentDid.map((item, index) => <li key={index}>{item}</li>)}</ul>
    </details>}

    {card.evidence.length > 0 && <p className="dcard-evidence">Evidence: <Sources sources={card.evidence} /></p>}

    <div className="dcard-next">
      <p><b>If you approve:</b> {card.nextIfApproved}</p>
      <p><b>If you reject:</b> {card.nextIfRejected}</p>
    </div>

    {(mode === "reject" || mode === "instruct") && <div className="dcard-note">
      <label htmlFor={`note-${card.id}`}>{mode === "reject" ? "Why not? One line, it goes back to the agent." : "What should the agent do instead?"}</label>
      <textarea id={`note-${card.id}`} rows={2} value={note} onChange={(event) => setNote(event.target.value)} autoFocus
        placeholder={mode === "reject" ? "The dealer already called us; wait for their tow." : "Book the tow ourselves and ask the driver to wait in the café."} />
    </div>}

    {error && <p className="dcard-error" role="alert">{error}</p>}

    <div className="dcard-actions">
      {mode === "idle" && <>
        {call
          ? <button type="button" className="btn primary" disabled={busy} onClick={() => decide("handle")}>I&apos;ll make the call</button>
          : <button type="button" className="btn primary" disabled={busy} onClick={() => decide("approve")}>{card.draft ? "Approve and send" : "Approve"}</button>}
        {card.draft && <button type="button" className="btn" disabled={busy} onClick={() => setMode("edit")}>Edit first</button>}
        {call
          ? <button type="button" className="btn" disabled={busy} onClick={() => decide("approve")}>Approve, agent sends it</button>
          : <button type="button" className="btn" disabled={busy} onClick={() => decide("handle")}>I&apos;ll handle it</button>}
        <span className="dcard-spacer" />
        <button type="button" className="btn quiet" disabled={busy} onClick={() => { setMode("instruct"); setError("") }}>Tell the agent instead</button>
        <button type="button" className="btn quiet" disabled={busy} onClick={() => { setMode("reject"); setError("") }}>Reject</button>
      </>}
      {mode === "edit" && <>
        <button type="button" className="btn primary" disabled={busy} onClick={() => decide(call ? "handle" : "approve")}>{call ? "Save and I'll call" : "Approve edited message"}</button>
        <button type="button" className="btn quiet" disabled={busy} onClick={() => { setMode("idle"); setDraft(card.draft?.body ?? "") }}>Cancel</button>
      </>}
      {mode === "reject" && <>
        <button type="button" className="btn danger" disabled={busy} onClick={() => decide("reject")}>Reject and tell the agent why</button>
        <button type="button" className="btn quiet" disabled={busy} onClick={() => { setMode("idle"); setNote(""); setError("") }}>Cancel</button>
      </>}
      {mode === "instruct" && <>
        <button type="button" className="btn primary" disabled={busy} onClick={() => decide("instruct")}>Send to the agent</button>
        <button type="button" className="btn quiet" disabled={busy} onClick={() => { setMode("idle"); setNote(""); setError("") }}>Cancel</button>
      </>}
      <span className="dcard-as">Deciding as {OPERATOR.title}</span>
    </div>
  </article>
}

/** A card after the decision: one line on what was decided and what happens next. */
export function DecidedCard({ card }: { card: DecisionCardView }) {
  const d = card.decision
  if (!d) return null
  const verb = d.mode === "operator" ? "said they would handle it"
    : d.mode === "instruction" ? "told the agent what to do instead"
    : card.status === "REJECTED" ? "rejected it"
    : card.status === "EDITED_AND_APPROVED" ? "approved it with changes"
    : card.status === "FAILED" ? "approved it, but it failed"
    : "approved it"
  return <div className="decided" data-tone={card.tone}>
    <div className="decided-head">
      <Icon name={card.status === "REJECTED" ? "note" : card.status === "FAILED" ? "alert" : "check"} size={14} />
      <span><b>{card.title}</b> · {d.by} {verb}{d.at && <> <When at={d.at} withZone={false} /></>}</span>
    </div>
    {d.option && <p>Chosen: {d.option}</p>}
    {d.note && <p className="decided-note">“{d.note}”</p>}
    {d.outcome && <p>What happened: {d.outcome}</p>}
    {d.nextStep && !d.outcome && <p className="decided-next"><b>Next:</b> {d.nextStep}</p>}
  </div>
}
