"use client"

import Link from "next/link"
import { useState } from "react"
import type { AttentionItem, JourneyGroup, JourneyLeg, JourneyStep, ProposalView, RecordView, ThreadView } from "@/lib/present/types"
import { fmtClock, fmtDateTime, fmtDay, relativeTo } from "@/lib/present/time"
import { Icon } from "../icons"
import { ActorName, Chip, Empty, OrderLink, OrderLinks, Range, SectionHead, When } from "../ui"
import { OrderFiles } from "./files"

const ATTENTION_ICON: Record<AttentionItem["kind"], string> = {
  alert: "alert", owned_alert: "alert", work: "work", incident: "incident", waiting: "waiting", conversation: "message",
  proposal: "proposal", claim: "alert", custody: "key", check: "note", inbox: "inbox",
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/* ── Needs a person ─────────────────────────────────────────────────────── */

export function AttentionPanel({ view }: { view: RecordView }) {
  const items = view.attention
  if (items.length === 0) return <div className="panel quiet" id="attention">
    <Icon name="note" />
    <span>Nothing in the records is waiting on a person. <small>Checked: alerts, incidents, work items, conversations, agent proposals, claims, custody and a moving car's position. Not checked: proofs, documents and endpoint details beyond a booked car's pickup contact and access.</small></span>
  </div>
  return <div className="panel" id="attention">
    <div className="panel-head">Needs a person <span className="num">{items.length}</span></div>
    <ol className="panel-rows">{items.map((item) => <li className="panel-row" key={`${item.kind}-${item.recordId}`}>
      <Icon name={ATTENTION_ICON[item.kind]} className={`tone-${item.tone}`} />
      <div>
        <div className={`panel-row-title tone-${item.tone}`}>{item.title}</div>
        {item.detail && <div className="panel-row-detail">{item.detail}</div>}
      </div>
      <div className="panel-row-side">{item.owner ?? "No owner"}{item.at && item.atLabel ? <><br />{capitalise(item.atLabel)} <When at={item.at} snapshotAt={view.snapshotAt} relative withZone={false} /></> : null}</div>
    </li>)}</ol>
  </div>
}

/* ── Route strip ────────────────────────────────────────────────────────── */

export function RouteStrip({ view }: { view: RecordView }) {
  const groups = view.journey.groups
  if (!groups.length) return null
  return <section className="sec" id="journey">
    <SectionHead title="Route" note={view.journey.plan && !view.journey.plan.active ? "Draft plan, not activated" : undefined} />
    {groups.map((group) => <RouteGroup key={group.itemId} group={group} view={view} labelled={groups.length > 1} />)}
  </section>
}

function RouteGroup({ group, view, labelled }: { group: JourneyGroup; view: RecordView; labelled: boolean }) {
  const legsFrom = new Map(group.legs.map((leg) => [leg.fromStepId, leg]))
  return <div className="route-group">
    {labelled && <p className="route-group-label">{group.roleLabel}: {group.vehicle}</p>}
    <div className="route">
      {group.steps.map((step) => {
        const leg = legsFrom.get(step.id)
        return <RouteStop key={step.id} step={step} leg={leg ?? null} view={view} />
      })}
    </div>
  </div>
}

function RouteStop({ step, leg, view }: { step: JourneyStep; leg: JourneyLeg | null; view: RecordView }) {
  const icon = step.role === "PICKUP" ? "pin" : step.role === "DELIVERY" ? "flag" : "yard"
  const slot = step.windows.find((window) => window.selected && (window.purpose === "SELECTED_PICKUP_SLOT" || window.purpose === "CUSTOMER_DELIVERY_PROMISE" || window.purpose === "SELECTED_DELIVERY_SLOT"))
    ?? step.windows.find((window) => window.purpose.startsWith("REQUESTED_")) ?? null
  const name = step.site ? <Link className="name-link" href={`/sites/${step.site.id}`}>{step.place.name}</Link> : step.place.name
  return <>
    <div className={`route-stop${step.recorded ? " done" : ""}`}>
      <div className="route-role"><Icon name={step.recorded ? "check" : icon} size={13} />{step.roleLabel}</div>
      <div className="route-name">{name}</div>
      <div className="route-city">{step.place.city}{step.place.country ? `, ${step.place.country}` : ""}{step.site ? "" : " · no site profile"}</div>
      {step.recorded
        ? <div className="route-when tone-ok">{step.recorded.label} <When at={step.recorded.at} /></div>
        : slot ? <div className="route-when"><span className="route-when-label">{slot.label}</span> <Range start={slot.start} end={slot.end} zone={slot.zone} /></div>
        : <div className="route-when muted">No slot selected</div>}
      {(step.contact || step.access) && !step.recorded && <div className="route-state">
        {step.contact && <Chip tone={step.contact.tone}>Contact {step.contact.statusLabel.toLowerCase()}</Chip>}
        {step.access && <Chip tone={step.access.tone}>Access {step.access.statusLabel.toLowerCase()}</Chip>}
      </div>}
      {step.claims.some((claim) => claim.status === "OPEN") && <div className="route-state"><Chip tone="warn">Open claim</Chip></div>}
    </div>
    {leg && <RouteLeg leg={leg} view={view} />}
  </>
}

function RouteLeg({ leg, view }: { leg: JourneyLeg; view: RecordView }) {
  const assignment = leg.assignment
  const age = leg.tracking?.receivedAt ? relativeTo(leg.tracking.receivedAt, view.snapshotAt) : null
  return <div className={`route-leg tone-${leg.tone}`}>
    <span className="route-leg-line"><Icon name="car" size={16} /></span>
    {leg.distanceKm != null && <b>{leg.distanceKm} km</b>}
    {assignment ? <span><ActorName actor={assignment.driver} /> · {assignment.statusLabel.toLowerCase()}</span> : <span>No driver yet</span>}
    {leg.tracking?.eta && <span className="route-leg-eta">ETA {fmtDateTime(leg.tracking.eta, view.header.keyDates.find((date) => date.key === "promise")?.zone ?? null)}{age ? `, ${age.text}` : ""}</span>}
  </div>
}

/* ── Conversations ──────────────────────────────────────────────────────── */

export function ConversationsSection({ view }: { view: RecordView }) {
  const { threads, notes } = view
  return <section className="sec" id="conversations">
    <SectionHead title="Conversations" count={threads.length} />
    {threads.length === 0 && notes.length === 0 && <Empty>No conversation is linked to this order.</Empty>}
    <div className="rows">
      {threads.map((thread) => <ThreadRow key={thread.id} thread={thread} view={view} />)}
      {notes.map((note) => <div className="row" key={note.id}>
        <div className="row-main">
          <div className="row-title">Note from <ActorName actor={note.author} /></div>
          <div className="row-preview">{note.body}</div>
        </div>
        <div className="row-side"><When at={note.at} withZone={false} /></div>
      </div>)}
    </div>
  </section>
}

function ThreadRow({ thread, view }: { thread: ThreadView; view: RecordView }) {
  const [open, setOpen] = useState(false)
  const last = thread.messages[thread.messages.length - 1]
  const count = thread.messages.length
  return <article className="row">
    <div className="row-main">
      <div className="row-title">{thread.categoryLabel} <Chip tone={thread.tone}>{thread.statusLabel}</Chip></div>
      <div className="row-sub">
        {thread.channelLabel}{thread.counterparty ? <> with <ActorName actor={thread.counterparty} /></> : ""} · {count} {count === 1 ? "message" : "messages"}
        {thread.waitingOn && ` · waiting on ${thread.waitingOn}`}{thread.owner && ` · ${thread.owner}`}
        {thread.relatedOrders.length > 0 && <> · also <OrderLinks orders={thread.relatedOrders} /></>}
      </div>
      {last && !open && <div className="row-preview"><b>{last.author.name}:</b> {last.body}</div>}
      {open && <ThreadMessages thread={thread} />}
      {count > 0 && <button type="button" className="show-more" onClick={() => setOpen((value) => !value)}>{open ? "Hide messages" : `Read ${count === 1 ? "the message" : `all ${count} messages`}`}</button>}
    </div>
    <div className="row-side"><When at={thread.updatedAt} withZone={false} /></div>
  </article>
}

export function ThreadMessages({ thread }: { thread: ThreadView }) {
  return <div className="messages">{thread.messages.map((message) => <div className={`msg${message.internal ? " internal" : message.author.kind === "operator" || message.author.kind === "agent" ? " from-operator" : ""}`} key={message.id}>
    <div className="msg-meta">
      <b><ActorName actor={message.author} /></b>
      <span className="role">{message.author.role}</span>
      <span>to {message.recipient.name}</span>
      <span>· {message.channelLabel}</span>
      {message.internal && <span className="msg-tag internal">Internal</span>}
      {message.author.kind === "agent" && <span className="msg-tag">Agent</span>}
      {message.otherOrder && <span className="msg-tag">Filed on <OrderLink order={message.otherOrder} /></span>}
      <time dateTime={message.at}>{fmtDateTime(message.at)}</time>
    </div>
    <p className="msg-body">{message.body}</p>
  </div>)}</div>
}

/* ── Evidence ───────────────────────────────────────────────────────────── */

export function EvidenceSection({ view }: { view: RecordView }) {
  const { proofs, documents, custody } = view
  const total = proofs.length + documents.length + custody.assets.length
  return <section className="sec" id="evidence">
    <SectionHead title="Evidence" count={total} />
    {total === 0 && <Empty>No proof or document record yet.</Empty>}
    {total > 0 && <div className="chips">
      {proofs.map((proof) => <Chip key={proof.id} tone={proof.tone} dot>{proof.kindLabel} · {proof.statusLabel.toLowerCase()}{proof.fileCount ? ` · ${proof.fileCount} files` : ""}</Chip>)}
      {documents.map((document) => <Chip key={document.id} tone={document.tone} dot>{document.kindLabel}{document.medium ? ` (${document.medium})` : ""} · {document.statusLabel.toLowerCase()}</Chip>)}
      {custody.assets.map((asset) => <Chip key={asset.id} tone={asset.nextAction ? "warn" : "neutral"} dot>{asset.kindLabel} · holder {asset.holder}</Chip>)}
    </div>}
    <OrderFiles orderId={view.header.id} />
  </section>
}

/* ── Prior agent work ───────────────────────────────────────────────────── */

export function DecisionsSection({ view }: { view: RecordView }) {
  const { proposals } = view
  return <section className="sec" id="decisions">
    <SectionHead title="Prior agent work" count={proposals.length} />
    {proposals.length === 0 && <Empty>No agent has proposed anything on this order yet. Your agent's proposals and the human decision on them belong here.</Empty>}
    <div className="rows">{proposals.map((proposal) => <ProposalRow key={proposal.id} proposal={proposal} />)}</div>
  </section>
}

function ProposalRow({ proposal }: { proposal: ProposalView }) {
  return <article className="row">
    <div className="row-main">
      <div className="row-title">{proposal.summary} <Chip tone={proposal.tone} dot>{proposal.statusLabel}</Chip></div>
      <div className="row-sub">
        {proposal.agent.name} · {proposal.commandLabel.toLowerCase()}
        {proposal.review && <> · {proposal.review.decisionLabel.toLowerCase()} by {proposal.review.reviewer.name}</>}
        {proposal.execution && <> · execution {proposal.execution.statusLabel.toLowerCase()}{proposal.execution.effects ? `, ${proposal.execution.effects} event${proposal.execution.effects === 1 ? "" : "s"} committed` : ", nothing committed"}</>}
      </div>
    </div>
    <div className="row-side"><When at={proposal.createdAt} withZone={false} /></div>
  </article>
}

export function ProposalCards({ view }: { view: RecordView }) {
  const { proposals, notifications } = view
  return <div>
    {proposals.map((proposal) => <article className="proposal" key={proposal.id}>
      <div className="proposal-head"><Chip tone={proposal.tone} dot>{proposal.statusLabel}</Chip><span>{proposal.agent.name} · {proposal.commandLabel.toLowerCase()} · <When at={proposal.createdAt} /></span></div>
      <p className="proposal-summary">{proposal.summary}</p>
      {proposal.rationale && <p className="proposal-text">{proposal.rationale}</p>}
      {proposal.review && <dl className="proposal-block">
        <dt>Recorded review</dt><dd>{proposal.review.decisionLabel} by {proposal.review.reviewer.name}, {fmtDateTime(proposal.review.at)}</dd>
        {proposal.review.note && <><dt>Note</dt><dd>{proposal.review.note}</dd></>}
      </dl>}
      {proposal.execution && <dl className="proposal-block">
        <dt>Execution</dt><dd>{proposal.execution.statusLabel}{proposal.execution.at ? `, attempted ${fmtDateTime(proposal.execution.at)}` : ""} · {proposal.execution.effects ? `${proposal.execution.effects} committed event${proposal.execution.effects === 1 ? "" : "s"} linked` : "no committed event linked"}</dd>
        {proposal.execution.error && <><dt>Error</dt><dd className="tone-danger">{proposal.execution.error}</dd></>}
      </dl>}
      <p className="proposal-foot">{proposal.evidenceCount} evidence link{proposal.evidenceCount === 1 ? "" : "s"}{proposal.dependency ? ` · ${proposal.dependency}` : ""}{proposal.superseded ? ` · ${proposal.superseded}` : ""}. Proposal text is never proof that anything changed.</p>
    </article>)}
    {notifications.length > 0 && <>
      <p className="sub">Internal room activity</p>
      <div className="rows">{notifications.map((note) => <div className="row" key={note.id}>
        <div className="row-main"><div className="row-title">{note.activityLabel} <span className="row-sub-inline">in {note.destination} by {note.actor.name}</span></div><div className="row-preview">{note.preview}</div></div>
        <div className="row-side"><When at={note.at} withZone={false} /> · {note.deliveryLabel}</div>
      </div>)}</div>
    </>}
  </div>
}

/* ── Activity ───────────────────────────────────────────────────────────── */

export function ActivitySection({ view }: { view: RecordView }) {
  const [all, setAll] = useState(false)
  const events = view.history.flatMap((day) => day.events)
  const shown = all ? events : events.slice(0, 6)
  return <section className="sec" id="history">
    <SectionHead title="Activity" count={view.historyTotal} />
    {events.length === 0 && <Empty>No events recorded.</Empty>}
    <div className="events">{shown.map((event) => <div className="event" key={event.id}>
      <time dateTime={event.at} title={fmtDateTime(event.at)}>{fmtDay(event.at)} {fmtClock(event.at)}</time>
      <div className="event-text"><b>{event.text}</b>{event.actor && <span className="actor"> · {event.actor}</span>}{event.shared && <span className="actor"> · shared bundle</span>}{all && event.detail && <small>{event.detail}</small>}</div>
    </div>)}</div>
    {events.length > 6 && <button type="button" className="show-more" onClick={() => setAll((value) => !value)}>{all ? "Show the latest only" : `Show all ${events.length} events`}</button>}
  </section>
}

/* ── Detailed route, for the records panel ──────────────────────────────── */

export function RouteDetails({ view }: { view: RecordView }) {
  const { journey } = view
  return <div>
    {journey.plan && <p className="rec-note">{journey.plan.statusLabel} plan{journey.plan.version ? ` v${journey.plan.version}` : ""}{journey.plan.active ? "" : ", not activated"}{journey.plan.activatedAt ? `, activated ${fmtDateTime(journey.plan.activatedAt)}` : ""}{journey.otherPlans.length ? ` · ${journey.otherPlans.length} other ${journey.otherPlans.length === 1 ? "plan" : "plans"} kept in the API` : ""}</p>}
    {journey.groups.map((group) => {
      const legsFrom = new Map(group.legs.map((leg) => [leg.fromStepId, leg]))
      return <div className="journey-group" key={group.itemId}>
        {journey.groups.length > 1 && <p className="journey-group-head">{group.roleLabel}: {group.vehicle}</p>}
        <div className="journey">{group.steps.map((step, index) => {
          const leg = legsFrom.get(step.id)
          return <div key={step.id}>
            <StepView step={step} live={leg?.status === "IN_PROGRESS"} last={index === group.steps.length - 1 && !leg} />
            {leg && <LegView leg={leg} view={view} />}
          </div>
        })}</div>
      </div>
    })}
  </div>
}

function StepView({ step, live, last }: { step: JourneyStep; live: boolean; last: boolean }) {
  const icon = step.role === "PICKUP" ? "pin" : step.role === "DELIVERY" ? "flag" : "yard"
  return <div className={`step${step.recorded ? " done" : ""}${live ? " live" : ""}${last ? " last" : ""}`}>
    <span className="step-marker"><Icon name={step.recorded ? "check" : icon} size={13} /></span>
    <div>
      <div className="step-head">
        <span className="step-role">{step.roleLabel}</span>
        <span className="step-name">{step.site ? <Link className="name-link" href={`/sites/${step.site.id}`}>{step.place.name}</Link> : step.place.name}</span>
        <span className="step-kind">{step.place.kindLabel}{step.site ? "" : " · no managed site profile"}</span>
      </div>
      <p className="step-addr">{step.place.addressLine ?? <span className="tone-warn">Street not supplied</span>}{step.place.city ? `, ${step.place.city}` : ""}{step.place.country ? `, ${step.place.country}` : ""}</p>
      <dl className="step-facts">
        {step.windows.map((window) => <div className="fact" key={window.purpose + window.start}>
          <dt>{window.label}</dt>
          <dd><Range start={window.start} end={window.end} zone={window.zone} /><small>{window.sourceLabel}{window.deadline ? ` · outer limit ${fmtDateTime(window.deadline, window.zone)}` : ""}</small></dd>
        </div>)}
        {step.recorded && <div className="fact tone-ok"><dt>{step.recorded.label}</dt><dd><When at={step.recorded.at} /><small>{step.recorded.actor ? `reported by ${step.recorded.actor}` : "recorded event"}</small></dd></div>}
        {step.contact && <div className={`fact tone-${step.contact.tone}`}>
          <dt>Contact</dt>
          <dd>{step.contact.name ?? "Not supplied"}{step.contact.role ? ` (${step.contact.role})` : ""} · {step.contact.statusLabel.toLowerCase()}
            <small>{step.contact.handle ?? "no handle recorded"}{step.contact.confirmedAt ? ` · confirmed ${fmtDateTime(step.contact.confirmedAt)}${step.contact.sourceLabel ? ` via ${step.contact.sourceLabel}` : ""}` : " · no confirmation recorded for this order"}</small>
          </dd>
        </div>}
        {step.access && <div className={`fact tone-${step.access.tone}`}>
          <dt>Access</dt>
          <dd>{step.access.statusLabel}<small>{step.access.statedByLabel ? `stated by ${step.access.statedByLabel}` : ""}{step.access.confirmedAt ? ` · confirmed ${fmtDateTime(step.access.confirmedAt)}${step.access.sourceLabel ? ` via ${step.access.sourceLabel}` : ""}` : ""}</small></dd>
        </div>}
        {step.site?.hours && <div className="fact"><dt>Site hours</dt><dd>{step.site.hours}<small>local time{step.site.advanceNoticeMinutes ? ` · ${step.site.advanceNoticeMinutes} min advance notice` : ""}</small></dd></div>}
        {step.site?.handoverMode && <div className="fact"><dt>Handover</dt><dd>{step.site.handoverMode}{step.site.contactEmail && <small>{step.site.contactEmail}</small>}</dd></div>}
      </dl>
      {step.access?.instruction && <p className="step-instruction"><b>{step.site?.accessNote === step.access.instruction ? "Order instruction, copied from the site profile." : "Order instruction."}</b> {step.access.instruction}</p>}
      {step.site?.accessNote && step.site.accessNote !== step.access?.instruction && <p className="step-instruction"><b>Site procedure.</b> {step.site.accessNote}</p>}
      {step.site?.releaseRule && <p className="step-instruction"><b>Release rule.</b> {step.site.releaseRule}</p>}
      {step.claims.length > 0 && <div className="step-notes">{step.claims.map((claim) => <p key={claim.id}><Chip tone={claim.tone}>{claim.statusLabel}</Chip> Claim about the {claim.field.toLowerCase()}: {claim.claim}{claim.source ? ` (${claim.source}${claim.confidence ? `, ${claim.confidence}` : ""})` : ""}</p>)}</div>}
      {step.notes.length > 0 && <div className="step-notes">{step.notes.map((note) => <p key={note}>{note}</p>)}</div>}
      {step.proofs.length > 0 && <div className="step-proofs">{step.proofs.map((proof) => <Chip key={proof.id} tone={proof.tone} dot>{proof.kindLabel} · {proof.statusLabel.toLowerCase()}{proof.fileCount ? ` · ${proof.fileCount} files` : ""}</Chip>)}</div>}
    </div>
  </div>
}

function LegView({ leg, view }: { leg: JourneyLeg; view: RecordView }) {
  const assignment = leg.assignment
  const tracking = leg.tracking
  const age = tracking?.receivedAt ? relativeTo(tracking.receivedAt, view.snapshotAt) : null
  return <div className="leg">
    <span className="leg-marker"><Icon name="car" size={15} /></span>
    <div className="leg-body">
      <div className="leg-main">
        {leg.distanceKm != null && <span><b>{leg.distanceKm} km</b> planned</span>}
        <Chip tone={leg.tone}>{leg.statusLabel}</Chip>
        {assignment
          ? <span><b><ActorName actor={assignment.driver} /></b>{assignment.driverHome ? `, home base ${assignment.driverHome}` : ""} · {assignment.statusLabel.toLowerCase()}{assignment.fee ? ` · ${assignment.fee}` : ""}</span>
          : <span>No driver booked for this leg</span>}
      </div>
      {assignment?.positioning && <p className="leg-track">{assignment.positioning}{assignment.priorOrder && <> (<OrderLink order={assignment.priorOrder} />)</>}. A home base or prior duty is not a current location.</p>}
      {assignment && assignment.steps.length > 0 && <div className="leg-steps">{assignment.steps.map((step) => <span key={step.id}>
        <Icon name={step.status === "COMPLETED" ? "check" : "chevron"} size={12} className={step.status === "COMPLETED" ? "tone-ok" : undefined} /> {step.title} · <span className={`tone-${step.tone}`}>{step.statusLabel.toLowerCase()}</span>{step.scheduledStart ? ` · ${fmtDateTime(step.scheduledStart)}` : ""}{step.note ? ` · ${step.note}` : ""}
      </span>)}</div>}
      {tracking && <p className="leg-track">Driver app: <b>ETA {fmtDateTime(tracking.eta)}</b>{tracking.remainingKm != null ? ` · ${tracking.remainingKm} km remaining` : ""}{tracking.progress != null ? ` · ${Math.round(tracking.progress * 100)}% of the leg` : ""} · {tracking.qualityLabel} signal{age ? `, received ${age.text}` : ""}. Unverified; no map position in this packet.</p>}
      {leg.inference && <p className="leg-track">Monitor inference: {leg.inference.note ?? `ETA ${fmtDateTime(leg.inference.eta)}`}</p>}
    </div>
  </div>
}

export function EvidenceDetails({ view }: { view: RecordView }) {
  const { proofs, documents, custody, siteVisits } = view
  return <div>
    {proofs.length > 0 && <><p className="sub">Proofs</p><div className="rows">{proofs.map((proof) => <div className="row" key={proof.id}>
      <div className="row-main"><div className="row-title">{proof.kindLabel} <Chip tone={proof.tone}>{proof.statusLabel}</Chip></div>
        <div className="row-sub">{proof.pointLabel ? `${proof.pointLabel} · ` : ""}{proof.required ? "required" : "optional"}{proof.fileCount ? ` · ${proof.fileCount} files` : " · no files"}{proof.submittedAt ? ` · submitted ${fmtDateTime(proof.submittedAt)}` : " · nothing submitted"}{proof.reviewedAt ? ` · reviewed ${fmtDateTime(proof.reviewedAt)}` : ""}{proof.note ? ` · ${proof.note}` : ""}</div></div>
    </div>)}</div></>}
    {documents.length > 0 && <><p className="sub">Documents</p><div className="rows">{documents.map((document) => <div className="row" key={document.id}>
      <div className="row-main"><div className="row-title">{document.kindLabel}{document.medium ? ` (${document.medium})` : ""} <Chip tone={document.tone}>{document.statusLabel}</Chip></div>
        <div className="row-sub">{document.required ? "required" : "optional"}{document.signatureScope ? ` · signatures: ${document.signatureScope}` : ""}{document.fileCount ? ` · ${document.fileCount} files` : " · no file"}{document.updatedAt ? ` · updated ${fmtDateTime(document.updatedAt)}` : ""}{document.note ? ` · ${document.note}` : ""}</div></div>
    </div>)}</div></>}
    {custody.assets.length > 0 && <><p className="sub">Keys and papers</p><div className="rows">{custody.assets.map((asset) => <div className="row" key={asset.id}>
      <div className="row-main"><div className="row-title">{asset.label}</div>
        <div className="row-sub">Holder {asset.holder} · basis {asset.basis}{asset.relatedOrder && <> · linked to <OrderLink order={asset.relatedOrder} /></>}{asset.owner ? ` · next check by ${asset.owner}` : ""}{asset.dueAt ? ` ${fmtDateTime(asset.dueAt)}` : ""}</div>
        {asset.nextAction && <div className="row-preview">{asset.nextAction}</div>}
        {asset.events.map((event) => <div className="row-sub" key={event.id}>{fmtDateTime(event.at)} · {event.kindLabel} · {event.verification}{event.note ? ` · ${event.note}` : ""}</div>)}
      </div>
    </div>)}</div></>}
    {custody.reports.length > 0 && <><p className="sub">Custody reports</p><div className="rows">{custody.reports.map((report) => <div className="row" key={report.id}>
      <div className="row-main"><div className="row-title"><ActorName actor={report.driver} /> reported the vehicle {report.security}</div><div className="row-sub">Continuity: {report.continuity} · location evidence: {report.location}{report.parking ? ` · ${report.parking}` : ""}</div></div>
      <div className="row-side"><When at={report.at} /></div>
    </div>)}</div></>}
    {siteVisits.length > 0 && <><p className="sub">Site visits</p><div className="rows">{siteVisits.map((visit) => <div className="row" key={visit.id}>
      <div className="row-main"><div className="row-title">{visit.site ?? "Site"}: {visit.outcome}</div><div className="row-sub">{visit.verifiedBySite ? "Verified by the site" : "Not verified by the site"}{visit.leftAt ? ` · left ${fmtClock(visit.leftAt)}` : ""}</div></div>
      <div className="row-side"><When at={visit.at} /></div>
    </div>)}</div></>}
    {proofs.length + documents.length + custody.assets.length + custody.reports.length + siteVisits.length === 0 && <p className="empty">Nothing recorded.</p>}
  </div>
}

export function HistoryDays({ view }: { view: RecordView }) {
  return <div>{view.history.map((day) => <div className="history-day" key={day.key}>
    <h3>{day.label}</h3>
    {day.events.map((event) => <div className="event" key={event.id}>
      <time dateTime={event.at} title={fmtDateTime(event.at)}>{fmtClock(event.at)}</time>
      <div className="event-text"><b>{event.text}</b>{event.actor && <span className="actor"> · {event.actor}</span>}{event.shared && <span className="actor"> · shared bundle</span>}{event.detail && <small>{event.detail}</small>}</div>
    </div>)}
  </div>)}</div>
}
