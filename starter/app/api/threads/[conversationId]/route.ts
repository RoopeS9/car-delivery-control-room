import { NextResponse } from "next/server"
import { HelpdeskError, setThreadStatus } from "@/lib/present/helpdesk"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Close or reopen a conversation: {status: "OPEN" | "CLOSED"}. */
export async function PATCH(request: Request, context: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = await context.params
  try {
    const input = (await request.json().catch(() => ({}))) as { status?: unknown }
    return NextResponse.json(await setThreadStatus(conversationId, input.status))
  } catch (error) {
    if (error instanceof HelpdeskError) return NextResponse.json({ error: error.message }, { status: error.status })
    console.error("helpdesk status", error)
    return NextResponse.json({ error: "The conversation could not be updated." }, { status: 500 })
  }
}
