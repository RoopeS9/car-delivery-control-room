"use client"

import Link from "next/link"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { LayerGroup, Map as LeafletMap, Marker, Polyline, TileLayer } from "leaflet"
import "leaflet/dist/leaflet.css"
import "./chart.css"
import type { ChartCard, ChartNode, ChartView } from "@/lib/present/chart"
import { AppFrame } from "../app-frame"
import { recall, remember } from "../role-memory"
import { tickCases } from "../live-refresh"
import { Icon } from "../icons"
import { Dossier } from "./dossier"
import { clockOf, dayOf } from "./format"

// Esri's canvas basemaps need no key (CARTO watermarks every tile without one,
// Stadia 401s off localhost). They follow the app's theme; OpenSeaMap's
// seamarks sit on top, dimmed, when zoomed in.
export const TILES = {
  dark: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
  light: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
  seamarks: "https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png",
}
export const ATTRIBUTION = 'Tiles &copy; <a href="https://www.esri.com/">Esri</a>, HERE, Garmin, GEBCO &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · Seamarks &copy; <a href="https://www.openseamap.org/">OpenSeaMap</a>'

const POLL_MS = 3000
const GLIDE_MS = 1400
const PULSE_MS = 9000
/** Below this zoom, cars that would overlap share a cluster; from here up every car is its own mark. Locations are never grouped. */
const FAN_ZOOM = 6
/** Harbour marks gather cities whose marks would sit within this many pixels. */
const CLUSTER_PX = 28

export type ChartTheme = "dark" | "light"

/** The app's theme: a saved choice, else the system setting. */
export function readTheme(): ChartTheme {
  const saved = document.documentElement.dataset.theme
  if (saved === "light" || saved === "dark") return saved
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

const escape = (text: string) => text.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] as string)

const STATE_WORD: Record<ChartNode["attention"], string> = {
  decide: "Needs a person", watch: "Watching", agent: "Agent working", fine: "Nothing open",
}

function vesselHtml(node: ChartNode, selected: boolean): string {
  // Two car shapes: a chevron for a car moving or due to be, a circle for one waiting; a quiet phone draws either hollow.
  const moving = node.motion === "moving" && node.heading != null
  const classes = ["v", `v-${node.attention}`, node.stale ? "v-stale" : "", selected ? "v-sel" : "", moving ? "v-moving" : "v-still"].filter(Boolean).join(" ")
  const shape = moving
    ? `<svg viewBox="0 0 20 20" style="transform:rotate(${Math.round(node.heading ?? 0)}deg)"><path d="M10 2.6 16 17.2 10 13.8 4 17.2Z"/></svg>`
    : `<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="5.2"/></svg>`
  return `<span class="${classes}">${shape}<span class="v-label">${escape(node.reference)}</span></span>`
}

/** Locations are small and muted: a square for a dealer or site, a diamond for a yard, a hollow square for a private address. */
function berthHtml(node: ChartNode, selected: boolean): string {
  return `<span class="loc loc-${node.placeKind ?? "private"}${selected ? " loc-sel" : ""}"></span>`
}

/** A group of cars that would overlap at this zoom: a count in the colour of the most urgent car. */
function clusterHtml(nodes: ChartNode[]): string {
  const worst = (["decide", "watch", "agent", "fine"] as const).find((attention) => nodes.some((node) => node.attention === attention)) ?? "fine"
  return `<span class="cl cl-${worst}"><b>${nodes.length}</b></span>`
}

function clusterTip(nodes: ChartNode[]): string {
  const count = (attention: ChartNode["attention"]) => nodes.filter((node) => node.attention === attention).length
  return `<div class="tip-head"><b>${nodes.length} cars here</b></div>
    <div class="tip-route">${[["decide", "need a person"], ["watch", "watching"], ["agent", "with the agent"]].map(([key, word]) => count(key as ChartNode["attention"]) ? `${count(key as ChartNode["attention"])} ${word}` : null).filter(Boolean).join(" · ") || "nothing open"}</div>
    <div class="tip-quiet">Zoom in to see each car.</div>`
}

