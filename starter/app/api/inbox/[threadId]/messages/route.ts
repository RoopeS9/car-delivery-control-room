import { NextResponse } from "next/server"
import { HelpdeskError, postInboxMessage } from "@/lib/present/helpdesk"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** The operator answers an inbox thread: {body, internal?, language?}. */
export async function POST(request: Request, context: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await context.params
  try {
    const message = await postInboxMessage(threadId, (await request.json().catch(() => ({}))) as Record<string, unknown>)
    return NextResponse.json({ message }, { status: 201 })
  } catch (error) {
    if (error instanceof HelpdeskError) return NextResponse.json({ error: error.message }, { status: error.status })
    console.error("inbox message", error)
    return NextResponse.json({ error: "The message could not be saved." }, { status: 500 })
  }
}
