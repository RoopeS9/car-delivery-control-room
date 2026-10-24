"use client"

import { useEffect, useMemo, useState } from "react"
import { fmtDateTime, fmtDay } from "@/lib/present/time"
import type { InboxThreadView, InboxView } from "@/lib/present/types"
import { AppFrame } from "../components/app-frame"
import { Icon } from "../components/icons"
import { ActorName, Chip, OrderLinks, When } from "../components/ui"

export default function InboxPage() {
  const [view, setView] = useState<InboxView | null>(null)
  const [error, setError] = useState("")
  const [selected, setSelected] = useState<string | null>(null)
  const [showList, setShowList] = useState(true)

  useEffect(() => {
    const controller = new AbortController()
    fetch("/api/inbox", { signal: controller.signal })
      .then((response) => { if (!response.ok) throw new Error("Could not load the inbox"); return response.json() as Promise<{ view: InboxView }> })
      .then((data) => {
        setView(data.view)
        setError("")
        const wanted = window.location.hash.replace(/^#/, "")
        const first = data.view.threads.find((thread) => thread.id === wanted) ?? data.view.threads[0]
        if (first) setSelected(first.id)
      })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load the inbox") })
    return () => controller.abort()
  }, [])

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
      <ul className="mail-rows">{view?.threads.map((item) => {
        const last = item.messages[item.messages.length - 1]
        return <li key={item.id}>
          <button type="button" className={`mail-row${item.id === selected ? " active" : ""}`} onClick={() => choose(item.id)} aria-current={item.id === selected ? "true" : undefined}>
            <span className="mail-row-top">
              <span className="mail-row-who">{item.counterparty?.name ?? "Unknown sender"}</span>
              <span className="mail-row-when">{fmtDay(item.updatedAt)}</span>
            </span>
            <span className="mail-row-subject">{item.categoryLabel}<Chip tone={item.linkTone}>{item.linkStateLabel}</Chip></span>
            {last && <span className="mail-row-preview">{last.body}</span>}
          </button>
        </li>
      })}</ul>
    </section>
    <section className="mail-read" aria-label="Conversation">
      {!view && !error && <p className="empty">Loading…</p>}
      {view && !thread && <p className="empty">Choose a thread.</p>}
      {thread && <Thread thread={thread} onBack={() => setShowList(true)} />}
    </section>
  </main></AppFrame>
}

function Thread({ thread, onBack }: { thread: InboxThreadView; onBack: () => void }) {
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
        {thread.linked.length > 0 && <div><dt>Linked orders</dt><dd><OrderLinks orders={thread.linked} /></dd></div>}
        {thread.candidates.length > 0 && !thread.linked.length && <div><dt>Candidates</dt><dd><OrderLinks orders={thread.candidates} /> <span className="muted">hypotheses, not links</span></dd></div>}
        {thread.resolution && <div><dt>Resolution</dt><dd>{thread.resolution.decisionLabel}{thread.resolution.at ? `, ${fmtDateTime(thread.resolution.at)}` : ""}</dd></div>}
      </dl>
      {thread.candidateBasis && <p className="mail-basis"><b>Basis.</b> {thread.candidateBasis}</p>}
    </header>
    <div className="messages mail-messages">{thread.messages.map((message) => <div className={`msg${message.internal ? " internal" : message.author.kind === "operator" ? " from-operator" : ""}`} key={message.id}>
      <div className="msg-meta"><b><ActorName actor={message.author} /></b><span className="role">{message.author.role}</span><span>to {message.recipient.name}</span><span>· {message.channelLabel}</span>{message.internal && <span className="msg-tag internal">Internal</span>}<time dateTime={message.at}>{fmtDateTime(message.at)}</time></div>
      <p className="msg-body">{message.body}</p>
    </div>)}</div>
    {thread.messages.length === 0 && <p className="empty">No messages filed under this thread.</p>}
  </article>
}
