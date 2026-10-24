"use client"

import Link from "next/link"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { LayerGroup, Map as LeafletMap, Marker, Polyline, TileLayer } from "leaflet"
import "leaflet/dist/leaflet.css"
import "./chart.css"
import type { ChartCard, ChartNode, ChartView } from "@/lib/present/chart"
import { AppFrame } from "../app-frame"
import { tickCases } from "../live-refresh"
import { Icon } from "../icons"
import { Dossier } from "./dossier"
import { clockOf, dayOf } from "./format"

// Esri's canvas basemaps need no key (CARTO watermarks every tile without one,
// Stadia 401s off localhost). They follow the app's theme; OpenSeaMap's
// seamarks sit on top, dimmed, when zoomed in.
const TILES = {
  dark: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
  light: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
  seamarks: "https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png",
}
const ATTRIBUTION = 'Tiles &copy; <a href="https://www.esri.com/">Esri</a>, HERE, Garmin, GEBCO &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · Seamarks &copy; <a href="https://www.openseamap.org/">OpenSeaMap</a>'

const POLL_MS = 3000
const GLIDE_MS = 1400
const PULSE_MS = 9000
/** Below this zoom, orders waiting close together fold into a harbour mark; from here up every order is its own mark. */
const FAN_ZOOM = 6
/** Harbour marks gather cities whose marks would sit within this many pixels. */
const CLUSTER_PX = 28

type ChartTheme = "dark" | "light"

/** The app's theme: a saved choice, else the system setting. */
function readTheme(): ChartTheme {
  const saved = document.documentElement.dataset.theme
  if (saved === "light" || saved === "dark") return saved
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

const escape = (text: string) => text.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] as string)

const STATE_WORD: Record<ChartNode["attention"], string> = {
  decide: "Needs a person", agent: "Agent working", waiting: "Waiting on others", fine: "Nothing open",
}

function vesselHtml(node: ChartNode, selected: boolean): string {
  const moving = node.heading != null && (node.speedKmh ?? 0) > 0 && !node.stale
  const classes = ["v", `v-${node.attention}`, node.stale ? "v-stale" : "", selected ? "v-sel" : "", moving ? "v-moving" : "v-still"].filter(Boolean).join(" ")
  const shape = moving
    ? `<svg viewBox="0 0 20 20" style="transform:rotate(${Math.round(node.heading ?? 0)}deg)"><path d="M10 1.8 15.2 17.4 10 14.2 4.8 17.4Z"/></svg>`
    : `<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="3.8"/></svg>`
  return `<span class="${classes}">${shape}<span class="v-label">${escape(node.reference)}</span></span>`
}

function berthHtml(node: ChartNode, selected: boolean): string {
  return `<span class="b b-${node.attention} b-${node.lane}${selected ? " b-sel" : ""}"></span>`
}

function harbourHtml(nodes: ChartNode[]): string {
  const worst = nodes.some((node) => node.attention === "decide") ? "decide" : nodes.some((node) => node.attention === "agent") ? "agent" : nodes.some((node) => node.attention === "waiting") ? "waiting" : "fine"
  const decide = nodes.filter((node) => node.attention === "decide").length
  return `<span class="hb hb-${worst}"><b>${nodes.length}</b>${decide ? `<i>${decide}</i>` : ""}</span>`
}

function tipHtml(node: ChartNode): string {
  const where = node.kind === "vessel"
    ? `${escape(node.placeLabel ?? "Position reported")}<br><span class="tip-quiet">Simulated phone GPS · ${node.stale ? `last seen ${escape(node.ageLabel ?? "")}` : escape(node.ageLabel ?? "")}${node.speedKmh ? ` · ${node.speedKmh} km/h` : ""}</span>`
    : `<span class="tip-quiet">${escape(node.berthNote ?? "")}</span>`
  return `<div class="tip-head"><b>${escape(node.vehicle)}</b><span class="mono">${escape(node.reference)}</span></div>
    <div class="tip-route">${escape(node.from)} → ${escape(node.to)} · ${escape(node.laneLabel)}${node.driver ? ` · ${escape(node.driver)}` : ""}</div>
    <div class="tip-where">${where}</div>
    ${node.headline ? `<div class="tip-state tip-${node.attention}">${escape(STATE_WORD[node.attention])}: ${escape(node.headline)}</div>` : ""}`
}

