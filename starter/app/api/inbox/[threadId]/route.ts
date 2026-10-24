import { NextResponse } from "next/server"
import { HelpdeskError, updateInboxThread } from "@/lib/present/helpdesk"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Resolve an inbox thread: {link: orderIdOrReference} | {noOrder: true} | {status: "OPEN"|"CLOSED"}, in any combination. */
export async function PATCH(request: Request, context: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await context.params
  try {
    return NextResponse.json(await updateInboxThread(threadId, (await request.json().catch(() => ({}))) as Record<string, unknown>))
  } catch (error) {
    if (error instanceof HelpdeskError) return NextResponse.json({ error: error.message }, { status: error.status })
    console.error("inbox update", error)
    return NextResponse.json({ error: "The thread could not be updated." }, { status: 500 })
  }
}
