import { and, eq, gte, inArray, or } from "drizzle-orm"
import { caseSummary, orderRefs } from "@/lib/agent/views"
import { simNow } from "@/lib/cr/clock"
import { crDb } from "@/lib/cr/db"
import { crCases, crProposals } from "@/lib/cr/schema"
import { OPEN_CASE_STATUSES, type CasesResponse } from "@/lib/cr/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Open cases, plus any case changed since `since` (so a poller sees cases leave
// the queue). Poll every 2-3 s.
export async function GET(request: Request) {
  const since = new URL(request.url).searchParams.get("since")
  const sinceDate = since && !Number.isNaN(Date.parse(since)) ? new Date(since) : null
  const now = simNow()
  const dayStart = new Date(now)
  dayStart.setUTCHours(0, 0, 0, 0)
  const db = crDb()
  const rows = await db.select().from(crCases)
    .where(sinceDate ? or(inArray(crCases.status, [...OPEN_CASE_STATUSES]), gte(crCases.updatedAt, sinceDate)) : inArray(crCases.status, [...OPEN_CASE_STATUSES]))
  const handled = await db.select({ id: crCases.id }).from(crCases).where(and(eq(crCases.status, "HANDLED_BY_AGENT"), gte(crCases.updatedAt, dayStart)))
  const pending = rows.length ? await db.select({ caseId: crProposals.caseId }).from(crProposals)
    .where(and(eq(crProposals.status, "PENDING"), inArray(crProposals.caseId, rows.map((row) => row.id)))) : []
  const refs = await orderRefs(rows.map((row) => row.orderId))
  const cases = rows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()).map((row) => ({
    ...caseSummary(row, refs), pending_proposals: pending.filter((entry) => entry.caseId === row.id).length,
  }))
  return Response.json({ now: now.toISOString(), cases, handled_by_agent_today: handled.length } satisfies CasesResponse)
}
