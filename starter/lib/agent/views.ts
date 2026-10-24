// Read-outs of our rows for the API: case summaries with the order reference,
// and feed messages for the driver app and site chat.

import { inArray } from "drizzle-orm"
import { crDb } from "@/lib/cr/db"
import { simNow } from "@/lib/cr/clock"
import type { CaseRow, EventRow } from "@/lib/cr/queries"
import type { CaseSummary, FeedMessage } from "@/lib/cr/types"
import { orders } from "@/lib/schema"
import { actorName, names } from "./timeline"

export async function orderRefs(orderIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(orderIds)]
  if (ids.length === 0) return new Map()
  const rows = await crDb().select({ id: orders.id, reference: orders.reference }).from(orders).where(inArray(orders.id, ids))
  return new Map(rows.map((row) => [row.id, row.reference]))
}

export function caseSummary(row: CaseRow, refs: Map<string, string>): CaseSummary {
  return {
    id: row.id, order_id: row.orderId, order_ref: refs.get(row.orderId) ?? row.orderId, kind: row.kind, status: row.status, urgency: row.urgency,
    title: row.title, summary: row.summary, owner: row.owner, next_action: row.nextAction, waiting_on: row.waitingOn, waiting_for: row.waitingFor,
    next_check_at: row.nextCheckAt?.toISOString() ?? null,
    overdue: Boolean(row.nextCheckAt && row.nextCheckAt.getTime() <= simNow().getTime() && !["RESOLVED", "HANDLED_BY_AGENT"].includes(row.status)),
    linked_records: row.linkedRecords, last_run_status: row.lastRunStatus,
    opened_at: row.openedAt.toISOString(), updated_at: row.updatedAt.toISOString(),
  }
}

export async function feedMessages(events: EventRow[]): Promise<FeedMessage[]> {
  const n = await names()
  return events.filter((event) => event.kind === "message" || event.kind === "voice_turn" || event.kind === "effect").map((event) => {
    const photo = event.data.request === "photo" && typeof event.data.subject === "string"
    return {
      id: event.id, at: event.at.toISOString(), caseId: event.caseId, orderId: event.orderId, from: event.actorType,
      fromName: actorName(n, event.actorType, event.actorId).replace(/ \((driver|site|customer)\)$/, ""),
      kind: event.channel === "safety" ? "safety" : event.data.call === true || typeof event.data.call_id === "string" ? "call" : photo ? "photo_request" : "message",
      text: event.body, photoRequest: photo ? { subject: String(event.data.subject) } : null,
      callId: typeof event.data.call_id === "string" ? event.data.call_id : null,
    }
  })
}
