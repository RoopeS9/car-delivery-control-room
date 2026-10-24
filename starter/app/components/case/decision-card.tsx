"use client"

import { useState } from "react"
import {
  decisionPath, outcomePath, refreshPath,
  type CaseActionResponse, type DecisionRequest, type DecisionResponse, type LogOutcomeRequest,
} from "@/lib/cr/types"
import type { DecisionCardView, SourceChip } from "@/lib/present/types"
import { Icon } from "../icons"
import { When } from "../ui"
import { OPERATOR } from "./operator"

type CardDecision = DecisionRequest["decision"]
type Mode = "idle" | "edit" | "reject" | "instruct" | "confirm"

export function Sources({ sources }: { sources: SourceChip[] }) {
  if (!sources.length) return null
  return <span className="sources">{sources.map((source) => {
    // The agent often writes the time into the label already ("OBD dongle, 09:01 UTC"); do not repeat it.
    const timed = /\d{1,2}:\d{2}/.test(source.label)
    const body = <>{source.label}{source.at && !timed && <> · <When at={source.at} withZone={false} /></>}</>
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
  // "I'll handle it" records no option unless the operator picked one: the pre-selected
  // recommendation is not a choice they made, and a phone call is not approval to book.
  const [optionTouched, setOptionTouched] = useState(false)
  const [draft, setDraft] = useState(card.draft?.body ?? "")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [done, setDone] = useState<string | null>(null)
  const [fullDraft, setFullDraft] = useState(false)
  const draftLines = card.draft ? card.draft.body.split("\n").length : 0
  const longDraft = !!card.draft && (draftLines > 8 || card.draft.body.length > 600)
  const call = card.draft?.channelLabel === "Phone call"
  const customer = card.draft?.isCustomer ?? card.actionType === "CONTACT_CUSTOMER"
  const driveOn = card.actionType === "CLEAR_TO_CONTINUE"
  const chosen = card.options.find((option) => option.id === optionId) ?? null

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
        decision, decided_by: OPERATOR.id, note: note.trim() || null, option_id: decision === "handle" && !optionTouched ? null : optionId,
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

  async function redraft() {
    setBusy(true)
    setError("")
    try {
      const response = await fetch(refreshPath(card.caseId, card.id), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ by: OPERATOR.id }) })
      const data = await response.json().catch(() => null) as CaseActionResponse | null
      if (!response.ok) throw new Error(data?.error ?? "Could not reach the agent service. The card is unchanged.")
      setDone(data?.next_step ?? "The agent drafts a fresh card from the new facts.")
      onDecided()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not ask for a new draft.")
    } finally {
      setBusy(false)
    }
  }

  if (done) return <div className="decided-line" role="status"><Icon name="check" size={16} /><div><b>Recorded.</b> {done}</div></div>

  return <article className="dcard" data-tone={card.tone} aria-labelledby={`card-${card.id}`}>
    <header className="dcard-head">
      <span className="dcard-eyebrow"><Icon name="proposal" size={13} />{card.choiceOnly ? "The agent needs you to choose" : <>The agent recommends · {card.actionLabel}</>}</span>
      <span className="dcard-rule" title={card.approvalRule}>{customer ? <><Icon name="key" size={12} />Customer contact · needs a person</> : card.choiceOnly ? "Your choice" : "Needs your yes"}</span>
    </header>
    {card.replaces && <div className="dcard-revision">
      <p>Revision {card.revision}: it replaces a version that went out of date{card.replaces.changed.length ? ". What changed:" : "."}</p>
      {card.replaces.changed.length > 0 && <ul>{card.replaces.changed.map((item, index) => <li key={index}>{item.label} → {item.actual ?? "unknown"}</li>)}</ul>}
    </div>}
    {driveOn && <p className="dcard-driveon"><Icon name="alert" size={14} />{card.approvalRule}</p>}
    {card.factsChanged && <div className="dcard-changed" role="note">
      <Icon name="alert" size={14} />
      <span><b>Facts changed since this was drafted:</b> {card.factsChanged.what} at <When at={card.factsChanged.at} withZone={false} />. Check the timeline, or ask for a fresh card.</span>
      <button type="button" className="btn" disabled={busy} onClick={redraft}>Ask the agent to redraft</button>
    </div>}
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

    {(card.options.length > 1 || card.choiceOnly) && <fieldset className="dcard-sec dcard-options">
      <legend>Choose</legend>
      {card.options.map((option) => <label key={option.id} className={`dcard-option${optionId === option.id ? " on" : ""}`}>
        <input type="radio" name={`opt-${card.id}`} checked={optionId === option.id} onChange={() => { setOptionId(option.id); setOptionTouched(true) }} />
        <span><b>{option.label}</b>{option.recommended && <em> · recommended</em>}{option.description && <small>{option.description}</small>}</span>
      </label>)}
    </fieldset>}

    {card.draft && <section className="dcard-sec">
      <h3>{call ? "Talking points for the call" : "Drafted message"} <span className="dcard-to">to {card.draft.toName} ({card.draft.toRole}) · {card.draft.channelLabel}</span></h3>
      {mode === "edit"
        ? <textarea className="dcard-draft-edit" value={draft} onChange={(event) => setDraft(event.target.value)} rows={6} aria-label="Edit the drafted message" />
        : <>
          <blockquote className={`dcard-draft${longDraft && !fullDraft ? " folded" : ""}`}>{card.draft.subject && <b>{card.draft.subject}</b>}{card.draft.body}</blockquote>
          {longDraft && <button type="button" className="show-more" onClick={() => setFullDraft((value) => !value)}>{fullDraft ? "Show less" : "Show the whole message"}</button>}
        </>}
      {customer && <p className="dcard-hint">Nothing reaches the customer until a person says yes.</p>}
    </section>}

    {card.agentDid.length > 0 && <details className="dcard-sec dcard-did">
      <summary><Icon name="chevron" size={12} />What the agent already did ({card.agentDid.length})</summary>
      <ul>{card.agentDid.map((item, index) => <li key={index}>{item}</li>)}</ul>
    </details>}

    {card.evidence.length > 0 && <p className="dcard-evidence">Evidence: <Sources sources={card.evidence} /></p>}

    {!card.choiceOnly && <div className="dcard-next">
      <p><b>If you approve:</b> {card.nextIfApproved}</p>
      <p><b>If you reject:</b> {card.nextIfRejected}</p>
    </div>}

    {(mode === "reject" || mode === "instruct") && <div className="dcard-note">
      <label htmlFor={`note-${card.id}`}>{mode === "reject" ? "Why not? One line, it goes back to the agent." : "What should the agent do instead?"}</label>
      <textarea id={`note-${card.id}`} rows={2} value={note} onChange={(event) => setNote(event.target.value)} autoFocus
        placeholder={mode === "reject" ? "The dealer already called us; wait for their tow." : "Book the tow ourselves and ask the driver to wait in the café."} />
    </div>}

    {error && <p className="dcard-error" role="alert">{error}</p>}

    <div className="dcard-actions">
      {mode === "idle" && card.choiceOnly && <>
        <button type="button" className="btn primary" disabled={busy || !chosen} onClick={() => decide("approve")}>{chosen ? chosen.label : "Choose an option"}</button>
        {/* The options are often things a person does outside the system (call the driver). PLAN 4.2b / scenario F: "I'll handle it", then log what happened. */}
        <button type="button" className="btn" disabled={busy} onClick={() => decide("handle")}>I&apos;ll handle it</button>
        <span className="dcard-spacer" />
        <button type="button" className="btn quiet" disabled={busy} onClick={() => { setMode("instruct"); setError("") }}>Tell the agent instead</button>
      </>}
      {mode === "idle" && !card.choiceOnly && <>
        {driveOn
          ? <button type="button" className="btn primary" disabled={busy} onClick={() => setMode("confirm")}>Clear the driver to drive on…</button>
          : call
          ? <button type="button" className="btn primary" disabled={busy} onClick={() => decide("handle")}>I&apos;ll make the call</button>
          : <button type="button" className="btn primary" disabled={busy} onClick={() => decide("approve")}>{card.actionType === "CHANGE_PROMISE" ? "Approve, send to the customer" : card.draft ? "Approve and send" : "Approve"}</button>}
        {card.draft && <button type="button" className="btn" disabled={busy} onClick={() => setMode("edit")}>{call ? "Edit talking points" : "Edit first"}</button>}
        {!call && !driveOn && <button type="button" className="btn" disabled={busy} onClick={() => decide("handle")}>I&apos;ll handle it</button>}
        <span className="dcard-spacer" />
        <button type="button" className="btn quiet" disabled={busy} onClick={() => { setMode("instruct"); setError("") }}>Tell the agent instead</button>
        <button type="button" className="btn quiet" disabled={busy} onClick={() => { setMode("reject"); setError("") }}>Reject</button>
      </>}
      {mode === "confirm" && <>
        <span className="dcard-confirm">The driver will be told they may drive on, attributed to you. The agent never says this on its own.</span>
        <button type="button" className="btn danger" disabled={busy} onClick={() => decide("approve")}>Yes, clear them to drive on</button>
        <button type="button" className="btn quiet" disabled={busy} onClick={() => setMode("idle")}>Cancel</button>
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
  const d = card.decision ?? (card.outdated ? { by: "Nobody", at: null, note: null, option: null, nextStep: null, executedAt: null, mode: null, outcome: null, reconciled: null } : null)
  if (!d) return null
  const verb = d.reconciled === false ? "checked with the other side: it did not happen"
    : d.reconciled === true ? "checked with the other side: it happened"
    : d.mode === "operator" ? "said they would handle it"
    : d.mode === "instruction" ? "told the agent what to do instead"
    : d.mode === "refresh" ? "set it aside because facts changed"
    : card.outdated ? "approved it, but it went out of date before it ran"
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

/** An approved card that did not run because the facts it relied on changed (PLAN 4.2b). */
export function OutdatedNotice({ card, redrafting }: { card: DecisionCardView; redrafting: boolean }) {
  const changed = card.outdated?.changed ?? []
  return <div className="notice warn" role="status">
    <Icon name="alert" size={15} />
    <div>
      <b>Out of date: {card.title}.</b> Nothing was carried out. {changed.length ? "It relied on facts that changed:" : "The facts it relied on changed since it was drafted."}
      {changed.length > 0 && <ul className="notice-list">{changed.map((item, index) => <li key={index}>{item.label}: <span className="before">{item.expected ?? "not recorded"}</span> → <b>{item.actual ?? "not recorded"}</b></li>)}</ul>}
      <p>{redrafting ? "The agent is drafting a new version from the current facts." : "A new version follows below."}</p>
    </div>
  </div>
}

/** An outside action whose result we do not know. Nothing is retried until someone checks and says whether it exists. */
export function UnknownOutcomeNotice({ card, caseId, nextStep, onSaved }: { card: DecisionCardView; caseId: string; nextStep: string | null; onSaved: () => void }) {
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  async function reconcile(confirmed: boolean) {
    if (!note.trim()) { setError("Say how you checked, in one line. It is kept as the evidence."); return }
    setBusy(true)
    setError("")
    try {
      const body: LogOutcomeRequest = { proposal_id: card.id, text: note.trim(), logged_by: OPERATOR.id, confirmed }
      const response = await fetch(outcomePath(caseId), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      const data = await response.json().catch(() => null) as CaseActionResponse | null
      if (!response.ok) throw new Error(data?.error ?? "Could not reach the agent service. Nothing was saved.")
      setNote("")
      onSaved()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save.")
    } finally {
      setBusy(false)
    }
  }
  return <div className="notice danger" role="alert">
    <Icon name="alert" size={15} />
    <div className="notice-body">
      <b>Outcome unknown: {card.title}.</b> We do not know whether it happened. Nothing will be retried until someone checks with the other side.
      {nextStep && <p><b>Next:</b> {nextStep}</p>}
      <div className="reconcile">
        <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Called them: no booking under that reference" aria-label="How you checked" />
        <button type="button" className="btn" disabled={busy} onClick={() => reconcile(true)}>It exists</button>
        <button type="button" className="btn" disabled={busy} onClick={() => reconcile(false)}>It does not exist</button>
      </div>
      {error && <p className="dcard-error" role="alert">{error}</p>}
    </div>
  </div>
}
