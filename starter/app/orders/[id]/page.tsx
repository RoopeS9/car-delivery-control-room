"use client"

import Link from "next/link"
import { use, useCallback, useEffect, useRef, useState } from "react"
import { AppFrame } from "../../components/app-frame"
import { tickCases } from "../../components/live-refresh"
import { OrderPane, type Detail } from "../../components/order-detail"

/** Operator pages poll every 2–3 s (PLAN.md 4.2c). */
const POLL_MS = 2500

export default function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [error, setError] = useState("")
  const last = useRef("")

  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`/api/orders/${encodeURIComponent(id)}`, { signal, cache: "no-store" })
    if (!response.ok) throw new Error(response.status === 404 ? "Order not found" : "Could not load order")
    const text = await response.text()
    // Only re-render when something changed, so typing in a card is never interrupted.
    if (text !== last.current) {
      last.current = text
      setDetail(JSON.parse(text) as Detail)
    }
    setError("")
  }, [id])

  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load order")
    })
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        void tickCases().then(() => load(controller.signal)).catch(() => { /* keep the last good view; the next poll retries */ })
      }
    }, POLL_MS)
    return () => { clearInterval(timer); controller.abort() }
  }, [load])

  useEffect(() => {
    if (detail) document.title = `${detail.view.header.reference} · ${detail.view.header.vehicle?.title ?? "Order"} · Road Desk`
  }, [detail])

  const refresh = useCallback(() => { void load().catch(() => {}) }, [load])

  return <AppFrame section="queue" snapshotAt={detail?.view.snapshotAt ?? null}><main className="page">
    <nav className="crumbs" aria-label="Breadcrumb"><Link href="/">Map</Link><span>/</span><span>{detail?.view.header.reference ?? "Record"}</span></nav>
    {error && !detail && <div className="record-state" role="alert"><h1>{error}</h1><p>The record could not be opened. <Link href="/">Back to the map</Link></p></div>}
    {!error && !detail && <div className="record-state" aria-busy="true"><div className="cover skeleton-cover" /><p>Loading order…</p></div>}
    {detail && <OrderPane detail={detail} onChange={refresh} />}
  </main></AppFrame>
}
