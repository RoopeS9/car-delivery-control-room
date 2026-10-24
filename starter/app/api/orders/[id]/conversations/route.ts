import { NextResponse } from "next/server"
import { HelpdeskError, openConversation, suggestFor } from "@/lib/present/helpdesk"
import { loadOrder } from "@/lib/present/load"
import { buildRecordView } from "@/lib/present/record"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * The operator opens a conversation with one of the order's parties: {category, channel, counterpartyType,
 * counterpartyId, counterpartyName?, body}. With {draft: true} instead of a body, answers drafts for the opening
 * message from the dossier (intent says what the operator wants to say).
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const input = (await request.json().catch(() => ({}))) as Record<string, unknown>
  try {
    if (input.draft === true) {
      const loaded = await loadOrder(id)
      if (!loaded) return NextResponse.json({ error: "No such order." }, { status: 404 })
      const view = buildRecordView(loaded.bundle)
      const counterparty = typeof input.counterpartyName === "string" ? { id: null, kind: String(input.counterpartyType ?? "unknown") as "unknown", name: input.counterpartyName, role: null } : null
      const thread = { category: String(input.category ?? "order_information"), channel: String(input.channel ?? "support_chat"), counterparty, messages: [] }
      return NextResponse.json(await suggestFor(view.header.reference, thread, { intent: typeof input.intent === "string" && input.intent.trim() ? input.intent.trim().slice(0, 600) : "Open the conversation: say why the desk is writing and ask what is needed." }))
    }
    return NextResponse.json(await openConversation(id, input), { status: 201 })
  } catch (error) {
    if (error instanceof HelpdeskError) return NextResponse.json({ error: error.message }, { status: error.status })
    console.error("helpdesk open", error)
    return NextResponse.json({ error: "The conversation could not be opened." }, { status: 500 })
  }
}
