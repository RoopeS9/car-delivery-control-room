"use client"

import Link from "next/link"
import type { ReactNode } from "react"
import { fmtDateTime, fmtLong, fmtRange, relativeTo } from "@/lib/present/time"
import type { Actor, Fact, OrderRef, Tone } from "@/lib/present/types"
import { Icon } from "./icons"

export function Chip({ tone = "neutral", children, dot = false }: { tone?: Tone; children: ReactNode; dot?: boolean }) {
  return <span className={`chip tone-${tone}`}>{dot && <span className="chip-dot" />}{children}</span>
}

/** A timestamp in the record's zone, with the full UTC time on hover. */
export function When({ at, zone, snapshotAt, relative = false, withZone = true }: { at: string | null | undefined; zone?: string | null; snapshotAt?: string | null; relative?: boolean; withZone?: boolean }) {
  if (!at) return null
  const rel = relative ? relativeTo(at, snapshotAt) : null
  return <time dateTime={at} title={fmtLong(at)}>{fmtDateTime(at, zone, withZone)}{rel ? ` (${rel.text})` : ""}</time>
}

export function Range({ start, end, zone }: { start: string | null | undefined; end: string | null | undefined; zone?: string | null }) {
  if (!start) return null
  return <time dateTime={start} title={`${fmtLong(start)}${end ? ` to ${fmtLong(end)}` : ""}`}>{end ? fmtRange(start, end, zone) : fmtDateTime(start, zone)}</time>
}

/** Where a person or place has its own page. Operators and agents are roles, not records. */
export function actorHref(actor: Actor): string | null {
  if (!actor.id) return null
  if (actor.kind === "driver") return `/drivers/${actor.id}`
  if (actor.kind === "customer") return `/customers/${actor.id}`
  if (actor.kind === "site_contact") return `/sites/${actor.id}`
  return null
}

export function ActorName({ actor }: { actor: Actor }) {
  const href = actorHref(actor)
  return href ? <Link className="name-link" href={href}>{actor.name}</Link> : <>{actor.name}</>
}

export function OrderLink({ order }: { order: OrderRef }) {
  return <Link className="ref-link" href={`/orders/${order.id}`}>{order.reference}</Link>
}

export function OrderLinks({ orders }: { orders: OrderRef[] }) {
  return <>{orders.map((order, index) => <span key={order.id}>{index > 0 ? ", " : ""}<OrderLink order={order} /></span>)}</>
}

export function FactList({ facts }: { facts: Fact[] }) {
  return <dl className="facts">{facts.map((fact) => <div className={`fact${fact.tone ? ` tone-${fact.tone}` : ""}`} key={fact.label}>
    <dt>{fact.label}</dt>
    <dd className={fact.mono ? "mono" : undefined}>{fact.href ? <Link className="name-link" href={fact.href}>{fact.value}</Link> : fact.value}{fact.hint && <small>{fact.hint}</small>}</dd>
  </div>)}</dl>
}

export function SectionHead({ title, count, note }: { title: string; count?: number | null; note?: ReactNode }) {
  return <div className="sec-head"><h2>{title}</h2>{count != null && count > 0 && <span className="count num">{count}</span>}{note && <span className="note">{note}</span>}</div>
}

export function Empty({ children, quiet = false, small }: { children: ReactNode; quiet?: boolean; small?: ReactNode }) {
  if (quiet) return <p className="empty quiet"><Icon name="check" /><span>{children}{small && <small>{small}</small>}</span></p>
  return <p className="empty">{children}</p>
}

export function More({ label, children, open = false }: { label: string; children: ReactNode; open?: boolean }) {
  return <details className="more" open={open}><summary><Icon name="chevron" size={12} />{label}</summary>{children}</details>
}
