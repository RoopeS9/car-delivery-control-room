"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import { fmtDateTime, fmtDay } from "@/lib/present/time"
import type { InboxThreadView, InboxView } from "@/lib/present/types"
import { AppFrame } from "../components/app-frame"
import { Composer, postJson, type Draft } from "../components/helpdesk/composer"
import { Icon } from "../components/icons"
import { ThreadMessages } from "../components/record/sections"
import { ActorName, Chip, OrderLinks, When } from "../components/ui"

/** The inbox polls like the other operator pages, so an answer filed here or elsewhere shows up without a reload. */
const POLL_MS = 4000

export default function InboxPage() {
  const [view, setView] = useState<InboxView | null>(null)
  const [error, setError] = useState("")
  const [selected, setSelected] = useState<string | null>(null)
  const [showList, setShowList] = useState(true)
  const last = useRef("")

  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/inbox", { signal, cache: "no-store" })
    if (!response.ok) throw new Error("Could not load the inbox")
    const text = await response.text()
    if (text === last.current) return
    last.current = text
    const data = JSON.parse(text) as { view: InboxView }
    setView(data.view)
    setError("")
    setSelected((current) => {
      if (current && data.view.threads.some((thread) => thread.id === current)) return current
      const wanted = window.location.hash.replace(/^#/, "")
      return (data.view.threads.find((thread) => thread.id === wanted) ?? data.view.threads[0])?.id ?? null
    })
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal).catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load the inbox") })
    const timer = setInterval(() => { if (document.visibilityState === "visible") load(controller.signal).catch(() => { /* the next poll retries */ }) }, POLL_MS)
    return () => { clearInterval(timer); controller.abort() }
  }, [load])

  const refresh = useCallback(() => { void load().catch(() => {}) }, [load])
  const thread = useMemo(() => view?.threads.find((item) => item.id === selected) ?? null, [view, selected])

  const choose = (id: string) => {
    setSelected(id)
    setShowList(false)
    window.history.replaceState(null, "", `#${id}`)
  }

  return <AppFrame section="inbox" snapshotAt={view?.snapshotAt ?? null}><main className={`mailbox${showList ? "" : " reading"}`}>
    <section className="mail-list" aria-label="Support inbox threads">
      <header className="mail-list-head">
        <h1>Support inbox</h1>
        <p>{view ? `${view.open} of ${view.threads.length} open` : "Loading"} · arrived before an order link was certain</p>
      </header>
      {error && <p className="board-error" role="alert">{error}.</p>}
      {view && view.threads.length === 0 && <p className="empty" style={{ padding: "0 20px" }}>Nothing in the inbox.</p>}
      <ul className="mail-rows">{view?.threads.map((item) => {
        const lastMessage = item.messages[item.messages.length - 1]
        const waiting = item.status === "OPEN" && lastMessage && lastMessage.author.kind !== "operator"
        return <li key={item.id}>
          <button type="button" className={`mail-row${item.id === selected ? " active" : ""}${waiting ? " unanswered" : ""}`} onClick={() => choose(item.id)} aria-current={item.id === selected ? "true" : undefined}>
            <span className="mail-row-top">
              <span className="mail-row-who">{item.counterparty?.name ?? "Unknown sender"}</span>
              <span className="mail-row-when">{fmtDay(item.updatedAt)}</span>
            </span>
            <span className="mail-row-subject">{item.categoryLabel}<Chip tone={item.linkTone}>{item.linkStateLabel}</Chip>{waiting && <Chip tone="danger">Unanswered</Chip>}</span>
            {lastMessage && <span className="mail-row-preview">{lastMessage.author.kind === "operator" ? "You: " : ""}{lastMessage.body}</span>}
          </button>
        </li>
      })}</ul>
    </section>
    <section className="mail-read" aria-label="Conversation">
      {!view && !error && <p className="empty">Loading…</p>}
      {view && !thread && <p className="empty">Choose a thread.</p>}
      {thread && <Thread key={thread.id} thread={thread} onBack={() => setShowList(true)} onChange={refresh} />}
    </section>
  </main></AppFrame>
}

