"use client"

import Link from "next/link"
import { useMemo, useState } from "react"
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
  return <li>
    <Link className="q-row" data-tone={row.tone} href={`/orders/${row.orderId}${row.caseId ? "#case" : ""}`}>
      <span className="q-bar" aria-hidden="true" />
      <MakeMark make={row.vehicleMake} />
      <span className="q-main">
        <span className="q-car"><b>{row.vehicle}</b><span className="q-ref">{row.reference}</span><span className="q-route">{row.route}</span></span>
        <span className="q-headline">{row.headline}</span>
        {row.ask && <span className="q-ask">{row.statusLabel === "Decision waiting" ? <><Icon name="proposal" size={13} />{row.ask}</> : row.ask}</span>}
      </span>
      <span className="q-side">
        {row.who === "Waiting for you"
          ? row.urgencyLabel && <span className={`q-urgency tone-${row.tone}`}>{row.urgencyLabel}</span>
          : <span className="q-status">{row.statusLabel}</span>}
        <span className={`q-who who-${row.whoKind}`}>{row.whoKind === "agent" && <Icon name="bot" size={13} />}{row.who}</span>
        {row.since && <time className="q-age" dateTime={row.since} title={fmtLong(row.since)}>{row.sinceLabel}</time>}
      </span>
    </Link>
  </li>
}

function Group({ title, note, rows, empty }: { title: string; note?: string; rows: QueueRow[]; empty?: string }) {
  if (!rows.length && !empty) return null
  return <section className="q-group" aria-label={title}>
    <div className="q-group-head"><h2>{title}</h2>{rows.length > 0 && <span className="q-count num">{rows.length}</span>}{note && <span className="q-note">{note}</span>}</div>
    {rows.length ? <ul className="q-list">{rows.map((row) => <QueueItem key={row.caseId ?? row.orderId} row={row} />)}</ul> : <p className="q-empty">{empty}</p>}
  </section>
}

function matches(row: QueueRow, query: string): boolean {
  return [row.reference, row.vehicle, row.customer, row.route, row.headline, row.ask ?? ""].some((field) => field.toLowerCase().includes(query))
}

export function QueuePage({ queue }: { queue: QueueView }) {
  const [search, setSearch] = useState("")
  const query = search.trim().toLowerCase()
  const filter = useMemo(() => (rows: QueueRow[]) => query ? rows.filter((row) => matches(row, query)) : rows, [query])
  const decide = filter(queue.decide)
  const working = filter(queue.agentWorking)
  const waiting = filter(queue.waiting)
  const handled = filter(queue.handled)
  const openTotal = queue.decide.length + queue.agentWorking.length + queue.waiting.length
  const nothingOpen = openTotal === 0
  const noMatches = !!query && decide.length + working.length + waiting.length + handled.length === 0

  return <main className="page queue-page">
    <header className="q-head">
      <div>
        <h1>Needs you</h1>
        <p className="q-sub">
          {queue.decide.length > 0
            ? <><b>{queue.decide.length}</b> decision{queue.decide.length > 1 ? "s" : ""} waiting · <b>{queue.agentWorking.length}</b> with the agent · <b>{queue.waiting.length}</b> waiting on others</>
            : nothingOpen ? "Nothing on the road needs a decision right now." : <><b>{queue.agentWorking.length}</b> with the agent · <b>{queue.waiting.length}</b> waiting on others</>}
        </p>
      </div>
      <label className="search">
        <span className="sr-only">Search cases</span>
        <Icon name="search" />
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Reference, car, customer or city" />
        {search && <button type="button" className="search-clear" onClick={() => setSearch("")} aria-label="Clear search"><Icon name="arrow" size={14} style={{ transform: "rotate(45deg)" }} /></button>}
      </label>
    </header>

    {noMatches && <p className="q-empty q-empty-search">No case matches “{search}”. Orders without a case are on <Link href="/board" className="name-link">all orders</Link>.</p>}

    {nothingOpen && !query && <div className="q-calm">
      <Icon name="check" size={18} />
      <div>
        <b>The road is quiet.</b>
        <p>When a driver writes, calls or a car reports a fault, the agent opens a case here. It asks the driver, looks things up, and brings you only the decision.</p>
      </div>
    </div>}

    <Group title="Decide" note="Oldest urgent first" rows={decide} />
    <Group title="Agent working" note="No action needed yet" rows={working} />
    <Group title="Waiting on others" rows={waiting} />

    {handled.length > 0 && <details className="q-handled">
      <summary><Icon name="chevron" size={12} />Handled by the agent today <span className="num">{handled.length}</span></summary>
      <ul className="q-list">{handled.map((row) => <QueueItem key={row.caseId ?? row.orderId} row={row} />)}</ul>
    </details>}

    <p className="q-other">
      {queue.otherCount > 0
        ? <><Link href="/board" className="name-link">{queue.otherCount} other order{queue.otherCount > 1 ? "s" : ""} need a person</Link>{queue.otherReasons.length ? ` (${queue.otherReasons.join(", ")})` : ""}. They are on the board.</>
        : <>No other order in the records needs a person. <Link href="/board" className="name-link">All orders</Link></>}
    </p>
  </main>
}
