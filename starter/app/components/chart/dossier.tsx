"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import type { ChartNode } from "@/lib/present/chart"
import { STRENGTH_LABEL, type DossierItem, type DossierView } from "@/lib/present/dossier-types"
import { Icon } from "../icons"
import { MakeMark } from "../queue"
import { weekdayClock } from "./format"

const REFRESH_MS = 8000

const KIND_ICON: Record<DossierItem["kind"], string> = {
  step: "flag", deadline: "waiting", ferry: "ferry", travel: "train", quote: "offer", call: "message", agent: "bot",
  message: "message", signal: "alert", event: "dot", telemetry: "pin", decision: "proposal", note: "note",
}

/** The operator's view of one delivery: state, the one thing that needs a person, the journey, what to watch, what people last did. */
export function Dossier({ node, onClose }: { node: ChartNode; onClose: () => void }) {
  const [view, setView] = useState<DossierView | null>(null)
  const [error, setError] = useState(false)

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

  const at = (iso: string | null) => weekdayClock(iso, view?.zone ?? null)
  return <aside className="dossier" aria-label={`${node.vehicle} ${node.reference}`}>
    <header className="ds-head">
      <MakeMark make={node.make} size={28} />
      <div className="ds-title">
        <h2>{node.vehicle}</h2>
        <p><span className="mono">{node.reference}</span> · {node.from} → {node.to}</p>
        <p className="ds-who">{view?.customer ?? node.customer}{(view?.driver ?? node.driver) ? ` · driver ${view?.driver ?? node.driver}` : ""}</p>
      </div>
      <button type="button" className="ds-close" onClick={onClose} aria-label="Close">×</button>
    </header>

    {!view && !error && <div className="ds-loading" aria-live="polite"><span /><span /><span /></div>}
    {error && !view && <p className="ds-error">This delivery could not be loaded. It will try again in a few seconds.</p>}

    {view && <div className="ds-body">
      <p className={`ds-headline tone-edge-${view.tone}`}>{view.headline}</p>

      {view.need ? <section className="ds-need" aria-label="Needs you">
        <b>{view.need.title}</b>
        {view.need.ask && <p>{view.need.ask}</p>}
        <span className="ds-need-foot">
          <Link href={view.need.href}>Open the conversation<Icon name="arrow" size={12} /></Link>
          {view.need.sinceLabel && <span>since {view.need.sinceLabel}</span>}
        </span>
        {view.need.chain && view.need.chain.length > 0 && <details className="ds-fold-inline"><summary>How it got here</summary><ul>{view.need.chain.map((line) => <li key={line}>{line}</li>)}</ul></details>}
      </section> : <p className="ds-calm"><Icon name="check" size={13} />Nothing needs you.</p>}

      {view.fault && <section className="ds-fault" aria-label="Fault reported by the car">
        <h3>The car reports a fault <span>OBD dongle, simulated{view.fault.when ? ` · ${view.fault.when}` : ""}</span></h3>
        {view.fault.lamp && <p className="fault-lamp">{view.fault.lamp}</p>}
        {view.fault.codes.length > 0 && <ul className="fault-codes">{view.fault.codes.map((code) => <li key={code.code} className={`tone-${code.tone}`}>
          <span className="mono">{code.code}</span> {code.title ?? "Code not in the guide"}{code.severity ? <small> · {code.severity.toLowerCase()}</small> : null}
        </li>)}</ul>}
        {view.fault.freezeSpeed && <p className="fault-line">Speed at the fault: {view.fault.freezeSpeed}</p>}
        <p className="fault-line">{view.fault.atPickup}</p>
        <p className="fault-note">A trouble code is a signal from the car, not a diagnosis.</p>
      </section>}

      <ol className="strip" aria-label="Journey">
        {view.strip.map((point, index) => <li key={`${point.label}-${index}`} className={`sp sp-${point.state}`}>
          <span className="sp-dot" aria-hidden="true" />
          <b>{point.label}</b>
          <span className="sp-place">{point.place}</span>
          {point.note && <small>{point.note}</small>}
        </li>)}
      </ol>

      {view.watching.length > 0 && <section className="ds-sec" aria-label="Watching">
        <h3>Watching</h3>
        <ul className="watch">{view.watching.map((item) => <li key={item.id} className={`watch-${item.tone}`}>
          <details>
            <summary><span className="watch-dot" aria-hidden="true" />{item.text}</summary>
            <div className="watch-why">
              <p>{item.why}</p>
              {item.sources.length > 0 && <ul>{item.sources.map((source) => <li key={source}>{source}</li>)}</ul>}
            </div>
          </details>
        </li>)}</ul>
      </section>}

      <section className="ds-sec" aria-label="Recent">
        <h3>Recent</h3>
        {view.recent.length === 0 ? <p className="ds-quiet">Nobody has said or done anything on this order yet.</p>
          : <ul className="recent">{view.recent.map((item) => <li key={item.id}><time dateTime={item.at}>{at(item.at)}</time><span>{item.text}</span></li>)}</ul>}
      </section>

      <details className="ds-fold">
        <summary><Icon name="chevron" size={12} />Full history <span className="num">{view.ahead.length + view.behind.length}</span></summary>
        {view.ahead.length > 0 && <><h4>Coming up</h4><ol className="tl-list">{view.ahead.map((item) => <Item key={item.id} item={item} at={at} />)}</ol></>}
        <h4>What happened</h4>
        <ol className="tl-list">{view.behind.map((item) => <Item key={item.id} item={item} at={at} />)}</ol>
      </details>

      <details className="ds-fold">
        <summary><Icon name="chevron" size={12} />Full dossier <span className="num">{view.records.reduce((sum, group) => sum + group.items.length, 0)}</span></summary>
        <p className="ds-quiet">Every record on this order{view.recordsFromService ? ", typed by the dossier service" : ""}, with how strong it is as evidence.</p>
        {view.records.map((group) => <div key={group.label} className="rec-group">
          <h4>{group.label}</h4>
          <ul>{group.items.map((item, index) => <li key={index}><span>{item.label}</span>{item.when && <time>{item.when}</time>}{item.strength && <span className="rec-strength">{item.strength}</span>}</li>)}</ul>
        </div>)}
      </details>
    </div>}

    <footer className="ds-foot">
      <Link className="ds-open" href={view?.conversationHref ?? `/orders/${node.orderId}`}>Open the full order<Icon name="arrow" size={13} /></Link>
    </footer>
  </aside>
}

