import { continueInBackground, errorResponse, readJson } from "@/lib/agent/http"
import { refresh } from "@/lib/agent/triggers"
import type { CaseActionResponse } from "@/lib/cr/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// "Facts changed since this was drafted": set the card aside and have the agent draft a fresh one.
export async function POST(request: Request, context: { params: Promise<{ id: string; proposalId: string }> }) {
  const { id, proposalId } = await context.params
  try {
    const body = await readJson<{ by: string }>(request)
    const { response, followUps } = await refresh(id, proposalId, body.by)
    continueInBackground(followUps)
    return Response.json({ case_id: id, case_status: response.case_status, next_step: response.next_step, next_check_at: response.next_check_at } satisfies CaseActionResponse)
  } catch (error) {
    return errorResponse(error)
  }
}
