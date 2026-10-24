import { caseSummary, orderRefs } from "@/lib/agent/views"
import { simNow } from "@/lib/cr/clock"
import { getCase, listEvents, listProposals } from "@/lib/cr/queries"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// One case: summary, all proposals, and its events (only those after `since` if given).
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const row = await getCase(id)
  if (!row) return Response.json({ error: "Case not found" }, { status: 404 })
  const since = new URL(request.url).searchParams.get("since")
  const sinceDate = since && !Number.isNaN(Date.parse(since)) ? new Date(since) : undefined
  const [proposals, events, refs] = await Promise.all([listProposals({ caseId: id }), listEvents({ caseId: id, since: sinceDate }), orderRefs([row.orderId])])
  return Response.json({ now: simNow().toISOString(), case: caseSummary(row, refs), proposals, events })
}
