import { caseSummary, orderRefs } from "@/lib/agent/views"
import { simNow } from "@/lib/cr/clock"
import { getCase, listEvents, listProposals, proposalsWithChangedFacts } from "@/lib/cr/queries"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// One case: summary, all proposals, its events (only those after `since` if
// given), and `facts_changed`: pending cards drafted before something new came in.
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const row = await getCase(id)
  if (!row) return Response.json({ error: "Case not found" }, { status: 404 })
  const since = new URL(request.url).searchParams.get("since")
  const sinceDate = since && !Number.isNaN(Date.parse(since)) ? new Date(since) : undefined
  const [proposals, events, refs, changed] = await Promise.all([
    listProposals({ caseId: id }), listEvents({ caseId: id, since: sinceDate }), orderRefs([row.orderId]), proposalsWithChangedFacts(id),
  ])
  const facts_changed = changed.map((entry) => ({ proposal_id: entry.proposalId, changed_at: entry.changedAt.toISOString() }))
  return Response.json({ now: simNow().toISOString(), case: caseSummary(row, refs), proposals, events, facts_changed })
}
