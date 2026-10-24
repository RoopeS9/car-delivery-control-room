"use client"

import { useEffect, useState } from "react"
import type { DossierView } from "@/lib/present/dossier-types"
import "./journey-bar.css"

type Progress = NonNullable<DossierView["progress"]>

/** How much of the bar one label needs, as a fraction of its width: the ends are anchored, the rest centred. */
const ROOM = 0.16

/**
 * How far along the trip is: one bar in stages (road, the ferry crossing as its own segment, road), filled to the
 * distance covered, the percent written on the bar, and the stage boundaries named on a line beneath:
 * Pickup, the terminals, Delivery, with Now where the car is. Every stop keeps its tick; words are dropped where
 * they would overlap a neighbour's, so nothing is ever printed over anything else.
 */
export function JourneyBar({ progress }: { progress: Progress }) {
  const percent = Math.round(progress.fraction * 100)
  const text = `${percent} %${progress.remainingKm != null && progress.fraction < 1 && progress.fraction > 0 ? ` · ${progress.remainingKm.toLocaleString("en-GB")} km to go` : ""}`
  const last = progress.stops.length - 1
  // Where each label's words sit: the first starts at 0, the last ends at 1, a middle one is centred on its tick.
  const span = (at: number, index: number): [number, number] => index === 0 ? [0, ROOM] : index === last ? [1 - ROOM, 1] : [at - ROOM / 2, at + ROOM / 2]
  const overlaps = (a: [number, number], b: [number, number]) => a[0] < b[1] && b[0] < a[1]
  const shown: boolean[] = []
  progress.stops.forEach((stop, index) => {
    const mine = span(stop.at, index)
    // The ends always speak; a middle stop speaks when it is clear of every stop already speaking.
    shown[index] = index === 0 || index === last || progress.stops.every((other, j) => j === index || !shown[j] || !overlaps(mine, span(other.at, j)))
  })
  const nowAt = progress.fraction
  const nowShown = nowAt > 0.02 && nowAt < 0.98 && progress.stops.every((stop, index) => !shown[index] || !overlaps([nowAt - ROOM / 2, nowAt + ROOM / 2], span(stop.at, index)))
  return <div className="jbar" title={`From the ${progress.basis}`}>
    <div className="jbar-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label="Distance covered">
      {progress.segments.map((segment, index) => <span key={index} className={`jbar-seg jbar-${segment.kind}`} style={{ left: `${segment.from * 100}%`, width: `${(segment.to - segment.from) * 100}%` }} title={segment.label} />)}
      <span className="jbar-fill" style={{ width: `${percent}%` }} />
      {progress.stops.slice(1, -1).map((stop, index) => <span key={index} className="jbar-tick" style={{ left: `${stop.at * 100}%` }} />)}
      <span className={`jbar-text${percent > 55 ? " on-fill" : ""}`}>{text}</span>
    </div>
    <ol className="jbar-stops">
      {progress.stops.map((stop, index) => <li key={index} className={[index === 0 ? "first" : index === last ? "last" : "", shown[index] ? "" : "quiet"].filter(Boolean).join(" ") || undefined} style={{ left: `${stop.at * 100}%` }} title={`${stop.label}: ${stop.place}`}>
        <b>{stop.label}</b><span>{stop.place}</span>
      </li>)}
      {nowAt > 0.02 && nowAt < 0.98 && <li className={`now${nowShown ? "" : " quiet"}`} style={{ left: `${nowAt * 100}%` }} title={`Now: ${text}`}><b>Now</b></li>}
    </ol>
  </div>
}

/** The bar for one order, fetched from the operator view (the order page uses this). */
export function OrderJourneyBar({ orderId }: { orderId: string }) {
  const [progress, setProgress] = useState<Progress | null>(null)
  useEffect(() => {
    let stopped = false
    const load = () => fetch(`/api/chart/order/${encodeURIComponent(orderId)}`, { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<DossierView> : null)
      .then((view) => { if (!stopped && view) setProgress(view.progress) })
      .catch(() => undefined)
    void load()
    const timer = setInterval(load, 15_000)
    return () => { stopped = true; clearInterval(timer) }
  }, [orderId])
  if (!progress) return null
  return <section className="jbar-card" aria-label="Journey progress"><h2>Journey</h2><JourneyBar progress={progress} /></section>
}
