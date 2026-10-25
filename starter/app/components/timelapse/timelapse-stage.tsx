"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import type { LayerGroup, Map as LeafletMap, Marker } from "leaflet"
import "leaflet/dist/leaflet.css"
import "../chart/chart.css"
import "./timelapse.css"
import type { TimelapseCar } from "@/lib/present/timelapse-load"
import { buildTimelapse, CALM_HOLD, DAY_START, DEFAULT_DURATION, DEFAULT_SEED, FADE, phaseAt, simTimeAt, tallyAt, TIMELAPSE_CAPTION, type EventPhase, type TimelapseEvent, type TimelapseOrder } from "@/lib/present/timelapse"
import { AppFrame } from "../app-frame"
import { ATTRIBUTION, readTheme, TILES, type ChartTheme } from "../chart/chart-home"
import { clockOf, dayOf } from "../chart/format"

type Options = { duration: number; seed: number; clean: boolean; loop: boolean; autostart: boolean; freeze: number | null }

const STEP_MS = 6 * 60000
const TICK = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 12.5l4.2 4.2 8.8-9.4"/></svg>`
const PERSON = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.4"/><path d="M5.2 19.6c.6-3.6 3.3-5.6 6.8-5.6s6.2 2 6.8 5.6"/></svg>`
const escape = (text: string) => text.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] as string)

/** A car at film time `t`: a straight line between the six-minute samples, which is within the road line's width at map zoom. */
function positionAt(car: TimelapseCar, simMs: number): { lat: number; lng: number; heading: number } {
  const x = Math.max(0, Math.min(car.samples.length - 1, (simMs - Date.parse(DAY_START)) / STEP_MS))
  const i = Math.min(car.samples.length - 2, Math.floor(x))
  const a = car.samples[i]
  const b = car.samples[i + 1]
  const f = x - i
  return { lat: a[0] + (b[0] - a[0]) * f, lng: a[1] + (b[1] - a[1]) * f, heading: a[2] }
}

function carHtml(tone: "fine" | "decide" | "agent", heading: number, label: string): string {
  return `<span class="v v-${tone} v-moving"><svg viewBox="0 0 20 20" style="transform:rotate(${Math.round(heading)}deg)"><path d="M10 2.6 16 17.2 10 13.8 4 17.2Z"/></svg><span class="v-label">${escape(label)}</span></span>`
}

function eventHtml(phase: EventPhase, event: TimelapseEvent): string {
  // Two named events can sit close together on the same corridor, so G and C put their labels on the left.
  const label = event.scenario && phase !== "none" ? `<span class="tl-label${event.scenario === "G" || event.scenario === "C" ? " left" : ""}">${escape(event.vehicle)}<small>${escape(event.what)}</small></span>` : ""
  switch (phase) {
    case "pulse": return `<span class="tl-ev tl-pulse"><i class="tl-ring"></i><i class="tl-ring r2"></i><i class="tl-core"></i>${label}</span>`
    case "agent": return `<span class="tl-ev tl-agent"><i class="tl-ring"></i><i class="tl-core"></i>${label}</span>`
    case "person": return `<span class="tl-ev tl-person"><i class="tl-ring"></i><i class="tl-ring r2"></i><i class="tl-core"></i>${label}</span>`
    case "cleared-agent": return `<span class="tl-ev tl-ok"><i class="tl-core">${TICK}</i></span>`
    case "cleared-person": return `<span class="tl-ev tl-ok"><i class="tl-core">${PERSON}</i></span>`
    default: return ""
  }
}

const toneOf = (phase: EventPhase): "fine" | "decide" | "agent" => phase === "pulse" || phase === "person" ? "decide" : phase === "agent" ? "agent" : "fine"

