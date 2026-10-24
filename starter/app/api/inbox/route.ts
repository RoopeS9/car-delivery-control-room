import { eq } from "drizzle-orm"
import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { buildInboxView } from "@/lib/present/inbox"
import { loadShared, orderRefs } from "@/lib/present/load"
import { conversations, messages, relatedRecords } from "@/lib/schema"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Every conversation the desk can read and answer in one place: the threads filed on orders (the helpdesk) and the
 * support mail that arrived before an order link was certain. Both come out in the inbox thread shape; `source`
 * says which is which. The raw rows are returned too, for anyone reading the API.
 */
export async function GET() {
  const [threadRows, messageRows, conversationRows, orderMessageRows, shared] = await Promise.all([
    db.select().from(relatedRecords).where(eq(relatedRecords.collection, "support_inbox_threads")),
    db.select().from(relatedRecords).where(eq(relatedRecords.collection, "support_inbox_messages")),
    db.select().from(conversations),
    db.select().from(messages),
    loadShared(),
  ])
  type Row = Record<string, unknown>
  const mail: Row[] = threadRows.map((row) => ({ ...row.details, source: "inbox" }))
  const mailMessages: Row[] = messageRows.map((row) => row.details)
  const orderThreads: Row[] = conversationRows.map((row) => ({
    ...row.details, id: row.id, source: "order", category: row.category, channel: row.channel, status: row.status,
    opened_at: typeof row.details.started_at === "string" ? row.details.started_at : row.updatedAt.toISOString(), updated_at: row.updatedAt.toISOString(),
    link_state: "CONFIRMED_SINGLE", linked_order_ids: [row.orderId, ...(Array.isArray(row.details.related_order_ids) ? row.details.related_order_ids : [])], candidate_order_ids: [], resolution: null, candidate_basis: null,
  }))
  const orderMessages: Row[] = orderMessageRows.map((row) => ({ ...row.details, id: row.id, thread_id: row.conversationId, author_type: row.authorType, body: row.body, authored_at: row.authoredAt.toISOString() }))
  const threads = [...mail, ...orderThreads].sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))
  const all = [...mailMessages, ...orderMessages].sort((left, right) => String(left.authored_at).localeCompare(String(right.authored_at)))
  const ids = threads.flatMap((thread) => [...(Array.isArray(thread.candidate_order_ids) ? thread.candidate_order_ids : []), ...(Array.isArray(thread.linked_order_ids) ? thread.linked_order_ids : [])])
    .filter((value): value is string => typeof value === "string")
  const refs = await orderRefs(ids)
  const snapshots = new Map<string, string>()
  for (const message of orderMessages) if (typeof message.author_id === "string" && typeof message.author_name_snapshot === "string") snapshots.set(message.author_id, message.author_name_snapshot)
  const view = buildInboxView(threads, all, shared.makeDirectory(snapshots), refs, shared.snapshotAt)
  return NextResponse.json({ threads: mail, messages: mailMessages, view })
}
