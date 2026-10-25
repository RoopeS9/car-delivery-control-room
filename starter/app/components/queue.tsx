"use client"

import Link from "next/link"
import { type ReactNode, useMemo, useState } from "react"
import { fmtLong } from "@/lib/present/time"
import type { QueueRow, QueueView } from "@/lib/present/types"
import { Icon } from "./icons"

function makeSlug(value: string | null): string | null {
  return value ? value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") : null
}

/** The car maker's mark, drawn in the current text colour so it follows the theme. */
export function MakeMark({ make, size = 22 }: { make: string | null; size?: number }) {
  const slug = makeSlug(make)
  if (!slug) return <span className="make-mark empty" style={{ width: size, height: size }} aria-hidden="true" />
  return <span className="make-mark" aria-hidden="true" style={{ width: size, height: size, WebkitMaskImage: `url(/car-logos/${slug}.svg)`, maskImage: `url(/car-logos/${slug}.svg)` }} />
}

function QueueItem({ row }: { row: QueueRow }) {
  const records = row.origin === "records"
  return <li>
    <Link className={`q-row${records ? " q-records" : ""}`} data-tone={row.tone} href={`/orders/${row.orderId}${row.caseId ? "#case" : records ? "#attention" : ""}`}>
      <span className="q-bar" aria-hidden="true" />
      <MakeMark make={row.vehicleMake} />
      <span className="q-main">
        <span className="q-car"><b>{row.vehicle}</b><span className="q-ref">{row.reference}</span><span className="q-route">{row.route}</span></span>
        <span className="q-headline">{row.headline}</span>
        {row.ask && <span className="q-ask">{row.statusLabel === "Decision waiting" && <Icon name="proposal" size={13} />}{row.ask}</span>}
        {records && row.reasons.length > 1 && <span className="q-reasons">Also: {row.reasons.slice(1).map((reason) => `${reason.text} (${reason.source.toLowerCase()})`).join(" · ")}{row.more ? ` · ${row.more}` : ""}</span>}
        {(row.waitingOn || row.nextCheckLabel) && !records && (row.who !== "Waiting for you" || row.overdue) && <span className={`q-wait${row.overdue ? " overdue" : ""}`}><Icon name="waiting" size={13} />{row.waitingOn ? `Waiting on ${row.waitingOn}` : "Waiting"}{row.nextCheckLabel ? ` · ${row.nextCheckLabel}` : ""}</span>}
        {records && row.nextCheckLabel && <span className={`q-wait${row.overdue ? " overdue" : ""}`}><Icon name="waiting" size={13} />{row.nextCheckLabel}</span>}
        <span className="q-foot">
          {records ? <><span className="q-origin">From the records · {row.reasons[0]?.source ?? "record"}</span>{row.reasons.length <= 1 && row.more && <span className="q-more">{row.more}</span>}</> : row.more && <span className="q-more">{row.more}</span>}
        </span>
      </span>
      <span className="q-side">
        {row.who === "Waiting for you"
          ? row.urgencyLabel && <span className="q-urgency" data-tone={row.tone}>{row.urgencyLabel}</span>
          : !records && !row.waitingOn && !row.nextCheckLabel && <span className="q-status">{row.statusLabel}</span>}
        <span className={`q-who who-${row.whoKind}`}>{row.whoKind === "agent" && <Icon name="bot" size={13} />}{row.who}</span>
        {row.since && row.sinceLabel && <time className="q-age" dateTime={row.since} title={fmtLong(row.since)}>{row.sinceLabel}</time>}
      </span>
    </Link>
  </li>
}

function Group({ title, note, rows, empty, children }: { title: string; note?: string; rows: QueueRow[]; empty?: string; children?: ReactNode }) {
  if (!rows.length && !empty && !children) return null
  return <section className="q-group" aria-label={title}>
    <div className="q-group-head"><h2>{title}</h2>{rows.length > 0 && <span className="q-count num">{rows.length}</span>}{note && <span className="q-note">{note}</span>}</div>
    {rows.length ? <ul className="q-list">{rows.map((row) => <QueueItem key={row.caseId ?? row.orderId} row={row} />)}</ul> : empty ? <p className="q-empty">{empty}</p> : null}
    {children}
  </section>
}

function matches(row: QueueRow, query: string): boolean {
  return [row.reference, row.vehicle, row.customer, row.route, row.headline, row.ask ?? "", ...row.reasons.map((reason) => reason.text)]
    .some((field) => field.toLowerCase().includes(query))
}

export function QueuePage({ queue }: { queue: QueueView }) {
  const [search, setSearch] = useState("")
  const query = search.trim().toLowerCase()
  const filter = useMemo(() => (rows: QueueRow[]) => query ? rows.filter((row) => matches(row, query)) : rows, [query])
  const decide = filter(queue.decide)
  const watch = filter(queue.watch)
  const routine = filter(queue.routine)
  const working = filter(queue.agentWorking)
  const waiting = filter(queue.waiting)
  const handled = filter(queue.handled)
  const fromAgent = queue.decide.filter((row) => row.origin === "agent").length
  const noMatches = !!query && decide.length + watch.length + routine.length + working.length + waiting.length + handled.length === 0

  return <main className="page queue-page">
    <header className="q-head">
      <div>
        <h1>Needs you</h1>
        <p className="q-sub">
          <b>{queue.decide.length}</b> need{queue.decide.length === 1 ? "s" : ""} your decision{fromAgent ? <> ({fromAgent} with the agent&apos;s card ready)</> : null} · <b>{queue.agentWorking.length}</b> with the agent · <b>{queue.watch.length}</b> worth a look · <b>{queue.waiting.length}</b> waiting
        </p>
      </div>
      <label className="search">
        <span className="sr-only">Search the queue</span>
        <Icon name="search" />
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Reference, car, customer or city" />
        {search && <button type="button" className="search-clear" onClick={() => setSearch("")} aria-label="Clear search"><Icon name="arrow" size={14} style={{ transform: "rotate(45deg)" }} /></button>}
      </label>
    </header>

    {noMatches && <p className="q-empty q-empty-search">Nothing in the queue matches “{search}”. Quiet orders are on <Link href="/board" className="name-link">all orders</Link>.</p>}

    <Group title="Needs your decision" note="Earliest first" rows={decide} empty={query ? undefined : "Nothing needs your decision right now."}>
      {routine.length > 0 && <details className="q-routine" open={!!query}>
        <summary><Icon name="chevron" size={12} />{routine.length} more from the records with routine open items <span>(open conversations, unverified pickup details, owned work)</span></summary>
        <ul className="q-list">{routine.map((row) => <QueueItem key={row.orderId} row={row} />)}</ul>
      </details>}
    </Group>
    <Group title="Agent working" note="No action needed yet" rows={working} />
    <Group title="Worth a look" note="Signals in the records; nothing waits on a person yet" rows={watch} />
    <Group title="Waiting" note="Soonest check first" rows={waiting} />

    {handled.length > 0 && <details className="q-handled">
      <summary><Icon name="chevron" size={12} />Handled by the agent today <span className="num">{handled.length}</span></summary>
      <ul className="q-list">{handled.map((row) => <QueueItem key={row.caseId ?? row.orderId} row={row} />)}</ul>
    </details>}

    <p className="q-other"><Link href="/board" className="name-link">{queue.quietCount} order{queue.quietCount === 1 ? "" : "s"} quiet</Link>: nothing open in the records and no case. A quiet order is not verified safe; it means nothing is waiting on a person.</p>
  </main>
}
