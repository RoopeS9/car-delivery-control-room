import { and, eq, inArray } from "drizzle-orm"
import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { HelpdeskError, suggestFor } from "@/lib/present/helpdesk"
import { buildInboxView } from "@/lib/present/inbox"
import { loadShared, orderRefs } from "@/lib/present/load"
import { addresses, orders, relatedRecords } from "@/lib/schema"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Drafts for an inbox thread: with the linked order's dossier, or, unlinked, with the candidate orders named: {intent?}. */
export async function POST(request: Request, context: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await context.params
  const input = (await request.json().catch(() => ({}))) as { intent?: unknown }
  const [threadRow] = await db.select().from(relatedRecords).where(and(eq(relatedRecords.collection, "support_inbox_threads"), eq(relatedRecords.id, threadId))).limit(1)
  if (!threadRow) return NextResponse.json({ error: "No such inbox thread." }, { status: 404 })
  const [messageRows, shared] = await Promise.all([db.select().from(relatedRecords).where(eq(relatedRecords.collection, "support_inbox_messages")), loadShared()])
  const thread = threadRow.details
  const ids = [...(Array.isArray(thread.linked_order_ids) ? thread.linked_order_ids : []), ...(Array.isArray(thread.candidate_order_ids) ? thread.candidate_order_ids : [])].filter((v): v is string => typeof v === "string")
  const refs = await orderRefs(ids)
  const view = buildInboxView([thread], messageRows.map((row) => row.details).filter((m) => m.thread_id === threadId), shared.makeDirectory(), refs, shared.snapshotAt).threads[0]
  if (!view) return NextResponse.json({ error: "No such inbox thread." }, { status: 404 })
  const linked = view.linked[0]?.reference ?? null
  // Unlinked: one line per candidate order so the drafts can name it and ask them to confirm.
  let candidates: { reference: string; line: string }[] = []
  if (!linked && view.candidates.length) {
    const rows = await db.select({ id: orders.id, reference: orders.reference, status: orders.status, pickup: addresses.city }).from(orders).leftJoin(addresses, eq(addresses.id, orders.pickupAddressId)).where(inArray(orders.id, view.candidates.map((c) => c.id)))
    candidates = rows.map((row) => ({ reference: row.reference, line: `status ${row.status.toLowerCase().replace(/_/g, " ")}, pickup in ${row.pickup ?? "an unknown city"}` }))
  }
  try {
    return NextResponse.json(await suggestFor(linked, view, { intent: typeof input.intent === "string" && input.intent.trim() ? input.intent.trim().slice(0, 600) : undefined, candidates }))
  } catch (error) {
    if (error instanceof HelpdeskError) return NextResponse.json({ error: error.message }, { status: error.status })
    console.error("inbox suggest", error)
    return NextResponse.json({ error: "No drafts right now." }, { status: 500 })
  }
}
