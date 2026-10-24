"use client"

import Link from "next/link"
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

type Filter = "unanswered" | "all" | "unlinked" | "closed"
const FILTERS: { id: Filter; label: string }[] = [
  { id: "unanswered", label: "Waiting on us" }, { id: "all", label: "All open" }, { id: "unlinked", label: "No order yet" }, { id: "closed", label: "Closed" },
]

function matches(thread: InboxThreadView, filter: Filter): boolean {
  if (filter === "unanswered") return thread.unanswered
  if (filter === "all") return thread.status === "OPEN"
  if (filter === "unlinked") return thread.source === "inbox" && thread.linked.length === 0 && thread.linkState !== "NO_ORDER_REQUIRED"
  return thread.status !== "OPEN"
}

/**
 * Every conversation the desk can read and answer, in one reader: the threads filed on orders and the support mail
 * that arrived before an order link was certain. The list classifies each thread (who, about what, over which
 * channel, which order, whether it waits on us); the reader shows one conversation as a chat with the composer.
 */
export default function InboxPage() {
  const [view, setView] = useState<InboxView | null>(null)
  const [error, setError] = useState("")
  const [selected, setSelected] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>("unanswered")
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
      const asked = data.view.threads.find((thread) => thread.id === wanted)
      if (asked) {
        // A deep link from an order opens that thread whatever the filter would show.
        setFilter(asked.unanswered ? "unanswered" : asked.status === "OPEN" ? "all" : "closed")
        setShowList(false)
        return asked.id
      }
      return (data.view.threads.find((thread) => thread.unanswered) ?? data.view.threads[0])?.id ?? null
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
  const shown = useMemo(() => (view?.threads ?? []).filter((item) => matches(item, filter)), [view, filter])
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.id, (view?.threads ?? []).filter((item) => matches(item, f.id)).length])) as Record<Filter, number>, [view])

  const choose = (id: string) => {
    setSelected(id)
    setShowList(false)
    window.history.replaceState(null, "", `#${id}`)
  }

  return <AppFrame section="inbox" snapshotAt={view?.snapshotAt ?? null}><main className={`mailbox${showList ? "" : " reading"}`}>
    <section className="mail-list" aria-label="Conversations">
      <header className="mail-list-head">
        <h1>Inbox</h1>
        <p>{view ? `${counts.unanswered} waiting on us · ${counts.all} open` : "Loading"}</p>
        <div className="mail-filters" role="tablist" aria-label="Which conversations">
          {FILTERS.map((f) => <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}<span className="num">{counts[f.id] ?? 0}</span></button>)}
        </div>
      </header>
      {error && <p className="board-error" role="alert">{error}.</p>}
      {view && shown.length === 0 && <p className="empty mail-empty">{filter === "unanswered" ? "Nothing waits on the desk." : filter === "unlinked" ? "Every thread is linked to an order." : "Nothing here."}</p>}
      <ul className="mail-rows">{shown.map((item) => {
        const lastMessage = item.messages[item.messages.length - 1]
        return <li key={item.id}>
          <button type="button" className={`mail-row${item.id === selected ? " active" : ""}${item.unanswered ? " unanswered" : ""}`} onClick={() => choose(item.id)} aria-current={item.id === selected ? "true" : undefined}>
            <span className="mail-row-top">
              <span className="mail-row-who">{item.counterparty?.name ?? (item.channel === "case_workspace" ? "Internal case workspace" : "Unknown sender")}<small>{item.counterparty?.role ?? (item.channel === "case_workspace" ? "desk notes" : "")}</small></span>
              <span className="mail-row-when">{fmtDay(item.updatedAt)}</span>
            </span>
            <span className="mail-row-subject">{item.categoryLabel}</span>
            <span className="mail-row-tags">
              {item.linked[0] ? <span className="mail-tag mono">{item.linked[0].reference}</span> : <Chip tone={item.linkTone}>{item.linkStateLabel}</Chip>}
              <span className="mail-tag">{item.channelLabel}</span>
              {item.unanswered && <Chip tone="danger">Waiting on us</Chip>}
              {item.status !== "OPEN" && <Chip tone="neutral">{item.statusLabel}</Chip>}
            </span>
            {lastMessage && <span className="mail-row-preview">{lastMessage.author.kind === "operator" || lastMessage.author.kind === "agent" ? "Us: " : ""}{lastMessage.body}</span>}
          </button>
        </li>
      })}</ul>
    </section>
    <section className="mail-read" aria-label="Conversation">
      {!view && !error && <p className="empty">Loading…</p>}
      {view && !thread && <p className="empty">Choose a conversation.</p>}
      {thread && <Thread key={thread.id} thread={thread} onBack={() => setShowList(true)} onChange={refresh} />}
    </section>
  </main></AppFrame>
}

