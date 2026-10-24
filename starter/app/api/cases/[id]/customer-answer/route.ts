import { continueInBackground, errorResponse, readJson } from "@/lib/agent/http"
import { customerAnswer } from "@/lib/agent/triggers"
import type { CaseActionResponse, CustomerAnswerRequest } from "@/lib/cr/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// The customer's answer to a proposed date change, with its evidence. Only
// "agreed" changes the effective promise; approving the proposal never did.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  try {
    const result = await customerAnswer(id, await readJson<CustomerAnswerRequest>(request))
    continueInBackground(result.followUps)
    return Response.json({ case_id: id, case_status: result.outcome.case_status, next_step: result.outcome.next_step, next_check_at: result.outcome.next_check_at } satisfies CaseActionResponse)
  } catch (error) {
    return errorResponse(error)
  }
}
