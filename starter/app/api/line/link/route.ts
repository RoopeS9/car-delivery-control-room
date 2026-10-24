import { NextResponse } from "next/server"
import { appendEvent, resolveOrder } from "@/lib/cr/queries"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type LinkBody = {
  orderRef?: unknown; callId?: unknown; purpose?: unknown; who?: unknown; duration?: unknown
  transcript?: { t: number; role: string; text: string }[]
}

/**
 * Links a live VoiceChat call (recorded on the phone line) to its order, so the
 * call and its transcript show in the order's node panel and timeline. The
 * transcript is the phone's record of the call, sent by the call screen after
 * hang-up.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as LinkBody | null
  if (typeof body?.orderRef !== "string" || typeof body.callId !== "string") return NextResponse.json({ error: "orderRef and callId are required" }, { status: 400 })
  const order = await resolveOrder(body.orderRef)
  if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 })
  const purpose = typeof body.purpose === "string" ? body.purpose : "CALL"
  const who = typeof body.who === "string" ? body.who : "the other party"
  const seconds = typeof body.duration === "number" ? Math.round(body.duration) : null
  const transcript = Array.isArray(body.transcript) ? body.transcript.filter((line) => typeof line?.text === "string").slice(0, 400) : []
  const event = await appendEvent({
    caseId: null, orderId: order.id, actorType: "system", actorId: "voicechat-line",
    kind: "note", channel: purpose === "DRIVER_INBOUND" ? "driver_voice" : "system",
    body: `Live call on the VoiceChat line with ${who}${seconds != null ? `, ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : ""}. Recorded on the phone line.`,
    data: { line_call_id: body.callId, purpose, who, duration_s: seconds, transcript },
  })
  return NextResponse.json({ ok: true, eventId: event.id })
}
