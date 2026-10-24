"use client"

import { useEffect, useMemo, useState } from "react"
import { LANES } from "@/lib/present/labels"
import type { Overview } from "@/lib/present/types"
import { AppFrame } from "./components/app-frame"
import { Card } from "./components/card"
import { Icon } from "./components/icons"

export default function Home() {
  const [search, setSearch] = useState("")
  const [onlyAttention, setOnlyAttention] = useState(false)
  const [overview, setOverview] = useState<Overview | null>(null)
  const [error, setError] = useState("")

  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      fetch(`/api/overview?q=${encodeURIComponent(search)}`, { signal: controller.signal })
        .then((response) => { if (!response.ok) throw new Error("Could not load orders"); return response.json() as Promise<Overview> })
        .then((data) => { setOverview(data); setError("") })
        .catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load orders") })
    }, search ? 180 : 0)
    return () => { clearTimeout(timer); controller.abort() }
  }, [search])

  const visible = useMemo(() => {
    const cards = overview?.visible ?? []
    return onlyAttention ? cards.filter((card) => card.attention.length > 0) : cards
  }, [overview, onlyAttention])
  const attentionTotal = overview ? Object.values(overview.attentionCounts).reduce((sum, count) => sum + count, 0) : 0
  const filtering = !!search || onlyAttention
  const lanes = LANES.filter(([lane]) => !filtering || visible.some((card) => card.displayLane === lane))

  return <AppFrame section="board" board snapshotAt={overview?.snapshotAt ?? null}><main className="board-page">
    <div className="board-head">
      <div className="board-title">
        <h1>Orders</h1>
        <p className="board-sub">{overview
          ? <><b>{overview.total}</b> orders · <b>{overview.counts.moving ?? 0}</b> moving · <b>{attentionTotal}</b> need a person</>
          : "Loading the snapshot"}</p>
      </div>
      <div className="board-tools">
        <label className="search">
          <span className="sr-only">Search orders</span>
          <Icon name="search" />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Reference, car, plate, customer or city" />
          {search && <button type="button" className="search-clear" onClick={() => setSearch("")} aria-label="Clear search"><Icon name="arrow" size={14} style={{ transform: "rotate(45deg)" }} /></button>}
        </label>
        <button type="button" className="toggle" aria-pressed={onlyAttention} onClick={() => setOnlyAttention((value) => !value)}>
          <Icon name="alert" size={14} /> Needs a person{overview ? <b>{attentionTotal}</b> : null}
        </button>
      </div>
    </div>
    {error && <p className="board-error" role="alert">{error}. Check that the local database is running and seeded.</p>}
    <section className="board" aria-label="Order lanes">
      {lanes.map(([lane, label]) => {
        const cards = visible.filter((card) => card.displayLane === lane)
        const total = overview?.counts[lane] ?? 0
        const needing = overview?.attentionCounts[lane] ?? 0
        return <div className={`lane lane-${lane}`} key={lane}>
          <header className="lane-head">
            <h2>{label}</h2>
            <span className="lane-count num">{filtering ? `${cards.length} of ${total}` : total}</span>
            {needing > 0 && !onlyAttention && <span className="lane-attention num">{needing} need a person</span>}
          </header>
          <div className="lane-scroll">
            {!overview && !error && <ul className="lane-list" aria-busy="true">{[0, 1, 2].map((index) => <li className="skeleton" key={index} />)}</ul>}
            {overview && cards.length === 0 && <p className="lane-empty">{filtering ? "No matching orders in this lane." : "No orders in this lane."}</p>}
            {cards.length > 0 && <ul className="lane-list">{cards.map((card) => <li key={card.id}><Card card={card} /></li>)}</ul>}
          </div>
        </div>
      })}
      {overview && filtering && visible.length === 0 && <p className="board-empty">
        {search ? <>No orders match “{search}”{onlyAttention ? " among the orders that need a person" : ""}.</> : "No order in the snapshot needs a person."}
      </p>}
    </section>
  </main></AppFrame>
}
