"use client"

import { useState } from "react"
import {
  decisionPath, outcomePath, refreshPath,
  type CaseActionResponse, type DecisionRequest, type DecisionResponse, type LogOutcomeRequest,
} from "@/lib/cr/types"
import type { DecisionCardView, SourceChip } from "@/lib/present/types"
import { fmtMoney } from "@/lib/present/time"
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
      ? <a key={`${source.kind}-${source.id}`} className="source" href={source.href} title="Show the source">{body}</a>
      : <span key={`${source.kind}-${source.id}`} className="source">{body}</span>
  })}</span>
}

async function send(card: DecisionCardView, body: DecisionRequest): Promise<DecisionResponse> {
  const response = await fetch(decisionPath(card.caseId, card.id), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  })
  const data = await response.json().catch(() => null) as DecisionResponse | null
  if (response.status === 409) throw new Error(data?.error ?? "Someone already decided this card. The page will refresh.")
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
  const call = card.actionType !== "BOOK_TRAVEL" && card.draft?.channelLabel === "Phone call"
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

  const details = card.facts.length + card.unknowns.length + card.agentDid.length + card.evidence.length
  return <article className="dcard" data-tone={card.tone} aria-labelledby={`card-${card.id}`}>
    <header className="dcard-head">
      <span className="dcard-eyebrow"><Icon name="proposal" size={13} />{card.choiceOnly ? "Your choice" : customer ? "Customer contact: needs a person" : driveOn ? "Clearance: needs a person" : `Needs your yes · ${card.actionLabel}`}</span>
      {card.replaces && <span className="dcard-rule" title={card.replaces.changed.map((item) => `${item.label} → ${item.actual ?? "unknown"}`).join("; ")}>Revision {card.revision}</span>}
    </header>
    {card.factsChanged && <div className="dcard-changed" role="note">
      <Icon name="alert" size={14} />
      <span><b>Facts changed since this was drafted:</b> {card.factsChanged.what} at <When at={card.factsChanged.at} withZone={false} />.</span>
      <button type="button" className="btn" disabled={busy} onClick={redraft}>Ask the agent to redraft</button>
    </div>}
    <h2 className="dcard-title" id={`card-${card.id}`}>{card.title}</h2>
    {card.whatHappened && <p className="dcard-what">{card.whatHappened}</p>}
    {card.recommendation && card.recommendation !== card.title && card.recommendation !== card.whatHappened && <p className="dcard-rec"><b>Recommended:</b> {card.recommendation}</p>}
    {driveOn && <p className="dcard-driveon"><Icon name="alert" size={14} />{card.approvalRule}</p>}

    {card.booking && <section className="dcard-sec">
      <h3>Selected {card.booking.kind.toLowerCase()} quote · simulated</h3>
      <p>{card.booking.provider}: {card.booking.from} → {card.booking.to}</p>
      <dl className="dcard-changes">
        <div><dt>Departure</dt><dd>{card.booking.departureAt ? <When at={card.booking.departureAt} zone="UTC" /> : "Not recorded"}</dd></div>
        <div><dt>Arrival</dt><dd>{card.booking.arrivalAt ? <When at={card.booking.arrivalAt} zone="UTC" /> : "Not recorded"}</dd></div>
        <div><dt>Check-in cutoff</dt><dd>{card.booking.checkInCutoffAt ? <When at={card.booking.checkInCutoffAt} zone="UTC" /> : "Not recorded"}</dd></div>
        <div><dt>Quoted price</dt><dd>{fmtMoney(card.booking.priceAmount * 100, card.booking.currency)}</dd></div>
        <div><dt>Replaces</dt><dd>{card.booking.replaces ?? "No existing reservation"}</dd></div>
      </dl>
      <p className="dcard-hint">Quote checked <When at={card.booking.quotedAt} zone="UTC" />. Approval requests this exact option; it becomes the current booking after confirmation.</p>
      <Sources sources={[card.booking.source]} />
    </section>}

    {card.changes.length > 0 && <section className="dcard-sec">
      <h3>What changes if you approve</h3>
      <dl className="dcard-changes">{card.changes.map((change, index) => <div key={index}>
        <dt>{change.label}</dt>
        <dd><span className="before">{change.before ?? "Not set"}</span><Icon name="arrow" size={13} /><span className="after">{change.after}</span></dd>
      </div>)}</dl>
    </section>}

    {card.actionType !== "BOOK_TRAVEL" && (card.options.length > 1 || card.choiceOnly) && <fieldset className="dcard-sec dcard-options">
      <legend>Choose</legend>
      {card.options.map((option) => <label key={option.id} className={`dcard-option${optionId === option.id ? " on" : ""}`}>
        <input type="radio" name={`opt-${card.id}`} checked={optionId === option.id} onChange={() => { setOptionId(option.id); setOptionTouched(true) }} />
        <span><b>{option.label}</b>{option.recommended && <em> · recommended</em>}{option.description && <small>{option.description}</small>}</span>
      </label>)}
    </fieldset>}

    {/* The message as it would sit in the conversation: our bubble, to them, not sent yet. Editing happens in the bubble. */}
    {card.draft && <div className="chat dcard-chat" aria-label={call ? "Talking points for the call" : "The message, not sent yet"}>
      <div className="chat-line chat-ours">
        <div className="chat-who"><b>{OPERATOR.title}</b><span>to {card.draft.toName} ({card.draft.toRole}) · {card.draft.channelLabel}</span><span className="msg-tag">{call ? "Talking points" : "Draft, not sent"}</span></div>
        {mode === "edit"
          ? <textarea className="dcard-draft-edit" value={draft} onChange={(event) => setDraft(event.target.value)} rows={Math.min(12, Math.max(4, draft.split("\n").length + 1))} aria-label="Edit the message" autoFocus />
          : <div className={`chat-bubble${longDraft && !fullDraft ? " folded" : ""}`}><p className="msg-body">{card.draft.subject && <b>{card.draft.subject}{"\n"}</b>}{card.draft.body}</p></div>}
        {longDraft && mode !== "edit" && <button type="button" className="show-more" onClick={() => setFullDraft((value) => !value)}>{fullDraft ? "Show less" : "Show the whole message"}</button>}
      </div>
    </div>}

    {details > 0 && <details className="dcard-details">
      <summary><Icon name="chevron" size={12} />What the agent found ({details})</summary>
      {card.facts.length > 0 && <section className="dcard-sec"><h3>What we know</h3><ul className="dcard-facts">{card.facts.map((fact, index) => <li key={index}><span>{fact.text}</span>{fact.sources.length ? <Sources sources={fact.sources} /> : <span className="sources"><span className="source unsourced" title="The agent gave no record for this line">no source given</span></span>}</li>)}</ul></section>}
      {card.unknowns.length > 0 && <section className="dcard-sec"><h3>Still unknown</h3><ul className="dcard-unknowns">{card.unknowns.map((item, index) => <li key={index}>{item}</li>)}</ul></section>}
      {card.agentDid.length > 0 && <section className="dcard-sec"><h3>What the agent already did</h3><ul>{card.agentDid.map((item, index) => <li key={index}>{item}</li>)}</ul></section>}
      {card.evidence.length > 0 && <p className="dcard-evidence">Evidence: <Sources sources={card.evidence} /></p>}
      {!card.choiceOnly && <div className="dcard-next"><p><b>If you approve:</b> {card.nextIfApproved}</p><p><b>If you reject:</b> {card.nextIfRejected}</p></div>}
    </details>}

    {(mode === "reject" || mode === "instruct") && <div className="dcard-note">
      <label htmlFor={`note-${card.id}`}>{mode === "reject" ? "Why not? One line, it goes back to the agent." : "What should the agent do instead?"}</label>
      <textarea id={`note-${card.id}`} rows={2} value={note} onChange={(event) => setNote(event.target.value)} autoFocus
        placeholder={mode === "reject" ? "The dealer already called us; wait for their tow." : "Book the tow ourselves and ask the driver to wait in the café."} />
    </div>}

    {error && <p className="dcard-error" role="alert">{error}</p>}

    <div className="dcard-actions">
      {mode === "idle" && card.choiceOnly && <>
        <button type="button" className="btn primary" disabled={busy || !chosen} onClick={() => decide("approve")}>{chosen ? chosen.label : "Choose an option"}</button>
        <button type="button" className="btn" disabled={busy} onClick={() => decide("handle")}>I&apos;ll handle it</button>
        <span className="dcard-spacer" />
        <button type="button" className="btn quiet" disabled={busy} onClick={() => { setMode("instruct"); setError("") }}>Tell the agent instead</button>
      </>}
      {mode === "idle" && !card.choiceOnly && <>
        {driveOn
          ? <button type="button" className="btn primary" disabled={busy} onClick={() => setMode("confirm")}>Clear the driver to drive on…</button>
          : call
          ? <button type="button" className="btn primary" disabled={busy} onClick={() => decide("handle")}>I&apos;ll make the call</button>
          : <button type="button" className="btn primary" disabled={busy} onClick={() => decide("approve")}>{card.actionType === "CHANGE_PROMISE" ? "Approve, send to the customer" : card.draft ? "Send" : "Approve"}</button>}
        {card.draft && <button type="button" className="btn" disabled={busy} onClick={() => setMode("edit")}>{call ? "Edit talking points" : "Edit"}</button>}
        {!call && !driveOn && card.actionType !== "BOOK_TRAVEL" && <button type="button" className="btn" disabled={busy} onClick={() => decide("handle")}>I&apos;ll handle it</button>}
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
        <button type="button" className="btn primary" disabled={busy} onClick={() => decide(call ? "handle" : "approve")}>{call ? "Save and I'll call" : "Send as edited"}</button>
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
    : card.editedDraft || card.status === "EDITED_AND_APPROVED" ? "approved it with changes"
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
    {/* What went out is the operator's version, not the agent's draft: keep both findable. */}
    {card.editedDraft && <details className="more">
      <summary><Icon name="chevron" size={12} />{card.draft?.channelLabel === "Phone call" ? "The talking points as edited" : "The message as edited"}</summary>
      <blockquote className="dcard-draft">{card.editedDraft.subject && <b>{card.editedDraft.subject}</b>}{card.editedDraft.body}</blockquote>
    </details>}
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