function harbourTip(city: string, nodes: ChartNode[]): string {
  const byLane = new Map<string, number>()
  for (const node of nodes) byLane.set(node.laneLabel, (byLane.get(node.laneLabel) ?? 0) + 1)
  const decide = nodes.filter((node) => node.attention === "decide").length
  return `<div class="tip-head"><b>${escape(city)}</b></div>
    <div class="tip-route">${[...byLane].map(([lane, count]) => `${count} ${escape(lane.toLowerCase())}`).join(" · ")}</div>
    ${decide ? `<div class="tip-state tip-decide">${decide} need${decide === 1 ? "s" : ""} a person</div>` : ""}
    <div class="tip-quiet">Placed at the city from the records, not a position. Zoom in to see each order.</div>`
}

/** Pixel offsets on a sunflower spiral, so a city's berths fan out around its port mark. */
function fan(index: number): [number, number] {
  const angle = index * 2.39996
  const radius = 15 + 9.5 * Math.sqrt(index)
  return [Math.cos(angle) * radius, Math.sin(angle) * radius]
}

/** Index of the route point nearest to a position, so a track can be split where the car is. */
function nearestIndex(coords: [number, number][], lat: number, lng: number): number {
  let best = Infinity
  let nearest = 0
  const squeeze = Math.cos(lat * Math.PI / 180)
  coords.forEach((point, index) => {
    const distance = (point[0] - lat) ** 2 + ((point[1] - lng) * squeeze) ** 2
    if (distance < best) { best = distance; nearest = index }
  })
  return nearest
}

type Glide = { from: [number, number]; to: [number, number]; start: number }

