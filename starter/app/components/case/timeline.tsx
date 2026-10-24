"use client"

import { useState } from "react"
import { fmtClock, fmtDayHeading, fmtLong } from "@/lib/present/time"
import type { TimelineEntry } from "@/lib/present/types"
import { Icon } from "../icons"

const KIND_ICON: Record<string, string> = {
  message: "message", voice: "message", photo: "photo", safety: "alert", telemetry: "car", lookup: "search",
  proposal: "proposal", decision: "check", effect: "check", note: "note", alert: "alert", event: "dot",
}

function Entry({ entry }: { entry: TimelineEntry }) {
  return <li id={`t-${entry.id}`} className={`tl-entry kind-${entry.kind}${entry.internal ? " internal" : ""}${entry.origin === "live" ? " live" : ""}`} data-tone={entry.tone}>
    <time dateTime={entry.at} title={fmtLong(entry.at)}>{fmtClock(entry.at)}</time>
    <span className="tl-icon" aria-hidden="true"><Icon name={KIND_ICON[entry.kind] ?? "dot"} size={13} /></span>
    <div className="tl-body">
      <div className="tl-meta">
        <b>{entry.actorName}</b>
        {entry.actorRole && <span className="tl-role">{entry.actorRole}</span>}
        {entry.channelLabel && <span className="tl-channel">{entry.channelLabel}</span>}
        {entry.kind === "safety" && <span className="tl-flag">Safety instruction, sent at once</span>}
      </div>
      <p className="tl-text">{entry.text}</p>
      <span className="tl-source">{entry.origin === "live" ? "Live" : "Recorded"}, {entry.source.label}</span>
    </div>
  </li>
}

function byDay(entries: TimelineEntry[]): { label: string; entries: TimelineEntry[] }[] {
  const days: { label: string; entries: TimelineEntry[] }[] = []
  for (const entry of entries) {
    const label = fmtDayHeading(entry.at)
    const last = days[days.length - 1]
    if (last && last.label === label) last.entries.push(entry)
    else days.push({ label, entries: [entry] })
  }
  return days
}

/**
 * Recorded messages, alerts and events merged with the live case log. Records
 * from before the case opened are folded, so the case reads first; the agent's
 * lookups can be hidden.
 */
export function Timeline({ entries, since }: { entries: TimelineEntry[]; since: string | null }) {
  const [showEarlier, setShowEarlier] = useState(false)
  const [showLookups, setShowLookups] = useState(true)
  // Fold what came before the case: from the case opening or the first live line, whichever is earlier.
  const firstLive = entries.find((entry) => entry.origin === "live")?.at ?? null
  const caseStart = [since, firstLive].filter((value): value is string => !!value).sort()[0] ?? null
  const cutoff = caseStart ?? (entries.length > 10 ? entries[entries.length - 10].at : null)
  const earlier = cutoff ? entries.filter((entry) => entry.at < cutoff) : []
  const visible = (showEarlier ? entries : entries.filter((entry) => !cutoff || entry.at >= cutoff))
    .filter((entry) => showLookups || entry.kind !== "lookup")
  const lookups = entries.filter((entry) => entry.kind === "lookup").length

  if (!entries.length) return <p className="empty">Nothing recorded on this order yet.</p>

  return <div className="timeline">
    <div className="tl-tools">
      {earlier.length > 0 && <button type="button" className="show-more" onClick={() => setShowEarlier((value) => !value)}>
        {showEarlier ? "Hide earlier records" : `Show ${earlier.length} earlier record${earlier.length > 1 ? "s" : ""}`}
      </button>}
      {lookups > 0 && <label className="tl-toggle"><input type="checkbox" checked={showLookups} onChange={(event) => setShowLookups(event.target.checked)} /> Show the agent&apos;s lookups ({lookups})</label>}
    </div>
    {byDay(visible).map((day) => <section key={day.label} className="tl-day">
      <h3>{day.label}</h3>
      <ol>{day.entries.map((entry) => <Entry key={entry.id} entry={entry} />)}</ol>
    </section>)}
  </div>
}
