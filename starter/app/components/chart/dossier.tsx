"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import type { ChartNode } from "@/lib/present/chart"
import { STRENGTH_LABEL, type DossierItem, type DossierView } from "@/lib/present/dossier-types"
import { Icon } from "../icons"
import { MakeMark } from "../queue"
import { clockOf, dayOf, relative } from "./format"

const REFRESH_MS = 8000
const BEHIND_FIRST = 10

const KIND_ICON: Record<DossierItem["kind"], string> = {
  step: "flag", deadline: "waiting", ferry: "ferry", travel: "train", quote: "offer", call: "message", agent: "bot",
  message: "message", signal: "alert", event: "dot", telemetry: "pin", decision: "proposal", note: "note",
}

/** The delivery's dossier: who, where it is, and one timeline. Read-only; decisions are made on the order page. */
export function Dossier({ node, onClose }: { node: ChartNode; onClose: () => void }) {
  const [view, setView] = useState<DossierView | null>(null)
  const [error, setError] = useState(false)
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      try {
        const response = await fetch(`/api/chart/order/${encodeURIComponent(node.orderId)}`, { cache: "no-store" })
        if (!response.ok) throw new Error(String(response.status))
        const next = (await response.json()) as DossierView
        if (!stopped) { setView(next); setError(false) }
      } catch {
        if (!stopped) setError(true)
      }
      if (!stopped) timer = setTimeout(load, REFRESH_MS)
    }
    void load()
    return () => { stopped = true; clearTimeout(timer) }
  }, [node.orderId])

  const behind = view ? (showAll ? view.behind : view.behind.slice(0, BEHIND_FIRST)) : []
  return <aside className="dossier" aria-label={`${node.vehicle} ${node.reference}`}>
    <header className="ds-head">
      <MakeMark make={node.make} size={28} />
      <div className="ds-title">
        <h2>{node.vehicle}</h2>
        <p><span className="mono">{node.reference}</span> · {node.from} → {node.to}</p>
      </div>
      <button type="button" className="ds-close" onClick={onClose} aria-label="Close the dossier">×</button>
    </header>
    <dl className="ds-who">
      <div><dt>Customer</dt><dd>{view?.customer ?? node.customer}{view?.customerNote ? <small> · {view.customerNote}</small> : null}</dd></div>
      <div><dt>Driver</dt><dd>{view?.driver ?? node.driver ?? "None booked"}</dd></div>
      <div><dt>Stage</dt><dd>{view?.laneLabel ?? node.laneLabel}</dd></div>
      {view?.plate && <div><dt>Plate</dt><dd className="mono">{view.plate}</dd></div>}
    </dl>

    {!view && !error && <div className="ds-loading" aria-live="polite"><span /><span /><span /></div>}
    {error && !view && <p className="ds-error">The dossier could not be loaded. It will try again in a few seconds.</p>}

    {view && <div className="ds-body">
      <section className={`ds-now tone-edge-${view.tone}`} aria-label="Now">
        <p className="ds-headline">{view.headline}</p>
        {view.position && <p className="ds-pos">
          <Icon name="pin" size={13} />{view.position.label}
          <span className="chip-s s-simulated">{view.position.stale ? `last seen ${view.position.ageLabel}` : view.position.ageLabel} · simulated</span>
          {view.position.speedKmh ? <span className="ds-quiet">{view.position.speedKmh} km/h</span> : null}
        </p>}
        {(view.eta || view.promise) && <div className="ds-times">
          {view.eta && <div><span>ETA</span><b>{view.eta.text}</b><small><StrengthChip strength={view.eta.strength} /> {view.eta.source}</small></div>}
          {view.promise && <div className={view.promise.late ? "late" : undefined}><span>Promise</span><b>{view.promise.text.replace(/^(Delivery promise|Requested delivery) /, "")}</b><small>{view.promise.source}{view.promise.late ? " · at risk" : ""}</small></div>}
        </div>}
      </section>

      <ol className="strip" aria-label="Journey">
        {view.strip.map((point, index) => <li key={`${point.label}-${index}`} className={`sp sp-${point.state}`}>
          <span className="sp-dot" aria-hidden="true" />
          <b>{point.label}</b>
          <span className="sp-place">{point.place}</span>
          {point.note && <small>{point.note}</small>}
        </li>)}
      </ol>

      <section className="tl" aria-label="Timeline">
        {view.ahead.length > 0 && <>
          <h3 className="tl-h">Ahead</h3>
          <ol className="tl-list">{view.ahead.map((item) => <Item key={item.id} item={item} now={view.simNow} />)}</ol>
        </>}
        <div className="tl-now" role="separator"><span>Now · {clockOf(view.simNow)} UTC</span></div>
        {view.decision && <div className="tl-decision">
          <Icon name="proposal" size={14} />
          <div>
            <b>Waiting for a person: {view.decision.title}</b>
            {view.decision.ask && <p>{view.decision.ask}</p>}
            <Link href={view.decision.href}>Decide on the order page<Icon name="arrow" size={12} /></Link>
            {view.decision.sinceLabel && <small>{view.decision.sinceLabel}</small>}
          </div>
        </div>}
        <h3 className="tl-h">Behind <span className="num">{view.behind.length}</span></h3>
        {view.behind.length === 0 ? <p className="ds-quiet">Nothing recorded yet.</p>
          : <ol className="tl-list">{behind.map((item) => <Item key={item.id} item={item} now={view.simNow} />)}</ol>}
        {view.behind.length > BEHIND_FIRST && <button type="button" className="tl-more" onClick={() => setShowAll((all) => !all)}>
          {showAll ? "Show fewer" : `Show ${view.behind.length - BEHIND_FIRST} earlier`}
        </button>}
      </section>
    </div>}

    <footer className="ds-foot">
      <Link className="ds-open" href={`/orders/${node.orderId}`}>Open the full order<Icon name="arrow" size={13} /></Link>
    </footer>
  </aside>
}

function StrengthChip({ strength }: { strength: DossierItem["strength"] }) {
  return <span className={`chip-s s-${strength}`}>{STRENGTH_LABEL[strength]}</span>
}

function Item({ item, now }: { item: DossierItem; now: string }) {
  const [open, setOpen] = useState(false)
  const foldable = !!item.detail && item.detail.length > 140 || !!item.turns?.length
  return <li className={`ti ti-${item.strength} ti-tone-${item.tone}`}>
    <time className="ti-when" dateTime={item.at ?? undefined} title={item.at ? `${dayOf(item.at)} ${clockOf(item.at)} UTC` : undefined}>
      <b>{item.at ? clockOf(item.at) : "–"}</b><span>{item.at ? dayOf(item.at) : ""}</span>
    </time>
    <span className="ti-dot" aria-hidden="true"><Icon name={KIND_ICON[item.kind]} size={12} /></span>
    <div className="ti-main">
      <p className="ti-title">{item.title}</p>
      {item.detail && (!foldable || open) && <p className="ti-detail">{item.detail}</p>}
      {open && item.turns && <ol className="ti-turns">{item.turns.map((turn, index) => <li key={index}><b>{turn.speaker}</b> {turn.text}</li>)}</ol>}
      <p className="ti-src"><StrengthChip strength={item.strength} /><span>{item.source}</span>{item.at && <span className="ti-rel">{relative(item.at, now)}</span>}
        {foldable && <button type="button" className="ti-fold" onClick={() => setOpen((value) => !value)} aria-expanded={open}>{open ? "Less" : item.turns?.length ? "Transcript" : "More"}</button>}
      </p>
    </div>
  </li>
}
