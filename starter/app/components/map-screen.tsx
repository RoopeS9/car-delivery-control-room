"use client"

import Link from "next/link"
import { useEffect, useRef, useState } from "react"
import type { Map as LeafletMap, LayerGroup } from "leaflet"
import "leaflet/dist/leaflet.css"
import { fmtLong } from "@/lib/present/time"
import type { MapMarker, MapView } from "@/lib/present/types"
import { Icon } from "./icons"
import { MakeMark } from "./queue"

// Stadia's calm basemaps need no key on localhost, where the demo runs. If they
// fail (another host, no network), fall back to OpenStreetMap's own tiles,
// toned down with a CSS filter to match the theme.
const TILES = {
  light: "https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png",
  dark: "https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png",
  fallback: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
}
const ATTRIBUTION = '&copy; <a href="https://stadiamaps.com/">Stadia Maps</a> &copy; <a href="https://openmaptiles.org/">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
const FALLBACK_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'

/** The theme the page is showing: a saved choice, else the system setting. */
function currentTheme(): "light" | "dark" {
  const saved = document.documentElement.dataset.theme
  if (saved === "light" || saved === "dark") return saved
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

function useTheme(): "light" | "dark" | null {
  const [theme, setTheme] = useState<"light" | "dark" | null>(null)
  useEffect(() => {
    const update = () => setTheme(currentTheme())
    update()
    const media = window.matchMedia("(prefers-color-scheme: dark)")
    media.addEventListener("change", update)
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] })
    return () => { media.removeEventListener("change", update); observer.disconnect() }
  }, [])
  return theme
}

function markerHtml(marker: MapMarker, selected: boolean): string {
  const classes = ["pin", `pin-${marker.state}`, `pin-tone-${marker.tone}`, marker.stale ? "pin-stale" : "", selected ? "pin-selected" : ""].filter(Boolean).join(" ")
  return `<span class="${classes}"></span>`
}

const LEGEND: { state: string; label: string }[] = [
  { state: "decide", label: "Needs your decision" },
  { state: "agent", label: "Agent working" },
  { state: "waiting", label: "Waiting on others" },
  { state: "fine", label: "No open case" },
  { state: "stale", label: "Position is old" },
]

export function MapScreen({ view }: { view: MapView }) {
  const holder = useRef<HTMLDivElement>(null)
  const map = useRef<LeafletMap | null>(null)
  const layer = useRef<LayerGroup | null>(null)
  const tiles = useRef<import("leaflet").TileLayer | null>(null)
  const leaflet = useRef<typeof import("leaflet") | null>(null)
  const fitted = useRef(false)
  const [ready, setReady] = useState(false)
  const [fallback, setFallback] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const theme = useTheme()
  const selected = view.markers.find((marker) => marker.orderId === selectedId) ?? null

  // Leaflet needs the window, so it loads in the browser only.
  useEffect(() => {
    let cancelled = false
    void import("leaflet").then((L) => {
      if (cancelled || !holder.current || map.current) return
      leaflet.current = L
      map.current = L.map(holder.current, { zoomControl: true, attributionControl: true, worldCopyJump: true }).setView([56.5, 15], 5)
      layer.current = L.layerGroup().addTo(map.current)
      setReady(true)
    })
    return () => { cancelled = true; map.current?.remove(); map.current = null }
  }, [])

  useEffect(() => {
    const L = leaflet.current
    if (!ready || !L || !map.current || !theme) return
    tiles.current?.remove()
    let errors = 0
    tiles.current = fallback
      ? L.tileLayer(TILES.fallback, { attribution: FALLBACK_ATTRIBUTION, maxZoom: 18 }).addTo(map.current)
      : L.tileLayer(TILES[theme], { attribution: ATTRIBUTION, maxZoom: 18 })
        .on("tileerror", () => { errors += 1; if (errors === 4) setFallback(true) })
        .addTo(map.current)
  }, [ready, theme, fallback])

  useEffect(() => {
    const L = leaflet.current
    if (!ready || !L || !map.current || !layer.current) return
    layer.current.clearLayers()
    for (const marker of view.markers) {
      const icon = L.divIcon({ className: "pin-wrap", html: markerHtml(marker, marker.orderId === selectedId), iconSize: [22, 22], iconAnchor: [11, 11] })
      L.marker([marker.lat, marker.lng], { icon, title: `${marker.vehicle} ${marker.reference}`, keyboard: true, zIndexOffset: marker.state === "decide" ? 1000 : marker.state === "fine" ? 0 : 500 })
        .on("click", () => setSelectedId(marker.orderId))
        .addTo(layer.current)
    }
    if (!fitted.current && view.markers.length) {
      fitted.current = true
      map.current.fitBounds(L.latLngBounds(view.markers.map((marker) => [marker.lat, marker.lng] as [number, number])), { padding: [60, 60], maxZoom: 7 })
    }
  }, [ready, view.markers, selectedId])

  function focus(marker: MapMarker) {
    setSelectedId(marker.orderId)
    map.current?.flyTo([marker.lat, marker.lng], Math.max(map.current.getZoom(), 7), { duration: 0.6 })
  }

  const needs = view.markers.filter((marker) => marker.state !== "fine")
  const fine = view.markers.filter((marker) => marker.state === "fine")

  return <main className="map-page">
    <div className={`map-canvas${fallback ? " osm-fallback" : ""}`}>
      <div ref={holder} className="map-holder" aria-label="Map of cars with a simulated phone position" role="region" />
      <div className="map-badge"><Icon name="pin" size={13} />Every position is simulated phone GPS</div>
      <ul className="map-legend" aria-label="Legend">{LEGEND.map((item) => <li key={item.state}><span className={`pin pin-${item.state === "stale" ? "fine pin-stale" : item.state}`} />{item.label}</li>)}</ul>
    </div>
    <aside className="map-side" aria-label="Cars on the map">
      {selected ? <MarkerPanel marker={selected} onClose={() => setSelectedId(null)} /> : <>
        <div className="map-side-head">
          <h1>Map</h1>
          <p>{view.markers.length} car{view.markers.length === 1 ? "" : "s"} with a position · {needs.length} with an open case</p>
        </div>
        {view.markers.length === 0 && <div className="map-empty">
          <b>No positions yet.</b>
          <p>Positions appear when the driver&apos;s phone reports (simulated in this prototype). {view.unplaced.length} car{view.unplaced.length === 1 ? " is" : "s are"} on the road without one.</p>
        </div>}
        {needs.length > 0 && <MarkerList title="Open cases" markers={needs} onPick={focus} />}
        {fine.length > 0 && <MarkerList title="On the road, no open case" markers={fine} onPick={focus} />}
        {view.unplaced.length > 0 && <details className="map-unplaced">
          <summary><Icon name="chevron" size={12} />On the road, no position ({view.unplaced.length})</summary>
          <ul>{view.unplaced.map((item) => <li key={item.orderId}><Link className="name-link" href={`/orders/${item.orderId}`}>{item.vehicle}</Link> <span className="mono">{item.reference}</span> · {item.route}</li>)}</ul>
        </details>}
      </>}
    </aside>
  </main>
}

