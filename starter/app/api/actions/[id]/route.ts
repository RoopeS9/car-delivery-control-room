import { NextResponse } from "next/server"
import { deriveKeyDates } from "@/lib/present/attention"
import { orderActions } from "@/lib/present/call-service"
import type { ActionStripView } from "@/lib/present/call-types"
import { loadOrder } from "@/lib/present/load"
import { buildRecordView } from "@/lib/present/record"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function weekdayClock(iso: string, zone: string | null): string {
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: zone ?? "UTC" }).format(new Date(iso)).replace(",", "")
}
function clock(iso: string, zone: string | null): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: zone ?? "UTC" }).format(new Date(iso))
}

/**
 * The operator action strip for one order: from and to with the time that
 * matters, and the calls an operator is there to make. When the agent may
 * place a call, the button opens a live call on the VoiceChat line in the app; when it may not (a
 * customer), it leads the person to the conversation on the order page.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const loaded = await loadOrder(id)
  if (!loaded) return NextResponse.json({ error: "Order not found" }, { status: 404 })
  const { bundle } = loaded
  const view = buildRecordView(bundle)
  const service = await orderActions(bundle.order.reference)
  const { keyDates } = deriveKeyDates(bundle)
  const lane = bundle.order.lane
  const pick = lane === "moving" || lane === "delivered" ? keyDates.find((date) => date.key === "promise") : keyDates.find((date) => date.key === "pickup_slot") ?? keyDates.find((date) => date.key === "promise")
  const when = pick ? `${pick.key === "pickup_slot" ? "pickup slot" : pick.label === "Delivery promise" ? "promised" : pick.label.toLowerCase()} ${weekdayClock(pick.start, pick.zone)}${pick.end ? ` to ${clock(pick.end, pick.zone)}` : ""}` : null
  const threadFor = (who: string | null) => {
    if (!who) return null
    const name = who.toLowerCase()
    return view.threads.find((thread) => thread.counterparty && (thread.counterparty.name.toLowerCase().includes(name) || name.includes(thread.counterparty.name.toLowerCase()))) ?? null
  }
  const strip: ActionStripView = {
    from: service ? `${service.from.name}, ${service.from.city}` : `${view.header.from.name}, ${view.header.from.city}`,
    to: service ? `${service.to.name}, ${service.to.city}` : `${view.header.to.name}, ${view.header.to.city}`,
    when, reference: bundle.order.reference,
    actions: (service?.actions ?? []).map((action) => {
      const thread = threadFor(action.who)
      const href = `/orders/${bundle.order.id}#${thread ? `thread-${thread.id}` : "conversations"}`
      if (action.agentMay && action.cardUrl) return { label: action.label, who: action.who, purpose: action.purpose, agentMay: true, reason: null, href, cardUrl: action.cardUrl }
      return { label: action.label, who: action.who, purpose: action.purpose, agentMay: false, reason: action.reason, href, cardUrl: null }
    }),
  }
  return NextResponse.json(strip)
}
