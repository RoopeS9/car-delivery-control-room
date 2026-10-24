import { NextResponse } from "next/server"
import { appendEvent, resolveOrder } from "@/lib/cr/queries"
import type { CallRecord, CallReview } from "@/lib/present/call-types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const BASE = process.env.CALL_SERVICE_URL ?? "http://127.0.0.1:8799"
const INGESTIBLE = new Set(["PICKUP_READINESS", "DRIVER_INBOUND", "DRIVER_START_CHECK", "POSITION_CHECK"])

type Line = { t: number; role: string; text: string }
type LinkBody = {
  orderRef?: unknown; callId?: unknown; purpose?: unknown; who?: unknown; duration?: unknown
  /** Epoch seconds from the phone's record. */
  started?: unknown; ended?: unknown
  /** The phone contact that placed the call: roaddesk (chained STT, LLM, TTS) or voicechat. */
  caller?: unknown
  transcript?: Line[]
}

/**
 * After a live VoiceChat call: hands the phone's transcript to the call
 * service for extraction (claims citing turns, and a review for outbound
 * calls), then links the call to its order, so the call, its claims and its
 * review show in the order's node panel. Extraction failing does not stop the
 * link: the transcript is kept either way.
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
  const startedMs = typeof body.started === "number" ? body.started * 1000 : Date.now() - (seconds ?? 0) * 1000
  const endedMs = typeof body.ended === "number" ? body.ended * 1000 : startedMs + (seconds ?? 0) * 1000

  let ingested: { call: CallRecord; review: CallReview | null } | null = null
  let ingestError: string | null = null
  if (INGESTIBLE.has(purpose) && transcript.length) {
    try {
      const response = await fetch(`${BASE}/calls/ingest`, {
        method: "POST", headers: { "content-type": "application/json" }, cache: "no-store", signal: AbortSignal.timeout(90_000),
        body: JSON.stringify({
          ref: order.reference, purpose, engine: body.caller === "voicechat" ? "VOICECHAT_11B" : "CHAINED_STT_LLM_TTS", lineCallId: body.callId,
          startedAt: new Date(startedMs).toISOString(), endedAt: new Date(endedMs).toISOString(),
          // The phone's model is Mira; the user is whoever answered.
          turns: transcript.map((line) => ({ speaker: line.role === "model" ? "model" : "user", text: line.text, startedAt: new Date(startedMs + line.t * 1000).toISOString() })),
        }),
      })
      const text = await response.text()
      if (response.ok) {
        const record = JSON.parse(text) as CallRecord & { review?: CallReview | null }
        const { review, ...call } = record
        ingested = { call: call as CallRecord, review: review ?? null }
      } else ingestError = text.slice(0, 200) || `The call service answered ${response.status}.`
    } catch {
      ingestError = "The call service did not answer."
    }
  }

  const event = await appendEvent({
    caseId: null, orderId: order.id, actorType: "system", actorId: "voicechat-line",
    kind: "note", channel: purpose === "DRIVER_INBOUND" ? "driver_voice" : "system",
    body: `Live call on the ${body.caller === "voicechat" ? "VoiceChat" : "Road Desk"} line with ${who}${seconds != null ? `, ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : ""}. Recorded on the phone line.`,
    data: {
      line_call_id: body.callId, purpose, who, duration_s: seconds, transcript, caller: body.caller === "voicechat" ? "voicechat" : "roaddesk",
      ingested_call_id: ingested?.call.id ?? null, review: ingested?.review ?? null,
    },
  })
  return NextResponse.json({ ok: true, eventId: event.id, ingested, ingestError })
}
