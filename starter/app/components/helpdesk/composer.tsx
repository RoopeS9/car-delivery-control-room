"use client"

import { useEffect, useRef, useState, type KeyboardEvent } from "react"
import type { SuggestResult, Suggestion } from "@/lib/present/helpdesk"
import { Icon } from "../icons"
import "./helpdesk.css"

export type Draft = SuggestResult

const STANCE: Record<Suggestion["stance"], { word: string; tone: string }> = {
  ANSWER: { word: "Answer", tone: "ok" }, ASK: { word: "Ask", tone: "accent" }, HOLD: { word: "Hold", tone: "neutral" },
  ESCALATE: { word: "Needs a person", tone: "danger" }, IDENTIFY: { word: "Identify the order", tone: "accent" },
}

/**
 * The operator's composer: a reply to the other party or an internal note, with drafts from the dossier the operator
 * can take, edit and send. Ctrl+Enter sends. Nothing is sent by itself; a draft is a starting point, never a message.
 */
export function Composer({ to, channelLabel, suggest, send, onSent, autoFocus = false, openingPrompt = false }: {
  /** Who a reply goes to; null when the thread has no known counterparty. */
  to: string | null
  channelLabel: string
  /** Asks the dossier for drafts; `intent` is what the operator has typed so far. */
  suggest: (intent: string) => Promise<Draft>
  send: (body: string, internal: boolean, language: string | null) => Promise<void>
  onSent?: () => void
  autoFocus?: boolean
  /** The composer opens a new conversation (words change: "Open" rather than "Send"). */
  openingPrompt?: boolean
}) {
  const [text, setText] = useState("")
  const [internal, setInternal] = useState(false)
  const [language, setLanguage] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [drafting, setDrafting] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState("")
  const [sent, setSent] = useState("")
  const area = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { if (autoFocus) area.current?.focus() }, [autoFocus])

  const askDrafts = async () => {
    setDrafting(true); setError("")
    try { setDraft(await suggest(text.trim())) }
    catch (cause) { setError(cause instanceof Error ? cause.message : "No drafts right now.") }
    finally { setDrafting(false) }
  }
  const take = (suggestion: Suggestion) => {
    setText(suggestion.body); setInternal(false)
    if (draft) setLanguage(draft.language)
    area.current?.focus()
  }
  const takeNote = () => { if (draft?.internalNote) { setText(draft.internalNote); setInternal(true); area.current?.focus() } }
  const submit = async () => {
    const body = text.trim()
    if (!body || sending) return
    setSending(true); setError("")
    try {
      await send(body, internal, internal ? null : language)
      setText(""); setDraft(null); setLanguage(null)
      setSent(internal ? "Note filed." : openingPrompt ? "Conversation opened." : `Sent to ${to ?? "them"}.`)
      setTimeout(() => setSent(""), 3000)
      onSent?.()
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The message could not be saved.") }
    finally { setSending(false) }
  }
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); void submit() } }

  return <div className={`composer${internal ? " internal" : ""}`}>
    <div className="composer-mode" role="tablist" aria-label="What you are writing">
      <button type="button" role="tab" aria-selected={!internal} onClick={() => setInternal(false)}><Icon name="message" size={13} />{openingPrompt ? "Opening message" : `Reply${to ? ` to ${to}` : ""}`}<small>{channelLabel}</small></button>
      <button type="button" role="tab" aria-selected={internal} onClick={() => setInternal(true)}><Icon name="note" size={13} />Internal note<small>desk only</small></button>
    </div>
    {draft && <div className="drafts" aria-label="Drafts from the dossier">
      <p className="drafts-summary"><Icon name="bot" size={13} /><span>{draft.summary}</span></p>
      <ul className="drafts-list">
        {draft.suggestions.map((suggestion, index) => <li key={index} className="draft">
          <div className="draft-head"><span className={`chip tone-${STANCE[suggestion.stance].tone}`}>{STANCE[suggestion.stance].word}</span><b>{suggestion.label}</b></div>
          <p className="draft-body">{suggestion.body}</p>
          {suggestion.caution && <p className="draft-caution"><Icon name="alert" size={12} />{suggestion.caution}</p>}
          <div className="draft-foot">
            <button type="button" className="btn small" onClick={() => take(suggestion)}>Use this draft</button>
            {suggestion.basis.length > 0 && <span className="draft-basis" title={suggestion.basis.join(", ")}>rests on {suggestion.basis.length === 1 && suggestion.basis[0] === "thread" ? "the thread" : `${suggestion.basis.length} record${suggestion.basis.length === 1 ? "" : "s"}`}</span>}
          </div>
        </li>)}
      </ul>
      {draft.internalNote && <p className="drafts-note"><b>Note for the desk:</b> {draft.internalNote} <button type="button" className="link-btn" onClick={takeNote}>File it</button></p>}
    </div>}
    <textarea ref={area} className="composer-text" rows={internal ? 3 : 4} value={text} onChange={(event) => setText(event.target.value)} onKeyDown={onKey}
      placeholder={internal ? "What the desk should know about this thread. The other party never sees this." : openingPrompt ? "Why the desk is writing, and what you need from them." : `Write to ${to ?? "them"}, or ask for drafts first.`}
      aria-label={internal ? "Internal note" : "Reply"} disabled={sending} />
    <div className="composer-foot">
      <button type="button" className="btn" onClick={() => void askDrafts()} disabled={drafting || sending} title="Drafts written from this order's dossier and the thread. You pick, edit and send.">
        <Icon name="bot" size={14} />{drafting ? "Reading the dossier…" : draft ? "Other drafts" : "Drafts from the dossier"}
      </button>
      <span className="composer-hint">{error ? <span className="composer-error" role="alert">{error}</span> : sent ? <span className="composer-sent"><Icon name="check" size={12} />{sent}</span> : "Ctrl+Enter sends"}</span>
      <button type="button" className="btn primary" onClick={() => void submit()} disabled={!text.trim() || sending}>
        {sending ? "Saving…" : internal ? "File note" : openingPrompt ? "Open conversation" : "Send"}
      </button>
    </div>
  </div>
}

/** POST JSON and read the answer; a non-2xx answer becomes an Error with the server's own words. */
export async function postJson<T>(url: string, body: unknown, method = "POST"): Promise<T> {
  const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" })
  const text = await response.text()
  let data: unknown = null
  try { data = text ? JSON.parse(text) : null } catch { /* not JSON */ }
  if (!response.ok) throw new Error(typeof (data as { error?: unknown })?.error === "string" ? String((data as { error: string }).error) : `The server answered ${response.status}.`)
  return data as T
}