export function ChartHome({ initial }: { initial: ChartView }) {
  const holder = useRef<HTMLDivElement>(null)
  const map = useRef<LeafletMap | null>(null)
  const L = useRef<typeof import("leaflet") | null>(null)
  const layers = useRef<{ trails: LayerGroup; route: LayerGroup; ports: LayerGroup; nodes: LayerGroup } | null>(null)
  const tiles = useRef<{ base: TileLayer; marks: TileLayer } | null>(null)
  const markers = useRef(new Map<string, { marker: Marker; html: string; trail: Polyline | null; tip: string }>())
  const tracks = useRef(new Map<string, { done: Polyline; ahead: Polyline }>())
  const glides = useRef(new Map<string, Glide>())
  const sigs = useRef(new Map<string, string>())
  const pulses = useRef(new Map<string, number>())
  const fixes = useRef(new Map<string, string>())
  const [view, setView] = useState(initial)
  const [fetchedAt, setFetchedAt] = useState(() => Date.now())
  const [ready, setReady] = useState(false)
  const [zoom, setZoom] = useState(5)
  const [theme, setTheme] = useState<ChartTheme>("dark")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [, setTick] = useState(0)
  const [offline, setOffline] = useState(false)
  const [replay, setReplay] = useState<Replay | null>(null)

  // While replaying, vessels sit at their last stored fix at the chosen time; no fix then, no vessel.
  const nodes = useMemo(() => {
    if (!replay) return view.nodes
    return view.nodes.flatMap((node) => {
      if (node.kind !== "vessel") return [node]
      const fix = replay.fixes.get(node.orderId)
      return fix ? [{ ...node, lat: fix.lat, lng: fix.lng, heading: fix.heading, at: fix.at, trail: [], placeLabel: `Replay: stored fix at ${clockOf(fix.at)} UTC`, ageLabel: "replay" }] : []
    })
  }, [view.nodes, replay])
  const byId = useMemo(() => new Map(nodes.map((node) => [node.orderId, node])), [nodes])
  const selected = selectedId ? byId.get(selectedId) ?? null : null

  // ---- map setup (Leaflet needs the window)
  useEffect(() => {
    setTheme(readTheme())
    let cancelled = false
    void import("leaflet").then((leaflet) => {
      if (cancelled || !holder.current || map.current) return
      L.current = leaflet
      const m = leaflet.map(holder.current, { zoomControl: false, attributionControl: true, worldCopyJump: true, minZoom: 4, maxZoom: 16, zoomSnap: 1, trackResize: false })
      m.fitBounds([[47.5, 4.5], [64.5, 27.5]], { paddingTopLeft: [80, 60], paddingBottomRight: [40, 30] })
      leaflet.control.zoom({ position: "bottomright" }).addTo(m)
      m.createPane("trails").style.zIndex = "420"
      m.createPane("route").style.zIndex = "430"
      m.createPane("ports").style.zIndex = "440"
      layers.current = {
        trails: leaflet.layerGroup().addTo(m), route: leaflet.layerGroup().addTo(m),
        ports: leaflet.layerGroup().addTo(m), nodes: leaflet.layerGroup().addTo(m),
      }
      m.on("zoomend", () => setZoom(m.getZoom()))
      m.on("click", () => setSelectedId(null))
      setZoom(m.getZoom())
      map.current = m
      // Resizing (dragging the window edge) keeps the centre still: the map follows once per frame, not after the drag.
      let frame = 0
      let centre = m.getCenter()
      m.on("moveend", () => { centre = m.getCenter() })
      const resized = new ResizeObserver(() => {
        cancelAnimationFrame(frame)
        frame = requestAnimationFrame(() => {
          if (!map.current) return
          const keep = centre
          map.current.invalidateSize({ animate: false, pan: false })
          map.current.setView(keep, map.current.getZoom(), { animate: false })
          centre = keep
        })
      })
      resized.observe(holder.current)
      m.on("unload", () => { resized.disconnect(); cancelAnimationFrame(frame) })
      setReady(true)
    })
    const observer = new MutationObserver(() => setTheme(readTheme()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] })
    const media = window.matchMedia("(prefers-color-scheme: dark)")
    const onMedia = () => setTheme(readTheme())
    media.addEventListener("change", onMedia)
    return () => { cancelled = true; observer.disconnect(); media.removeEventListener("change", onMedia); map.current?.remove(); map.current = null }
  }, [])

  // ---- tiles follow the chart theme
  useEffect(() => {
    const leaflet = L.current
    if (!ready || !leaflet || !map.current) return
    tiles.current?.base.remove()
    tiles.current?.marks.remove()
    tiles.current = {
      base: leaflet.tileLayer(TILES[theme], { attribution: ATTRIBUTION, maxZoom: 16, maxNativeZoom: 16 }).addTo(map.current),
      marks: leaflet.tileLayer(TILES.seamarks, { minZoom: 9, maxZoom: 16, opacity: 0.22, className: "seamarks" }).addTo(map.current),
    }
  }, [ready, theme])

  // ---- poll the chart while the tab is visible
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    const poll = async () => {
      if (document.visibilityState === "visible") {
        try {
          await tickCases()
          const response = await fetch("/api/chart", { cache: "no-store" })
          if (!response.ok) throw new Error(String(response.status))
          const next = (await response.json()) as ChartView
          if (!stopped) { setView(next); setFetchedAt(Date.now()); setOffline(false) }
        } catch {
          if (!stopped) setOffline(true)
        }
      }
      if (!stopped) timer = setTimeout(poll, POLL_MS)
    }
    timer = setTimeout(poll, POLL_MS)
    const clock = setInterval(() => setTick((tick) => tick + 1), 1000)
    return () => { stopped = true; clearTimeout(timer); clearInterval(clock) }
  }, [])

  // ---- glide markers between reported positions
  useEffect(() => {
    let frame = 0
    const step = () => {
      const now = performance.now()
      for (const [id, glide] of glides.current) {
        const entry = markers.current.get(id)
        if (!entry) { glides.current.delete(id); continue }
        const t = Math.min(1, (now - glide.start) / GLIDE_MS)
        const ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
        entry.marker.setLatLng([glide.from[0] + (glide.to[0] - glide.from[0]) * ease, glide.from[1] + (glide.to[1] - glide.from[1]) * ease])
        if (t >= 1) glides.current.delete(id)
      }
      frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [])

  // ---- ports: terminals always, dealers and yards when zoomed in (CSS hides them below)
  useEffect(() => {
    const leaflet = L.current
    if (!ready || !leaflet || !layers.current) return
    layers.current.ports.clearLayers()
    for (const port of view.ports) {
      const terminal = port.kind === "terminal"
      const html = terminal
        ? `<span class="pt pt-terminal"><svg viewBox="0 0 16 16"><path d="M8 3.2v9.6M5.2 5.4h5.6M3.4 9.2c.6 2.2 2.4 3.6 4.6 3.6s4-1.4 4.6-3.6"/><circle cx="8" cy="2.6" r="1.2"/></svg><span class="pt-label">${escape(port.name)}</span></span>`
        : `<span class="pt pt-${port.kind}" title=""></span>`
      leaflet.marker([port.lat, port.lng], {
        pane: "ports", interactive: true, keyboard: false,
        icon: leaflet.divIcon({ className: "pt-wrap", html, iconSize: terminal ? [22, 22] : [8, 8], iconAnchor: terminal ? [-10, -8] : [4, 4] }),
      }).bindTooltip(terminal ? `<b>${escape(port.name)}</b><div class="tip-quiet">Ferry terminal. Fictional; placed at city level, no gate address recorded.</div>`
        : `<b>${port.count} ${port.kind === "yard" ? "yard" : "dealer"}${port.count === 1 ? "" : "s"} in ${escape(port.name)}</b><div class="tip-quiet">Sites from the records, drawn at the city centre.</div>`, { className: "chart-tip", direction: "top", offset: [0, -8] })
        .addTo(layers.current.ports)
    }
  }, [ready, view.ports])

  // ---- nodes: vessels, berths (fanned out when zoomed in) and harbour marks
  useEffect(() => {
    const leaflet = L.current
    if (!ready || !leaflet || !layers.current || !map.current) return
    const seen = new Set<string>()
    const clock = performance.now()
    const fanOut = zoom >= FAN_ZOOM
    const berths = new Map<string, ChartNode[]>()
    for (const node of nodes) if (node.kind === "berth" && node.berth) berths.set(node.berth, [...(berths.get(node.berth) ?? []), node])

    const place = (key: string, at: [number, number], html: string, tip: string, size: number, anchor: [number, number], z: number, onClick: () => void, trail: [number, number][] | null, hoverOrder: string | null) => {
      seen.add(key)
      const look = `${html}|${size}|${anchor.join(",")}`
      const existing = markers.current.get(key)
      if (existing) {
        if (existing.html !== look) {
          existing.marker.setIcon(leaflet.divIcon({ className: "node-wrap", html, iconSize: [size, size], iconAnchor: anchor }))
          existing.html = look
        }
        if (existing.tip !== tip) { existing.marker.setTooltipContent(tip); existing.tip = tip }
        const current = existing.marker.getLatLng()
        if (Math.abs(current.lat - at[0]) > 1e-7 || Math.abs(current.lng - at[1]) > 1e-7) glides.current.set(key, { from: [current.lat, current.lng], to: at, start: clock })
        existing.marker.setZIndexOffset(z)
        if (trail && existing.trail) existing.trail.setLatLngs(trail)
        existing.marker.off("click").on("click", onClick)
        return
      }
      const marker = leaflet.marker(at, { icon: leaflet.divIcon({ className: "node-wrap", html, iconSize: [size, size], iconAnchor: anchor }), keyboard: true, zIndexOffset: z, riseOnHover: true })
        .bindTooltip(tip, { className: "chart-tip", direction: "top", offset: [0, -10], opacity: 1 })
        .on("click", onClick)
        .on("mouseover", () => hoverOrder && setHoverId(hoverOrder))
        .on("mouseout", () => hoverOrder && setHoverId((id) => (id === hoverOrder ? null : id)))
        .addTo(layers.current!.nodes)
      const line = trail ? leaflet.polyline(trail, { pane: "trails", className: "trail", weight: 2, interactive: false }).addTo(layers.current!.trails) : null
      // New marks fade and scale in once; later icon changes do not re-animate.
      const element = marker.getElement()
      if (element) { element.classList.add("fresh"); setTimeout(() => element.classList.remove("fresh"), 400) }
      markers.current.set(key, { marker, html: look, trail: line, tip })
    }

    // One layering for every mark: berths, then harbours, then vessels; within each, more urgent on top; the selection above all.
    const rank = { decide: 300, agent: 200, waiting: 100, fine: 0 }
    const layer = { berth: 100, still: 400, harbour: 500, vessel: 1000 }
    const zFor = (kind: keyof typeof layer, attention: ChartNode["attention"], isSelected = false) => layer[kind] + rank[attention] + (isSelected ? 5000 : 0)
    for (const node of nodes) {
      const isSelected = node.orderId === selectedId
      const select = (event?: { originalEvent?: Event }) => { event?.originalEvent?.stopPropagation(); setSelectedId(node.orderId) }
      if (node.kind === "vessel") {
        place(node.orderId, [node.lat, node.lng], vesselHtml(node, isSelected), tipHtml(node), 26, [13, 13], zFor(node.heading != null && (node.speedKmh ?? 0) > 0 && !node.stale ? "vessel" : "still", node.attention, isSelected), select, null, node.orderId)
      }
    }
    // Below FAN_ZOOM, cities whose berths would overlap on screen share one harbour mark (greedy, most urgent city first).
    // From FAN_ZOOM up nothing is grouped; only orders at the very same point fan out around it.
    const urgency = (group: ChartNode[]) => Math.max(...group.map((node) => rank[node.attention]))
    const cities = [...berths].sort((a, b) => urgency(b[1]) - urgency(a[1]) || b[1].length - a[1].length)
    const harbours: { key: string; anchor: ChartNode; nodes: ChartNode[]; point: { x: number; y: number }; names: string[] }[] = []
    if (!fanOut) {
      for (const [city, group] of cities) {
        const point = map.current.latLngToLayerPoint([group[0].lat, group[0].lng])
        const near = harbours.find((harbour) => Math.hypot(harbour.point.x - point.x, harbour.point.y - point.y) < CLUSTER_PX)
        if (near) { near.nodes.push(...group); near.names.push(city.split("|")[0]); near.key += `+${city}` }
        else harbours.push({ key: `harbour:${city}`, anchor: group[0], nodes: [...group], point, names: [city.split("|")[0]] })
      }
    }
    const spread = (group: ChartNode[]) => {
      const sorted = [...group].sort((a, b) => rank[b.attention] - rank[a.attention] || a.reference.localeCompare(b.reference))
      sorted.forEach((node, index) => {
        const [dx, dy] = sorted.length === 1 ? [0, 0] : fan(index)
        const isSelected = node.orderId === selectedId
        const size = node.attention === "decide" ? 16 : 12
        place(node.orderId, [node.lat, node.lng], berthHtml(node, isSelected), tipHtml(node), size, [Math.round(size / 2 - dx), Math.round(size / 2 - dy)], zFor("berth", node.attention, isSelected),
          (event?: { originalEvent?: Event }) => { event?.originalEvent?.stopPropagation(); setSelectedId(node.orderId) }, null, node.orderId)
      })
    }
    if (fanOut) for (const [, group] of berths) spread(group)
    for (const harbour of harbours) {
      if (harbour.nodes.length === 1) { spread(harbour.nodes); continue }
      const sorted = [...harbour.nodes].sort((a, b) => rank[b.attention] - rank[a.attention] || a.reference.localeCompare(b.reference))
      const at = harbour.anchor
      place(harbour.key, [at.lat, at.lng], harbourHtml(sorted), harbourTip(harbour.names.join(", "), sorted), 32, [16, 16], zFor("harbour", sorted[0].attention),
        () => map.current?.flyTo([at.lat, at.lng], Math.max(FAN_ZOOM, (map.current?.getZoom() ?? 5) + 1), { duration: 0.6 }), null, null)
    }
    for (const [key, entry] of markers.current) {
      if (seen.has(key)) continue
      // Fade out rather than vanish, so a harbour folding into berths reads as one motion.
      markers.current.delete(key)
      glides.current.delete(key)
      const element = entry.marker.getElement()
      element?.classList.add("leaving")
      entry.marker.off()
      setTimeout(() => { entry.marker.remove(); entry.trail?.remove() }, element ? 180 : 0)
    }

    // A node whose state changed since the last poll pulses for a few seconds.
    const wall = Date.now()
    for (const node of nodes) {
      const before = sigs.current.get(node.orderId)
      if (before !== undefined && before !== node.sig) pulses.current.set(node.orderId, wall + PULSE_MS)
      sigs.current.set(node.orderId, node.sig)
    }
    // A fresh phone fix: one small ping, the chart's heartbeat.
    for (const node of nodes) {
      if (node.kind !== "vessel" || !node.at) continue
      const before = fixes.current.get(node.orderId)
      fixes.current.set(node.orderId, node.at)
      if (!before || before === node.at) continue
      const element = markers.current.get(node.orderId)?.marker.getElement()
      if (!element) continue
      element.classList.remove("ping")
      void element.offsetWidth
      element.classList.add("ping")
      setTimeout(() => element.classList.remove("ping"), 1800)
    }
    for (const [id, until] of pulses.current) {
      const element = markers.current.get(id)?.marker.getElement()
      if (until < wall) { pulses.current.delete(id); element?.classList.remove("pulse"); continue }
      element?.classList.add("pulse")
    }
  }, [ready, nodes, zoom, selectedId])

  // ---- every moving car's whole route, always: quiet, brighter behind the car
  useEffect(() => {
    const leaflet = L.current
    if (!ready || !leaflet || !layers.current) return
    const keep = new Set<string>()
    for (const node of nodes) {
      const route = view.routes[node.orderId]
      if (node.kind !== "vessel" || !route) continue
      keep.add(node.orderId)
      const coords = route.parts.flatMap((part) => part.coords)
      const split = nearestIndex(coords, node.lat, node.lng)
      const done = [...coords.slice(0, split + 1), [node.lat, node.lng] as [number, number]]
      const ahead = [[node.lat, node.lng] as [number, number], ...coords.slice(split + 1)]
      const known = tracks.current.get(node.orderId)
      if (known) { known.done.setLatLngs(done); known.ahead.setLatLngs(ahead); continue }
      tracks.current.set(node.orderId, {
        ahead: leaflet.polyline(ahead, { pane: "trails", className: "route-ahead", weight: 1, interactive: false }).addTo(layers.current.trails),
        done: leaflet.polyline(done, { pane: "trails", className: "route-done", weight: 1, interactive: false }).addTo(layers.current.trails),
      })
    }
    for (const [id, track] of tracks.current) {
      if (keep.has(id)) continue
      track.done.remove(); track.ahead.remove(); tracks.current.delete(id)
    }
  }, [ready, nodes, view.routes])

  // ---- the route track: brightened for the hovered or selected node, with its endpoints named
  const trackId = hoverId ?? selectedId
  useEffect(() => {
    const leaflet = L.current
    if (!ready || !leaflet || !layers.current) return
    layers.current.route.clearLayers()
    if (!trackId) return
    const route = view.routes[trackId]
    const node = byId.get(trackId)
    if (!route || !node) return
    // Split the track where the car is: the part behind it is drawn brighter.
    const all = route.parts.flatMap((part) => part.coords.map((coord) => ({ coord, kind: part.kind })))
    const nearest = node.kind === "vessel" ? nearestIndex(all.map((point) => point.coord), node.lat, node.lng) : 0
    let offset = 0
    for (const part of route.parts) {
      const start = offset
      offset += part.coords.length
      const done = part.coords.slice(0, Math.max(0, Math.min(part.coords.length, nearest - start + 1)))
      const ahead = part.coords.slice(Math.max(0, Math.min(part.coords.length - 1, nearest - start)))
      const sea = part.kind === "sea"
      if (ahead.length > 1) leaflet.polyline(ahead, { pane: "route", className: `track track-ahead${sea ? " track-sea" : ""}`, weight: 2, interactive: false }).addTo(layers.current.route)
      if (done.length > 1) leaflet.polyline(done, { pane: "route", className: `track track-done${sea ? " track-sea" : ""}`, weight: 2.5, interactive: false }).addTo(layers.current.route)
    }
    const first = route.parts[0]?.coords[0]
    const last = route.parts.at(-1)?.coords.at(-1)
    const end = (point: [number, number] | undefined, text: string) => point && leaflet.circleMarker(point, { pane: "route", radius: 4, className: "track-end", interactive: false })
      .bindTooltip(text, { permanent: true, direction: "right", offset: [8, 0], className: "track-label" }).addTo(layers.current!.route)
    end(first, `Pickup · ${node.from}`)
    end(last, `Delivery · ${node.to}`)
  }, [ready, trackId, view.routes, byId])

  // ---- keyboard: Escape closes, [ and ] step through what needs a person
  const needIds = useMemo(() => view.needs.map((needed) => needed.orderId).filter((id) => byId.has(id)), [view.needs, byId])
  const focus = useCallback((id: string) => {
    const node = byId.get(id)
    setSelectedId(id)
    if (node && map.current) {
      const target = Math.max(map.current.getZoom(), FAN_ZOOM)
      map.current.flyTo([node.lat, node.lng], target, { duration: 0.7 })
    }
  }, [byId])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && ["INPUT", "TEXTAREA"].includes(event.target.tagName)) return
      if (event.key === "Escape") setSelectedId(null)
      if ((event.key === "]" || event.key === "[") && needIds.length) {
        const index = selectedId ? needIds.indexOf(selectedId) : -1
        const next = event.key === "]" ? (index + 1) % needIds.length : (index - 1 + needIds.length) % needIds.length
        focus(needIds[next])
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [needIds, selectedId, focus])

  const simNow = new Date(Date.parse(view.simNow) + (Date.now() - fetchedAt)).toISOString()

  return <AppFrame section="map" rail snapshotAt={view.snapshotAt} counts={{ map: view.needs.length }}
>
    <div className={`chart-home z-${zoom < 6 ? "low" : zoom < 8 ? "mid" : "high"}${selected ? " has-dossier" : ""}`} data-chart={theme}>
      <div ref={holder} className="chart-map" role="region" aria-label="Map of deliveries. Car positions are simulated phone GPS." />

      {!selected && <NeedsPeek view={view} onPick={focus} onHover={setHoverId} selectedId={selectedId} />}

      {selected && <Dossier key={selected.orderId} node={selected} onClose={() => setSelectedId(null)} />}

      <div className="chart-strip" aria-label="Fleet at a glance">
        <span className="strip-clock" title="The simulated clock: the dataset snapshot plus the time since the app started">
          {dayOf(simNow)} <b className="num">{clockOf(simNow, true)}</b> UTC, simulated
        </span>
        <span className="strip-counts">
          <span><b className="num">{view.counts.moving}</b> moving</span>
          <span><b className="num">{view.counts.booked}</b> booked</span>
          <span title="Booked orders whose pickup slot has started and no pickup is recorded"><b className="num">{view.counts.atPickup}</b> pickup due</span>
          <span><b className="num">{view.counts.deliveredToday}</b> delivered today</span>
          {offline && <span className="tone-warn">Reconnecting</span>}
        </span>
        <span className="strip-legend" aria-label="Legend">
          <span><i className="lg lg-decide" />Needs a person</span>
          <span><i className="lg lg-agent" />Agent working</span>
          <span><i className="lg lg-fine" />Moving</span>
          <span><i className="lg lg-stale" />Phone quiet</span>
          <span><i className="lg lg-berth" />Waiting in the city</span>
          <span><i className="lg lg-done" />Delivered</span>
        </span>
        <span className="strip-note">Car positions are simulated phone GPS</span>
      </div>

      <Scrubber simNow={simNow} replay={replay} onReplay={setReplay} />
    </div>
  </AppFrame>
}

