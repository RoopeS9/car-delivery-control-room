import { continueInBackground, errorResponse, readJson } from "@/lib/agent/http"
import { outcome } from "@/lib/agent/triggers"
import type { CaseActionResponse, LogOutcomeRequest } from "@/lib/cr/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// "Log what happened" after "I'll handle it". The agent continues from the outcome.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  try {
    const result = await outcome(id, await readJson<LogOutcomeRequest>(request))
    continueInBackground(result.followUps)
    return Response.json({ case_id: id, case_status: result.outcome.case_status, next_step: result.outcome.next_step } satisfies CaseActionResponse)
  } catch (error) {
    return errorResponse(error)
  }
}
