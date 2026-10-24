import { NextResponse } from "next/server"
import { HelpdeskError, suggestFor } from "@/lib/present/helpdesk"
import { loadOrder } from "@/lib/present/load"
import { buildRecordView } from "@/lib/present/record"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Drafts for a conversation on an order, from the dossier: {orderId, intent?}. */
export async function POST(request: Request, context: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = await context.params
  const input = (await request.json().catch(() => ({}))) as { orderId?: unknown; intent?: unknown }
  if (typeof input.orderId !== "string") return NextResponse.json({ error: "orderId is required." }, { status: 400 })
  const loaded = await loadOrder(input.orderId)
  if (!loaded) return NextResponse.json({ error: "No such order." }, { status: 404 })
  const view = buildRecordView(loaded.bundle)
  const thread = view.threads.find((item) => item.id === conversationId)
  if (!thread) return NextResponse.json({ error: "No such conversation on this order." }, { status: 404 })
  try {
    return NextResponse.json(await suggestFor(view.header.reference, thread, { intent: typeof input.intent === "string" && input.intent.trim() ? input.intent.trim().slice(0, 600) : undefined }))
  } catch (error) {
    if (error instanceof HelpdeskError) return NextResponse.json({ error: error.message }, { status: error.status })
    console.error("helpdesk suggest", error)
    return NextResponse.json({ error: "No drafts right now." }, { status: 500 })
  }
}