type Replay = { at: string; fixes: Map<string, { lat: number; lng: number; heading: number | null; at: string }> }

/** Scrub back over the stored simulated fixes. Live updates keep arriving; positions show the chosen time until "Live". */
function Scrubber({ simNow, replay, onReplay }: { simNow: string; replay: Replay | null; onReplay: (replay: Replay | null) => void }) {
  const [first, setFirst] = useState<string | null>(null)
  const [value, setValue] = useState<number | null>(null)
  const request = useRef(0)
  const end = Date.parse(simNow)
  const start = first ? Date.parse(first) : end
  const minutes = Math.max(0, Math.floor((end - start) / 60000))

  const open = async () => {
    const response = await fetch("/api/chart/replay", { cache: "no-store" }).catch(() => null)
    const span = response?.ok ? (await response.json()) as { first: string | null } : null
    setFirst(span?.first ?? null)
    setValue(0)
  }
  const seek = async (back: number) => {
    setValue(back)
    if (back === 0) { onReplay(null); return }
    const at = new Date(end - back * 60000).toISOString()
    const id = ++request.current
    const response = await fetch(`/api/chart/replay?at=${encodeURIComponent(at)}`, { cache: "no-store" }).catch(() => null)
    if (!response?.ok || id !== request.current) return
    const data = (await response.json()) as { fixes: { orderId: string; lat: number; lng: number; heading: number | null; at: string }[] }
    onReplay({ at, fixes: new Map(data.fixes.map((fix) => [fix.orderId, fix])) })
  }
  const close = () => { request.current += 1; setValue(null); onReplay(null) }

  if (value === null) return <button type="button" className="scrub-open" onClick={() => void open()} title="Replay the stored phone fixes">
    <Icon name="waiting" size={13} />Replay
  </button>
  return <div className={`scrub${replay ? " scrubbing" : ""}`} role="group" aria-label="Replay stored positions">
    <span className="scrub-time"><b className="num">{replay ? clockOf(replay.at) : "Live"}</b>{replay ? ` UTC · ${value} min ago` : ""}</span>
    <input type="range" min={0} max={minutes} step={1} value={minutes - (value ?? 0)} aria-label="Minutes back"
      onChange={(event) => void seek(minutes - Number(event.target.value))} disabled={minutes === 0} />
    <span className="scrub-note">{minutes === 0 ? "No stored fixes yet" : `stored simulated fixes since ${clockOf(first)} UTC`}</span>
    <button type="button" onClick={close}>{replay ? "Back to live" : "Close"}</button>
  </div>
}