function Thread({ thread, onBack, onChange }: { thread: InboxThreadView; onBack: () => void; onChange: () => void }) {
  const [busy, setBusy] = useState(false)
  const [reference, setReference] = useState("")
  const [toolError, setToolError] = useState("")
  const update = async (body: Record<string, unknown>) => {
    setBusy(true); setToolError("")
    try { await postJson(`/api/inbox/${encodeURIComponent(thread.id)}`, body, "PATCH"); onChange() }
    catch (cause) { setToolError(cause instanceof Error ? cause.message : "The thread could not be updated.") }
    finally { setBusy(false) }
  }
  const linkTyped = (event: FormEvent) => { event.preventDefault(); if (reference.trim()) void update({ link: reference.trim() }) }
  const linked = thread.linked.length > 0
  return <article>
    <button type="button" className="mail-back" onClick={onBack}><Icon name="chevron" size={13} style={{ transform: "rotate(180deg)" }} /> All threads</button>
    <header className="mail-head">
      <h2>{thread.categoryLabel}</h2>
      <div className="chips">
        <Chip tone={thread.linkTone}>{thread.linkStateLabel}</Chip>
        <Chip tone={thread.tone}>{thread.statusLabel}</Chip>
      </div>
      <dl className="mail-facts">
        <div><dt>From</dt><dd>{thread.counterparty ? <><ActorName actor={thread.counterparty} /> <span className="muted">({thread.counterparty.role})</span></> : "Unknown"}</dd></div>
        <div><dt>Channel</dt><dd>{thread.channelLabel}</dd></div>
        <div><dt>Owner</dt><dd>{thread.owner ?? "Not recorded"}</dd></div>
        {thread.waitingOn && <div><dt>Waiting on</dt><dd>{thread.waitingOn}</dd></div>}
        <div><dt>Opened</dt><dd><When at={thread.openedAt} withZone={false} /></dd></div>
        {linked && <div><dt>Linked orders</dt><dd><OrderLinks orders={thread.linked} /></dd></div>}
        {thread.candidates.length > 0 && !linked && <div><dt>Candidates</dt><dd><OrderLinks orders={thread.candidates} /> <span className="muted">hypotheses, not links</span></dd></div>}
        {thread.resolution && <div><dt>Resolution</dt><dd>{thread.resolution.decisionLabel}{thread.resolution.at ? `, ${fmtDateTime(thread.resolution.at)}` : ""}</dd></div>}
      </dl>
      {thread.candidateBasis && <p className="mail-basis"><b>Basis.</b> {thread.candidateBasis}</p>}
      <div className="mail-tools" aria-label="Resolve this thread">
        {!linked && <>
          <span className="label">Link to</span>
          {thread.candidates.map((candidate) => <button key={candidate.id} type="button" className="btn small" disabled={busy} onClick={() => void update({ link: candidate.id })}><Icon name="check" size={12} />{candidate.reference}</button>)}
          <form onSubmit={linkTyped}><input value={reference} onChange={(event) => setReference(event.target.value)} placeholder="CD-000000" aria-label="Order reference" /><button type="submit" className="btn small" disabled={busy || !reference.trim()}>Link</button></form>
          {thread.linkState !== "NO_ORDER_REQUIRED" && <button type="button" className="btn small quiet" disabled={busy} onClick={() => void update({ noOrder: true })}>No order needed</button>}
        </>}
        {thread.status === "OPEN"
          ? <button type="button" className="btn small quiet" disabled={busy} onClick={() => void update({ status: "CLOSED" })}>Close thread</button>
          : <button type="button" className="btn small quiet" disabled={busy} onClick={() => void update({ status: "OPEN" })}>Reopen</button>}
        {toolError && <span className="composer-error" role="alert">{toolError}</span>}
      </div>
    </header>
    {thread.messages.length > 0 ? <ThreadMessages thread={thread} /> : <p className="empty">No messages filed under this thread.</p>}
    <Composer to={thread.counterparty?.name ?? null} channelLabel={thread.channelLabel}
      suggest={(intent) => postJson<Draft>(`/api/inbox/${encodeURIComponent(thread.id)}/suggest`, { intent })}
      send={(body, internal, language) => postJson(`/api/inbox/${encodeURIComponent(thread.id)}/messages`, { body, internal, language }).then(() => undefined)}
      onSent={onChange} />
  </article>
}
