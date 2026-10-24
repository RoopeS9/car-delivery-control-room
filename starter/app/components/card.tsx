"use client"

import Link from "next/link"
import { laneLabel } from "@/lib/present/labels"
import { fmtDateTime, fmtRange, fmtWeekday } from "@/lib/present/time"
import type { BoardCard, Tone } from "@/lib/present/types"
import { Icon } from "./icons"

export const MARK_ICON: Record<string, string> = {
  alert: "alert", owned_alert: "alert", work: "work", incident: "incident", waiting: "waiting", conversation: "message",
  proposal: "proposal", claim: "alert", custody: "key", check: "note", inbox: "message",
}

/** One order on a board or in a list: car, reference, customer, route, the decisive date and the work tray. */
export function Card({ card, role }: { card: BoardCard; role?: string | null }) {
  const marks = uniqueMarks(card)
  const date = card.decisive
  return <div>
    {role && <div className="card-role">{role}</div>}
    <Link className="card" href={`/orders/${card.id}`} aria-label={`${card.vehicle}, ${card.reference}, ${laneLabel(card.displayLane)}`}>
      <div className="card-body">
        <div className="card-line">
          <span className="card-vehicle">{card.vehicle}</span>
          {marks.length > 0 && <span className="card-marks" aria-hidden="true">{marks.map(([kind, tone]) => <Icon key={kind} name={MARK_ICON[kind] ?? "note"} size={14} className={`tone-${tone}`} />)}</span>}
        </div>
        <div className="card-line">
          <span className="card-ref">{card.reference}</span>
          <span className="card-customer" title={card.customer}>{card.customer}</span>
        </div>
        <div className="card-line card-route">
          <span title={card.origin}>{card.from.city}{card.from.country ? `, ${card.from.country}` : ""}</span>
          <Icon name="arrow" size={13} />
          <span title={card.destination}>{card.to.city}{card.to.country ? `, ${card.to.country}` : ""}</span>
        </div>
        {date && <div className={`card-line card-date tone-${date.tone}`}>
          <span className="card-date-label">{date.label}</span>
          <span className="card-date-value num" title={date.end ? fmtRange(date.start, date.end, date.zone) : fmtDateTime(date.start, date.zone)}>{dateText(date.start, date.end, date.zone)}</span>
          {date.note && <span className="card-date-note" title={date.note}>· {date.note}</span>}
        </div>}
      </div>
      {card.work.length > 0 && <div className="card-tray">
        {card.work.map((line, index) => <div className={`tray-line tone-${line.tone}`} key={index}><Icon name={line.icon} size={14} /><span title={line.text}>{line.text}</span></div>)}
      </div>}
    </Link>
  </div>
}

function dateText(start: string, end: string | null, zone: string | null): string {
  const day = fmtWeekday(start, zone)
  const from = fmtDateTime(start, zone, false).split(" ").pop() ?? ""
  if (!end) return `${day} ${from}`
  const to = fmtDateTime(end, zone, false).split(" ").pop() ?? ""
  const sameDay = fmtWeekday(end, zone) === day
  return sameDay ? `${day} ${from}–${to}` : `${day} ${from} – ${fmtWeekday(end, zone)} ${to}`
}

function uniqueMarks(card: BoardCard): [string, Tone][] {
  const seen = new Map<string, Tone>()
  for (const item of card.attention) {
    const key = MARK_ICON[item.kind] ?? "note"
    if (!seen.has(key)) seen.set(key, item.tone)
  }
  return [...seen.entries()].slice(0, 3).map(([key, tone]) => [Object.keys(MARK_ICON).find((kind) => MARK_ICON[kind] === key) ?? key, tone])
}