/**
 * What needs a person, on the map itself: folded, the most urgent item and how
 * many more; open, at most six cards, the rest in Needs you, and what the agent
 * closed today folded below.
 */
function NeedsPeek({ view, onPick, onHover, selectedId }: { view: ChartView; onPick: (id: string) => void; onHover: (id: string | null) => void; selectedId: string | null }) {
  const [open, setOpen] = useState(false)
  const top = view.needs[0]
  if (!top) return <div className="needs-peek needs-calm"><span className="peek-count">Nothing needs a person right now</span><span className="peek-hint">The agent is watching {view.counts.moving} moving cars.</span></div>
  if (!open) return <div className="needs-peek" data-tone={top.tone}>
    <span className="q-bar" aria-hidden="true" />
    <button type="button" className="peek-main" onClick={() => onPick(top.orderId)} onMouseEnter={() => onHover(top.orderId)} onMouseLeave={() => onHover(null)}>
      <span className="peek-count">{view.needs.length} need{view.needs.length === 1 ? "s" : ""} a person · most urgent</span>
      <span className="peek-car"><b>{top.vehicle}</b><span className="q-ref">{top.reference}</span></span>
      <span className="peek-what">{top.headline}</span>
    </button>
    {view.needs.length > 1 && <button type="button" className="peek-more" onClick={() => setOpen(true)}>Show all {view.needs.length} <Icon name="chevron" size={11} style={{ transform: "rotate(90deg)" }} /></button>}
  </div>
  const shown = view.needs.slice(0, 6)
  return <section className="needs-peek needs-open" aria-label="Needs a person">
    <header><span className="peek-count">{view.needs.length} need{view.needs.length === 1 ? "s" : ""} a person</span>
      <button type="button" className="peek-more" onClick={() => setOpen(false)}>Fold <Icon name="chevron" size={11} style={{ transform: "rotate(-90deg)" }} /></button></header>
    <ul className="needs-list">{shown.map((item) => <NeedCard key={item.orderId} item={item} active={item.orderId === selectedId} onPick={onPick} onHover={onHover} />)}</ul>
    {view.needs.length > shown.length && <Link className="needs-more" href="/queue">{view.needs.length - shown.length} more in Needs you <Icon name="arrow" size={12} /></Link>}
    <details className="needs-fold">
      <summary><Icon name="chevron" size={11} />Handled by the agent today <span className="num">{view.handled.length}</span></summary>
      {view.handled.length === 0 ? <p className="needs-empty">Nothing closed by the agent yet in this simulated day.</p>
        : <ul className="needs-list">{view.handled.map((item) => <NeedCard key={`h-${item.orderId}-${item.since}`} item={item} active={false} onPick={onPick} onHover={onHover} />)}</ul>}
    </details>
  </section>
}

function NeedCard({ item, active, onPick, onHover }: { item: ChartCard; active: boolean; onPick: (id: string) => void; onHover: (id: string | null) => void }) {
  return <li onMouseEnter={() => onHover(item.orderId)} onMouseLeave={() => onHover(null)}>
    <button type="button" className={`need${active ? " active" : ""}`} data-tone={item.tone} onClick={() => onPick(item.orderId)}>
      <span className="q-bar" aria-hidden="true" />
      <span className="need-top"><b>{item.vehicle}</b><span className="q-ref">{item.reference}</span></span>
      <span className="need-what">{item.headline}</span>
      <span className="need-foot">{item.source} · {item.sinceLabel}</span>
    </button>
  </li>
}