function tipHtml(node: ChartNode): string {
  const where = node.kind === "vessel"
    ? `${escape(node.placeLabel ?? "Position reported")}<br><span class="tip-quiet">Simulated phone GPS · ${node.stale ? `last seen ${escape(node.ageLabel ?? "")}` : escape(node.ageLabel ?? "")}${node.speedKmh ? ` · ${node.speedKmh} km/h` : ""}</span>`
    : `<span class="tip-quiet">${escape(node.berthNote ?? "")}</span>`
  return `<div class="tip-head"><b>${escape(node.vehicle)}</b><span class="mono">${escape(node.reference)}</span></div>
    <div class="tip-route">${escape(node.from)} → ${escape(node.to)} · ${escape(node.laneLabel)}${node.driver ? ` · ${escape(node.driver)}` : ""}</div>
    <div class="tip-where">${where}${node.motionNote ? `<br><span class="tip-quiet">${escape(node.motionNote)}</span>` : ""}</div>
    ${node.headline ? `<div class="tip-state tip-${node.attention}">${escape(STATE_WORD[node.attention])}: ${escape(node.headline)}</div>` : ""}`
}

/** Pixel offsets on a sunflower spiral, so a city's berths fan out around its port mark. */
function fan(index: number): [number, number] {
  const angle = index * 2.39996
  const radius = 7 + 5 * Math.sqrt(index)
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
      // Coming back to the operator role restores the map as it was left: view and selection.
      const saved = recall<{ center: [number, number]; zoom: number; selectedId: string | null }>("map:view")
      if (saved?.center) m.setView(saved.center, saved.zoom, { animate: false })
      else m.fitBounds([[47.5, 4.5], [64.5, 27.5]], { paddingTopLeft: [80, 60], paddingBottomRight: [40, 30] })
      // A link with ?order=<id> (from the Demo page's delivery run) opens that order's panel; otherwise the saved selection.
      const asked = new URLSearchParams(window.location.search).get("order")
      if (asked) { framed.current = asked; setSelectedId(asked) }
      else if (saved?.selectedId) { framed.current = saved.selectedId; setSelectedId(saved.selectedId) }
      m.on("moveend", () => { const c = m.getCenter(); const prev = recall<{ selectedId: string | null }>("map:view"); remember("map:view", { center: [c.lat, c.lng], zoom: m.getZoom(), selectedId: prev?.selectedId ?? null }) })
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

  // ---- ports: the ferry terminals, as a tiny anchor
  useEffect(() => {
    const leaflet = L.current
    if (!ready || !leaflet || !layers.current) return
    layers.current.ports.clearLayers()
    for (const port of view.ports) {
      const terminal = port.kind === "terminal"
      const html = terminal
        ? `<span class="pt pt-terminal"><svg viewBox="0 0 16 16"><path d="M8 3.2v9.6M5.2 5.4h5.6M3.4 9.2c.6 2.2 2.4 3.6 4.6 3.6s4-1.4 4.6-3.6"/><circle cx="8" cy="2.6" r="1.2"/></svg><span class="pt-label">${escape(port.name)}</span></span>`
        : ""
      leaflet.marker([port.lat, port.lng], {
        pane: "ports", interactive: true, keyboard: false,
        icon: leaflet.divIcon({ className: "pt-wrap", html, iconSize: [11, 11], iconAnchor: [-6, -4] }),
      }).bindTooltip(terminal ? `<b>${escape(port.name)}</b><div class="tip-quiet">Ferry terminal. Fictional; placed at city level, no gate address recorded.</div>`
        : "", { className: "chart-tip", direction: "top", offset: [0, -8] })
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

    // One layering: locations, then stopped cars, then car clusters, then moving cars; more urgent on top; the selection above all.
    const rank = { decide: 300, watch: 200, agent: 100, fine: 0 }
    const layer = { berth: 100, still: 400, cluster: 500, vessel: 1000 }
    const zFor = (kind: keyof typeof layer, attention: ChartNode["attention"], isSelected = false) => layer[kind] + rank[attention] + (isSelected ? 5000 : 0)
    const movingNow = (node: ChartNode) => node.motion === "moving" && !node.stale
    // Cars that would overlap below FAN_ZOOM share a cluster (greedy, most urgent first). Locations are never grouped.
    const vessels = nodes.filter((node) => node.kind === "vessel").sort((a, b) => rank[b.attention] - rank[a.attention])
    const clusters: { anchor: ChartNode; nodes: ChartNode[]; point: { x: number; y: number } }[] = []
    for (const node of vessels) {
      const point = map.current.latLngToLayerPoint([node.lat, node.lng])
      const near = !fanOut && node.orderId !== selectedId ? clusters.find((cluster) => cluster.anchor.orderId !== selectedId && Math.hypot(cluster.point.x - point.x, cluster.point.y - point.y) < CLUSTER_PX) : null
      if (near) near.nodes.push(node)
      else clusters.push({ anchor: node, nodes: [node], point })
    }
    for (const cluster of clusters) {
      if (cluster.nodes.length === 1) {
        const node = cluster.anchor
        const isSelected = node.orderId === selectedId
        const select = (event?: { originalEvent?: Event }) => { event?.originalEvent?.stopPropagation(); setSelectedId(node.orderId) }
        place(node.orderId, [node.lat, node.lng], vesselHtml(node, isSelected), tipHtml(node), 26, [13, 13], zFor(movingNow(node) ? "vessel" : "still", node.attention, isSelected), select, null, node.orderId)
        continue
      }
      const at = cluster.anchor
      place(`cluster:${cluster.nodes.map((node) => node.orderId).sort().join("+")}`, [at.lat, at.lng], clusterHtml(cluster.nodes), clusterTip(cluster.nodes), 26, [13, 13], zFor("cluster", at.attention),
        () => map.current?.flyTo([at.lat, at.lng], Math.max(FAN_ZOOM, (map.current?.getZoom() ?? 5) + 1), { duration: 0.6 }), null, null)
    }
    // Locations: tiny and muted; orders at the very same point fan out a few pixels.
    for (const [, group] of berths) {
      const sorted = [...group].sort((a, b) => rank[b.attention] - rank[a.attention] || a.reference.localeCompare(b.reference))
      sorted.forEach((node, index) => {
        const [dx, dy] = sorted.length === 1 ? [0, 0] : fan(index)
        const isSelected = node.orderId === selectedId
        const size = isSelected ? 11 : 7
        place(node.orderId, [node.lat, node.lng], berthHtml(node, isSelected), tipHtml(node), size, [Math.round(size / 2 - dx), Math.round(size / 2 - dy)], zFor("berth", node.attention, isSelected),
          (event?: { originalEvent?: Event }) => { event?.originalEvent?.stopPropagation(); setSelectedId(node.orderId) }, null, node.orderId)
      })
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
      const tone = node.stale ? "stale" : node.attention
      const known = tracks.current.get(node.orderId)
      if (known) {
        known.done.setLatLngs(done); known.ahead.setLatLngs(ahead)
        for (const [line, part] of [[known.done, "done"], [known.ahead, "ahead"]] as const) {
          const element = line.getElement()
          if (element) element.setAttribute("class", `route-${part} rt-${tone}`)
        }
        continue
      }
      tracks.current.set(node.orderId, {
        ahead: leaflet.polyline(ahead, { pane: "trails", className: `route-ahead rt-${tone}`, weight: 1, interactive: false }).addTo(layers.current.trails),
        done: leaflet.polyline(done, { pane: "trails", className: `route-done rt-${tone}`, weight: 1, interactive: false }).addTo(layers.current.trails),
      })
    }
    for (const [id, track] of tracks.current) {
      if (keep.has(id)) continue
      track.done.remove(); track.ahead.remove(); tracks.current.delete(id)
    }
  }, [ready, nodes, view.routes])

  // ---- the route track. Selected: in the accent colour, every other route dimmed, the destination enlarged and named with
  // the promise, and the pickup named. Hovered: brightened, ends named.
  const trackId = selectedId ?? hoverId
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
      const picked = trackId === selectedId ? " track-sel" : ""
      if (ahead.length > 1) leaflet.polyline(ahead, { pane: "route", className: `track track-ahead${sea ? " track-sea" : ""}${picked}`, weight: picked ? 3 : 2, interactive: false }).addTo(layers.current.route)
      if (done.length > 1) leaflet.polyline(done, { pane: "route", className: `track track-done${sea ? " track-sea" : ""}${picked}`, weight: picked ? 3.5 : 2.5, interactive: false }).addTo(layers.current.route)
    }
    const first = route.parts[0]?.coords[0]
    const last = route.parts.at(-1)?.coords.at(-1)
    const selectedNow = trackId === selectedId
    if (first) leaflet.circleMarker(first, { pane: "route", radius: selectedNow ? 4.5 : 3.5, className: "track-end track-from", interactive: false })
      .bindTooltip(selectedNow ? `From ${escape(node.fromName)}` : `Pickup · ${escape(node.from)}`, { permanent: true, direction: "left", offset: [-8, 0], className: "track-label" }).addTo(layers.current.route)
    if (last) leaflet.circleMarker(last, { pane: "route", radius: selectedNow ? 7 : 3.5, className: `track-end track-to${selectedNow ? " track-dest" : ""}`, interactive: false })
      .bindTooltip(selectedNow ? `<b>${escape(node.toName)}</b>${node.promiseText ? `<span>promised ${escape(node.promiseText)}</span>` : ""}` : `Delivery · ${escape(node.to)}`,
        { permanent: true, direction: "right", offset: [10, 0], className: `track-label${selectedNow ? " track-label-dest" : ""}` }).addTo(layers.current.route)
  }, [ready, trackId, selectedId, view.routes, byId])

  // ---- a new selection with a route frames the whole journey left of the panel, so pickup and destination are both in view
  const framed = useRef<string | null>(null)
  useEffect(() => {
    const leaflet = L.current
    if (!ready || !leaflet || !map.current || !selectedId || framed.current === selectedId) return
    framed.current = selectedId
    const route = view.routes[selectedId]
    if (!route) return
    const points = route.parts.flatMap((part) => part.coords)
    if (points.length < 2) return
    map.current.flyToBounds(leaflet.latLngBounds(points), { paddingTopLeft: [80, 80], paddingBottomRight: [500, 90], maxZoom: 9, duration: 0.7 })
  }, [ready, selectedId, view.routes])
  useEffect(() => { if (!selectedId) framed.current = null }, [selectedId])
  useEffect(() => {
    if (!map.current) return
    const c = map.current.getCenter()
    remember("map:view", { center: [c.lat, c.lng], zoom: map.current.getZoom(), selectedId })
  }, [selectedId])

  // ---- keyboard: Escape closes, [ and ] step through what needs a person
  const needIds = useMemo(() => view.needs.map((needed) => needed.orderId).filter((id) => byId.has(id)), [view.needs, byId])
  const focus = useCallback((id: string) => {
    const node = byId.get(id)
    setSelectedId(id)
    // A car with a route is framed by its whole journey (below); anything else is flown to.
    if (node && map.current && !view.routes[id]) {
      const target = Math.max(map.current.getZoom(), FAN_ZOOM)
      map.current.flyTo([node.lat, node.lng], target, { duration: 0.7 })
    }
  }, [byId, view.routes])
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
    <div className={`chart-home z-${zoom < 6 ? "low" : zoom < 8 ? "mid" : "high"}${selected ? " has-dossier" : ""}${selected && view.routes[selected.orderId] ? " has-route" : ""}`} data-chart={theme}>
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
          <span><svg className="lg-shape" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.6 16 17.2 10 13.8 4 17.2Z" /></svg>Moving</span>
          <span><svg className="lg-shape" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="5.2" /></svg>Waiting</span>
          <span><i className="lg lg-decide" />Needs a person</span>
          <span><i className="lg lg-watch" />Watching</span>
          <span><i className="lg lg-agent" />Agent working</span>
          <span><i className="lg lg-fine" />Fine</span>
          <span><i className="lg lg-stale" />Phone quiet</span>
          <span className="lg-places"><i className="loc loc-dealer" />Dealer <i className="loc loc-yard" />Yard <i className="loc loc-private" />Private address</span>
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