/** One history line: time, what, and one source chip. Long text, call answers and transcripts fold. */
function Item({ item, at }: { item: DossierItem; at: (iso: string | null) => string }) {
  const [open, setOpen] = useState(false)
  const foldable = !!item.detail || !!item.turns?.length || !!item.slots?.length
  const [day, clock] = item.at ? at(item.at).split(" ") : ["", "–"]
  return <li className={`ti ti-${item.strength} ti-tone-${item.tone}`}>
    <time className="ti-when" dateTime={item.at ?? undefined}><b>{clock}</b><span>{day}</span></time>
    <span className="ti-dot" aria-hidden="true"><Icon name={KIND_ICON[item.kind]} size={12} /></span>
    <div className="ti-main">
      <p className="ti-title">{item.title}</p>
      {open && item.detail && <p className="ti-detail">{item.detail}</p>}
      {open && item.escalated && <p className="ti-escalated"><Icon name="alert" size={12} />Handed to an operator: {item.escalated}</p>}
      {open && item.slots && item.slots.length > 0 && <ul className="ti-slots">{item.slots.map((slot) => <li key={`${slot.label}-${slot.turn}`}>
        <b>{slot.label}: {slot.value}</b> <q>{slot.quote}</q> <span>turn {slot.turn}</span>
      </li>)}</ul>}
      {open && item.missing && item.missing.length > 0 && <p className="ti-missing">Not established: {item.missing.join(", ")}</p>}
      {open && item.turns && <ol className="ti-turns">{item.turns.map((turn, index) => <li key={index}><b>{turn.speaker}</b> {turn.text}</li>)}</ol>}
      <p className="ti-src"><span className={`chip-s s-${item.strength}`}>{STRENGTH_LABEL[item.strength]}</span><span>{item.source}</span>
        {foldable && <button type="button" className="ti-fold" onClick={() => setOpen((value) => !value)} aria-expanded={open}>{open ? "Less" : item.turns?.length ? "Transcript" : "More"}</button>}
      </p>
    </div>
  </li>
}
