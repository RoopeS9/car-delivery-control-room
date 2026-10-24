import { NextResponse } from "next/server"
import { loadOrder } from "@/lib/present/load"
import { buildRecordView } from "@/lib/present/record"

export const runtime = "nodejs"

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const loaded = await loadOrder(id)
  if (!loaded) return NextResponse.json({ error: "Order not found" }, { status: 404 })
  const { order, customer, pickup, delivery, pickupSite, deliverySite, items, alerts, threads, messages, events, related, bundleOrderRefs, drivers, bundle } = loaded
  // The raw records keep their shape for anyone reading the API. `view` is the
  // same information read out with labels, names and grouping for the interface.
  const view = buildRecordView(bundle)
  return NextResponse.json({
    order, customer, pickup, delivery, pickupSite, deliverySite, items, drivers, alerts, conversations: threads, messages, events,
    related, bundleOrderRefs, view,
  })
}
