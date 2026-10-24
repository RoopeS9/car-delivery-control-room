import { continueInBackground, errorResponse, readJson } from "@/lib/agent/http"
import { decide } from "@/lib/agent/triggers"
import type { DecisionRequest, DecisionResponse } from "@/lib/cr/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Approve, edit and approve, reject, "I'll handle it", or "Tell the agent instead".
export async function POST(request: Request, context: { params: Promise<{ id: string; proposalId: string }> }) {
  const { id, proposalId } = await context.params
  try {
    const { outcome, followUps } = await decide(id, proposalId, await readJson<DecisionRequest>(request))
    continueInBackground(followUps)
    const { followUp: _followUp, ...response } = outcome
    return Response.json(response satisfies DecisionResponse)
  } catch (error) {
    return errorResponse(error)
  }
}