export function TimelapseStage({ orders, cars, options }: { orders: TimelapseOrder[]; cars: TimelapseCar[]; options: Options }) {
  const { duration, seed, clean, loop, autostart, freeze } = options
  const events = useMemo(() => buildTimelapse(orders, seed, duration), [orders, seed, duration])
  const holder = useRef<HTMLDivElement>(null)
  const map = useRef<LeafletMap | null>(null)
  const L = useRef<typeof import("leaflet") | null>(null)
  const layers = useRef<{ routes: LayerGroup; nodes: LayerGroup } | null>(null)
  const tiles = useRef<ReturnType<typeof import("leaflet").tileLayer>[]>([])
  const carMarks = useRef(new Map<string, { marker: Marker; tone: string; heading: number }>())
  const eventMarks = useRef(new Map<string, { marker: Marker; phase: EventPhase }>())
  const startedAt = useRef<number | null>(null)
  const [ready, setReady] = useState(false)
  const [theme, setTheme] = useState<ChartTheme>("dark")
  const [t, setT] = useState(freeze ?? 0)
  const [state, setState] = useState<"waiting" | "playing" | "done">(freeze != null ? "playing" : autostart ? "playing" : "waiting")
  const [run, setRun] = useState(0)

  // ---- the map: the chart's tiles, in the app's theme
  useEffect(() => {
    setTheme(readTheme())
    let cancelled = false
    void import("leaflet").then((leaflet) => {
      if (cancelled || !holder.current || map.current) return
      L.current = leaflet
      const m = leaflet.map(holder.current, { zoomControl: false, attributionControl: true, worldCopyJump: true, minZoom: 4, maxZoom: 12, zoomSnap: 0.25, trackResize: false,
        dragging: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false })
      m.createPane("trails").style.zIndex = "420"
      layers.current = { routes: leaflet.layerGroup().addTo(m), nodes: leaflet.layerGroup().addTo(m) }
      map.current = m
      setReady(true)
    })
    const observer = new MutationObserver(() => setTheme(readTheme()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] })
    return () => { cancelled = true; observer.disconnect(); map.current?.remove(); map.current = null }
  }, [])

  useEffect(() => {
    const leaflet = L.current
    if (!ready || !leaflet || !map.current) return
    tiles.current.forEach((layer) => layer.remove())
    tiles.current = [leaflet.tileLayer(TILES[theme], { attribution: ATTRIBUTION, maxZoom: 12, maxNativeZoom: 12, keepBuffer: 4 }).addTo(map.current)]
  }, [ready, theme])

  // ---- routes and the frame: every car's whole route, quiet, as on the chart; the map is framed once on all of them
  useEffect(() => {
    const leaflet = L.current
    if (!ready || !leaflet || !map.current || !layers.current) return
    layers.current.routes.clearLayers()
    const all: [number, number][] = []
    for (const car of cars) {
      for (const part of car.route) {
        if (part.length < 2) continue
        all.push(...part)
        leaflet.polyline(part, { pane: "trails", className: "route-ahead rt-fine", weight: 1.5, interactive: false }).addTo(layers.current.routes)
      }
    }
    const fit = () => {
      if (!map.current) return
      map.current.invalidateSize({ animate: false })
      if (all.length) map.current.fitBounds(leaflet.latLngBounds(all), { paddingTopLeft: [90, 90], paddingBottomRight: [90, 170], maxZoom: 8, animate: false })
      else map.current.setView([57, 15], 5, { animate: false })
    }
    fit()
    const observer = new ResizeObserver(fit)
    if (holder.current) observer.observe(holder.current)
    return () => observer.disconnect()
  }, [ready, cars, clean])

  // ---- the clock: wall time drives film time, unless a still was asked for
  useEffect(() => {
    if (freeze != null || state !== "playing") return
    let frame = 0
    startedAt.current = performance.now()
    const step = () => {
      const elapsed = (performance.now() - (startedAt.current ?? 0)) / 1000
      if (elapsed >= duration) {
        setT(duration)
        if (loop) { startedAt.current = performance.now(); setT(0); frame = requestAnimationFrame(step); return }
        setState("done")
        return
      }
      setT(elapsed)
      frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [state, duration, loop, freeze, run])

  // ---- draw the cars and the events at film time t
  useEffect(() => {
    const leaflet = L.current
    if (!ready || !leaflet || !layers.current) return
    const simMs = simTimeAt(t, duration).getTime()
    const phaseOf = new Map(events.map((event) => [event.orderId, { event, phase: phaseAt(event, t) }]))
    for (const car of cars) {
      const at = positionAt(car, simMs)
      const entry = phaseOf.get(car.orderId)
      const tone = entry ? toneOf(entry.phase) : "fine"
      const known = carMarks.current.get(car.orderId)
      if (!known) {
        const marker = leaflet.marker([at.lat, at.lng], { icon: leaflet.divIcon({ className: "node-wrap", html: carHtml(tone, at.heading, car.reference), iconSize: [30, 30], iconAnchor: [15, 15] }), interactive: false, keyboard: false, zIndexOffset: 1000 })
          .addTo(layers.current.nodes)
        carMarks.current.set(car.orderId, { marker, tone, heading: at.heading })
        continue
      }
      known.marker.setLatLng([at.lat, at.lng])
      const svg = known.marker.getElement()?.querySelector("svg")
      if (svg && Math.abs(known.heading - at.heading) > 1) { svg.style.transform = `rotate(${Math.round(at.heading)}deg)`; known.heading = at.heading }
      if (known.tone !== tone) {
        const span = known.marker.getElement()?.querySelector(".v")
        if (span) span.className = `v v-${tone} v-moving`
        known.tone = tone
        known.marker.setZIndexOffset(tone === "fine" ? 1000 : 3000)
      }
    }
    for (const { event, phase } of phaseOf.values()) {
      const car = cars.find((candidate) => candidate.orderId === event.orderId)
      if (!car) continue
      const at = positionAt(car, simMs)
      const known = eventMarks.current.get(event.id)
      if (phase === "none") {
        if (known) { known.marker.remove(); eventMarks.current.delete(event.id) }
        continue
      }
      if (!known) {
        const marker = leaflet.marker([at.lat, at.lng], { icon: leaflet.divIcon({ className: "tl-wrap", html: eventHtml(phase, event), iconSize: [44, 44], iconAnchor: [22, 22] }), interactive: false, keyboard: false, zIndexOffset: 5000 })
          .addTo(layers.current.nodes)
        eventMarks.current.set(event.id, { marker, phase })
      } else {
        known.marker.setLatLng([at.lat, at.lng])
        if (known.phase !== phase) { known.marker.setIcon(leaflet.divIcon({ className: "tl-wrap", html: eventHtml(phase, event), iconSize: [44, 44], iconAnchor: [22, 22] })); known.phase = phase }
      }
      // A cleared mark fades over FADE seconds, driven by film time so a still or a pause shows the same picture.
      const element = eventMarks.current.get(event.id)?.marker.getElement()
      if (element) element.style.opacity = phase.startsWith("cleared") ? String(Math.max(0, 1 - (t - event.end) / FADE)) : "1"
    }
  }, [ready, t, events, cars, duration])

  // ---- keys: space or R plays again
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === " " || event.key.toLowerCase() === "r") { event.preventDefault(); restart() }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })
  const restart = () => { if (freeze != null) return; setT(0); setState("playing"); setRun((n) => n + 1) }

  // The film second with the most needing a person, so a recording script can take its still there.
  const peakAt = useMemo(() => {
    let best = { count: -1, at: 0 }
    for (let second = 0; second <= duration; second += 0.05) {
      const count = tallyAt(events, second).needAPerson
      if (count > best.count) best = { count, at: second }
    }
    return best.at
  }, [events, duration])
  const tally = tallyAt(events, t)
  const sim = simTimeAt(t, duration).toISOString()
  const calm = t >= duration - CALM_HOLD
  const stage = <div className={`chart-home tl-stage z-low`} data-chart={theme} data-peak={peakAt.toFixed(2)} data-state={state}>
    <div ref={holder} className="chart-map" role="region" aria-label="Map of deliveries. Car positions are simulated." />
    <div className="tl-hud" aria-live="off">
      <div className="tl-clock">{dayOf(sim)} <b className="num">{clockOf(sim)}</b> UTC<small>simulated</small></div>
      <div className={`tl-need${tally.needAPerson > 0 ? " hot" : ""}`}><b>{tally.needAPerson}</b><span>need a person</span></div>
      <div className="tl-tallies"><span>Agent handled <b>{tally.agentHandled}</b></span><span>A person decided <b>{tally.personDecided}</b></span></div>
    </div>
    <div className="tl-foot">
      <div className="tl-legend" aria-label="Legend">
        <span><i className="lg-red" />Needs a person</span>
        <span><i className="lg-teal" />The agent is working</span>
        <span><svg viewBox="0 0 24 24" style={{ background: "var(--c-ok)", borderRadius: "50%", fill: "none", stroke: "#fff", strokeWidth: 3, strokeLinecap: "round", strokeLinejoin: "round" }}><path d="M5.5 12.5l4.2 4.2 8.8-9.4" /></svg>Cleared by the agent</span>
        <span><svg viewBox="0 0 24 24" style={{ background: "var(--c-ok)", borderRadius: "50%", fill: "none", stroke: "#fff", strokeWidth: 2.4, strokeLinecap: "round" }}><circle cx="12" cy="8.6" r="3" /><path d="M6.4 18.6c.6-3 2.8-4.6 5.6-4.6s5 1.6 5.6 4.6" /></svg>Cleared by a person</span>
      </div>
      <div className="tl-caption">{TIMELAPSE_CAPTION}</div>
    </div>
    {state === "waiting" && <div className="tl-start"><button type="button" onClick={restart}>Click to play the day</button></div>}
    {!clean && state === "done" && <button type="button" className="tl-again" onClick={restart}>Play again</button>}
  </div>
  if (clean) return <div className="tl-fill">{stage}</div>
  return <AppFrame section="map" rail>{stage}</AppFrame>
}

export { DEFAULT_DURATION, DEFAULT_SEED }
