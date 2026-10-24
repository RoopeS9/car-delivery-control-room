import { eq } from "drizzle-orm"
import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { buildInboxView } from "@/lib/present/inbox"
import { loadShared, orderRefs } from "@/lib/present/load"
import { relatedRecords } from "@/lib/schema"

export const runtime = "nodejs"

export async function GET() {
  const [threadRows, messageRows, shared] = await Promise.all([
    db.select().from(relatedRecords).where(eq(relatedRecords.collection, "support_inbox_threads")),
    db.select().from(relatedRecords).where(eq(relatedRecords.collection, "support_inbox_messages")),
    loadShared(),
  ])
  const threads = threadRows.map((row) => row.details)
    .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))
  const messages = messageRows.map((row) => row.details)
    .sort((left, right) => String(left.authored_at).localeCompare(String(right.authored_at)))
  const ids = threads.flatMap((thread) => [...(Array.isArray(thread.candidate_order_ids) ? thread.candidate_order_ids : []), ...(Array.isArray(thread.linked_order_ids) ? thread.linked_order_ids : [])])
    .filter((value): value is string => typeof value === "string")
  const refs = await orderRefs(ids)
  // The raw threads and messages keep their shape; `view` reads them out with names and references.
  const view = buildInboxView(threads, messages, shared.makeDirectory(), refs, shared.snapshotAt)
  return NextResponse.json({ threads, messages, view })
}
