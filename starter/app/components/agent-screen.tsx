"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import { fmtClock, fmtLong, relativeTo } from "@/lib/present/time"
import type { AgentPageView, InlineRun, PlaybookView } from "@/lib/present/types"
import { Icon } from "./icons"

function Runs({ runs }: { runs: InlineRun[] }) {
  return <>{runs.map((run, index) => run.bold ? <b key={index}>{run.text}</b>
    : run.italic ? <em key={index}>{run.text}</em>
    : run.term ? <span key={index} className="term">{run.text}</span>
    : <span key={index}>{run.text}</span>)}</>
}

function Playbook({ playbook }: { playbook: PlaybookView }) {
  return <article className="playbook" id={`pb-${playbook.slug}`}>
    <h3>{playbook.title}</h3>
    {playbook.intro && <p className="playbook-intro">{playbook.intro}</p>}
    {playbook.blocks.map((block, index) => {
      if (block.type === "h2") return <h4 key={index}>{block.text}</h4>
      if (block.type === "p") return <p key={index}><Runs runs={block.runs} /></p>
      const List = block.type === "ol" ? "ol" : "ul"
      return <List key={index} className={`pb-${block.type}`}>{block.items.map((item, itemIndex) => <li key={itemIndex}><Runs runs={item} /></li>)}</List>
    })}
  </article>
}

const ALONE = [
  "Reads the order, the timeline and the car's telemetry",
  "Asks drivers, and pickup places that are not the customer",
  "Gives a safety instruction at once: stop, switch off, stay safe",
  "Looks up trouble codes, warning lights, nearby help and travel quotes",
  "Answers routine driver questions and closes them",
]
const NEVER = [
  "Contacts a customer on its own, even to reply",
  "Tells a driver it is fine to keep driving",
  "Treats a quote as a booking or an alert as a diagnosis",
  "Retries an outside action whose outcome is unknown",
]

export function AgentScreen({ view }: { view: AgentPageView }) {
  const [slug, setSlug] = useState(view.playbooks[0]?.slug ?? "")
  useEffect(() => {
    const fromHash = window.location.hash.replace(/^#pb-/, "")
    if (fromHash && view.playbooks.some((playbook) => playbook.slug === fromHash)) setSlug(fromHash)
  }, [view.playbooks])
  const selected = view.playbooks.find((playbook) => playbook.slug === slug) ?? view.playbooks[0] ?? null
  const asks = view.autonomy.filter((row) => row.level === "ASK_FIRST")

  return <main className="page agent-page">
    <header className="agent-head">
      <h1>How the agent works</h1>
      <p>The Road Desk agent takes the cases that start on the road. It does the cheap work first, reading, asking and looking things up, and then either finishes a routine job or brings you one clear decision.</p>
    </header>

    <section className="agent-rules" aria-label="What the agent may do">
      <div className="rule-col">
        <h2><Icon name="check" size={14} />Does alone</h2>
        <ul>{ALONE.map((item) => <li key={item}>{item}</li>)}</ul>
      </div>
      <div className="rule-col">
        <h2><Icon name="proposal" size={14} />Asks you first</h2>
        <ul>{(asks.length ? asks.map((row) => row.label) : ["Every change: bookings, dates, costs, customer messages"]).map((item) => <li key={item}>{item}</li>)}</ul>
      </div>
      <div className="rule-col never">
        <h2><Icon name="alert" size={14} />Never</h2>
        <ul>{NEVER.map((item) => <li key={item}>{item}</li>)}</ul>
      </div>
    </section>

    <section className="sec" aria-label="Autonomy levels">
      <div className="sec-head"><h2>How much it may do alone</h2><span className="note">Read only in this prototype. A level can grow as the agent earns trust.</span></div>
      {view.autonomy.length === 0 ? <p className="empty">The autonomy settings could not be read. Every action asks first.</p>
        : <div className="autonomy">{view.autonomy.map((row) => <div className="autonomy-row" key={row.actionType}>
          <div className="autonomy-main"><b>{row.label}</b><small>{row.meaning}</small></div>
          <div className="autonomy-level">
            <span className="levels" aria-label={`Level: ${row.levelLabel}`}>
              {["ASK_FIRST", "DO_AND_TELL", "AUTO"].map((level) => <span key={level} className={`level${row.level === level ? " on" : ""}`}>{level === "ASK_FIRST" ? "Asks first" : level === "DO_AND_TELL" ? "Does, then tells" : "Alone"}</span>)}
            </span>
            {row.locked && <small className="locked"><Icon name="key" size={12} />Always asks. This cannot be changed.</small>}
          </div>
        </div>)}</div>}
    </section>

    <section className="sec" aria-label="Recent activity">
      <div className="sec-head"><h2>What it did recently</h2>
        <span className="note">{view.runs.count ? `${view.runs.count} turn${view.runs.count > 1 ? "s" : ""} · ${view.runs.toolCalls} tool call${view.runs.toolCalls === 1 ? "" : "s"}${view.runs.costUsd != null ? ` · $${view.runs.costUsd.toFixed(2)} spent` : ""}` : "No agent turns recorded yet"}</span>
      </div>
      {view.activity.length === 0 ? <p className="empty">Nothing yet. When a driver writes or a car reports a fault, each step the agent takes is listed here.</p>
        : <ol className="activity">{view.activity.map((item) => <li key={item.id} className={`activity-row kind-${item.kind}`}>
          <time dateTime={item.at} title={`${fmtLong(item.at)} (${relativeTo(item.at, view.simNow)?.text ?? ""})`}>{fmtClock(item.at)}</time>
          <Link className="ref-link" href={`/orders/${item.orderId}#t-${item.id}`}>{item.reference}</Link>
          <span className="activity-text">{item.kind === "safety" && <b>Safety instruction: </b>}{item.text}{item.channelLabel && <small> · {item.channelLabel}</small>}</span>
        </li>)}</ol>}
    </section>

    <section className="sec" aria-label="Rulebook">
      <div className="sec-head"><h2>The rulebook</h2><span className="note">The agent reads these playbooks on every turn.</span></div>
      {view.playbooks.length === 0 ? <p className="empty">No playbooks found.</p> : <div className="rulebook">
        <nav className="rulebook-nav" aria-label="Playbooks">{view.playbooks.map((playbook) => <a key={playbook.slug} href={`#pb-${playbook.slug}`}
          className={playbook.slug === selected?.slug ? "on" : undefined} aria-current={playbook.slug === selected?.slug ? "true" : undefined}
          onClick={(event) => { event.preventDefault(); setSlug(playbook.slug); history.replaceState(null, "", `#pb-${playbook.slug}`) }}>{playbook.title}</a>)}</nav>
        {selected && <Playbook playbook={selected} />}
      </div>}
    </section>
  </main>
}
