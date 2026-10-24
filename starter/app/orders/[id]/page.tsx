"use client"

import Link from "next/link"
import { use, useEffect, useState } from "react"
import { AppFrame } from "../../components/app-frame"
import { OrderPane, type Detail } from "../../components/order-detail"

export default function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [error, setError] = useState("")

  useEffect(() => {
    const controller = new AbortController()
    fetch(`/api/orders/${encodeURIComponent(id)}`, { signal: controller.signal })
      .then((response) => { if (!response.ok) throw new Error(response.status === 404 ? "Order not found" : "Could not load order"); return response.json() as Promise<Detail> })
      .then((data) => { setDetail(data); setError("") })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load order") })
    return () => controller.abort()
  }, [id])

  useEffect(() => {
    if (detail) document.title = `${detail.view.header.reference} · ${detail.view.header.vehicle?.title ?? "Order"} · Control Room`
  }, [detail])

  return <AppFrame section="board" snapshotAt={detail?.view.snapshotAt ?? null}><main className="page">
    <nav className="crumbs" aria-label="Breadcrumb"><Link href="/">Orders</Link><span>/</span><span>{detail?.view.header.reference ?? "Record"}</span></nav>
    {error && <div className="record-state" role="alert"><h1>{error}</h1><p>The record could not be opened. <Link href="/">Back to orders</Link></p></div>}
    {!error && !detail && <div className="record-state" aria-busy="true"><div className="cover skeleton-cover" /><p>Loading order…</p></div>}
    {detail && <OrderPane detail={detail} />}
  </main></AppFrame>
}