function MarkerList({ title, markers, onPick }: { title: string; markers: MapMarker[]; onPick: (marker: MapMarker) => void }) {
  return <section className="map-group">
    <h2>{title} <span className="num">{markers.length}</span></h2>
    <ul>{markers.map((marker) => <li key={marker.orderId}>
      <button type="button" className="map-item" onClick={() => onPick(marker)}>
        <span className={`pin pin-${marker.state} pin-tone-${marker.tone}${marker.stale ? " pin-stale" : ""}`} />
        <span className="map-item-main">
          <b>{marker.vehicle}</b>
          <span className="map-item-sub"><span className="mono">{marker.reference}</span> · {marker.route}</span>
          {marker.caseTitle && <small>{marker.caseTitle}</small>}
        </span>
        <span className={`map-item-age${marker.stale ? " stale" : ""}`}>{marker.ageLabel}</span>
      </button>
    </li>)}</ul>
  </section>
}

function MarkerPanel({ marker, onClose }: { marker: MapMarker; onClose: () => void }) {
  return <div className="map-panel">
    <button type="button" className="map-back" onClick={onClose}><Icon name="chevron" size={12} style={{ transform: "rotate(180deg)" }} />All cars</button>
    <div className="map-panel-car"><MakeMark make={marker.vehicleMake} size={24} /><div><b>{marker.vehicle}</b><span className="mono">{marker.reference}</span></div></div>
    <p className="map-panel-route">{marker.route} · {marker.customer}{marker.driver ? ` · ${marker.driver}` : ""}</p>
    <p className={`map-panel-state tone-${marker.tone}`}>{marker.stateLabel}</p>
    {marker.caseTitle && <p className="map-panel-case">{marker.caseTitle}</p>}
    {marker.ask && <p className="map-panel-ask">{marker.ask}</p>}
    <dl className="map-panel-facts">
      <div><dt>Position</dt><dd>{marker.placeLabel ?? `${marker.lat.toFixed(3)}, ${marker.lng.toFixed(3)}`}</dd></div>
      <div><dt>Reported</dt><dd className={marker.stale ? "tone-warn" : undefined}><time dateTime={marker.at} title={fmtLong(marker.at)}>{marker.stale ? `last seen ${marker.ageLabel}` : marker.ageLabel}</time></dd></div>
      {marker.speedKmh != null && <div><dt>Speed</dt><dd>{marker.speedKmh} km/h</dd></div>}
      <div><dt>Source</dt><dd>Driver&apos;s phone GPS, simulated. Not a verified location.</dd></div>
    </dl>
    <Link className="btn primary map-open" href={`/orders/${marker.orderId}${marker.caseId ? "#case" : ""}`}>{marker.caseId ? "Open the case" : "Open the order"}</Link>
  </div>
}