function Thread({ thread, onBack, onChange }: { thread: InboxThreadView; onBack: () => void; onChange: () => void }) {
  const [busy, setBusy] = useState(false)
  const [reference, setReference] = useState("")
  const [toolError, setToolError] = useState("")
  const onOrder = thread.source === "order"
  const order = thread.linked[0] ?? null
  const base = onOrder ? `/api/threads/${encodeURIComponent(thread.id)}` : `/api/inbox/${encodeURIComponent(thread.id)}`
  const update = async (body: Record<string, unknown>) => {
    setBusy(true); setToolError("")
    try { await postJson(base, body, "PATCH"); onChange() }
    catch (cause) { setToolError(cause instanceof Error ? cause.message : "The thread could not be updated.") }
    finally { setBusy(false) }
  }
  const linkTyped = (event: FormEvent) => { event.preventDefault(); if (reference.trim()) void update({ link: reference.trim() }) }
  const theirs = thread.messages.filter((m) => !m.internal && m.author.kind !== "operator" && m.author.kind !== "agent").length
  const ours = thread.messages.filter((m) => !m.internal && (m.author.kind === "operator" || m.author.kind === "agent")).length
  const notes = thread.messages.filter((m) => m.internal).length
  return <article>
    <button type="button" className="mail-back" onClick={onBack}><Icon name="chevron" size={13} style={{ transform: "rotate(180deg)" }} /> All conversations</button>
    <header className="mail-head">
      <h2>{thread.categoryLabel}{thread.counterparty ? <> with {thread.counterparty.name}</> : thread.channel === "case_workspace" ? <> (internal workspace)</> : null}</h2>
      <div className="chips">
        {thread.unanswered ? <Chip tone="danger" dot>Waiting on us</Chip> : thread.status === "OPEN" ? <Chip tone="accent">Open</Chip> : <Chip tone="neutral">{thread.statusLabel}</Chip>}
        {order ? <Chip tone="neutral">Order {order.reference}</Chip> : <Chip tone={thread.linkTone}>{thread.linkStateLabel}</Chip>}
        <Chip tone="neutral">{thread.channelLabel}</Chip>
        {thread.waitingOn && <Chip tone="warn">Waiting on {thread.waitingOn}</Chip>}
      </div>
      <dl className="mail-facts">
        <div><dt>From</dt><dd>{thread.counterparty ? <><ActorName actor={thread.counterparty} /> <span className="muted">({thread.counterparty.role})</span></> : "Unknown"}</dd></div>
        <div><dt>Messages</dt><dd>{theirs} from them · {ours} from us{notes ? ` · ${notes} internal` : ""}</dd></div>
        <div><dt>Owner</dt><dd>{thread.owner ?? "Support desk"}</dd></div>
        <div><dt>Opened</dt><dd><When at={thread.openedAt} withZone={false} /></dd></div>
        {order && <div><dt>Order</dt><dd><Link className="name-link" href={`/orders/${order.id}`}>{order.reference}</Link>{thread.linked.length > 1 && <> · also <OrderLinks orders={thread.linked.slice(1)} /></>}</dd></div>}
        {thread.candidates.length > 0 && !order && <div><dt>Candidates</dt><dd><OrderLinks orders={thread.candidates} /> <span className="muted">hypotheses, not links</span></dd></div>}
        {thread.resolution && <div><dt>Resolution</dt><dd>{thread.resolution.decisionLabel}{thread.resolution.at ? `, ${fmtDateTime(thread.resolution.at)}` : ""}</dd></div>}
      </dl>
      {thread.candidateBasis && <p className="mail-basis"><b>Basis.</b> {thread.candidateBasis}</p>}
      <div className="mail-tools" aria-label="Resolve this thread">
        {!onOrder && !order && <>
          <span className="label">Link to</span>
          {thread.candidates.map((candidate) => <button key={candidate.id} type="button" className="btn small" disabled={busy} onClick={() => void update({ link: candidate.id })}><Icon name="check" size={12} />{candidate.reference}</button>)}
          <form onSubmit={linkTyped}><input value={reference} onChange={(event) => setReference(event.target.value)} placeholder="CD-000000" aria-label="Order reference" /><button type="submit" className="btn small" disabled={busy || !reference.trim()}>Link</button></form>
          {thread.linkState !== "NO_ORDER_REQUIRED" && <button type="button" className="btn small quiet" disabled={busy} onClick={() => void update({ noOrder: true })}>No order needed</button>}
        </>}
        {order && <Link className="btn small" href={`/orders/${order.id}#thread-${thread.id}`}><Icon name="arrow" size={12} />Open the order</Link>}
        {thread.status === "OPEN"
          ? <button type="button" className="btn small quiet" disabled={busy} onClick={() => void update({ status: "CLOSED" })}>Close thread</button>
          : <button type="button" className="btn small quiet" disabled={busy} onClick={() => void update({ status: "OPEN" })}>Reopen</button>}
        {toolError && <span className="composer-error" role="alert">{toolError}</span>}
      </div>
    </header>
    {thread.messages.length > 0 ? <ThreadMessages thread={thread} /> : <p className="empty">No messages filed under this thread.</p>}
    <Composer to={thread.counterparty?.name ?? null} channelLabel={thread.channelLabel} autoFocus={thread.unanswered}
      suggest={(intent) => postJson<Draft>(`${base}/suggest`, onOrder ? { orderId: order?.id, intent } : { intent })}
      send={(body, internal, language) => postJson(`${base}/messages`, { body, internal, language }).then(() => undefined)}
      onSent={onChange} />
  </article>
}
