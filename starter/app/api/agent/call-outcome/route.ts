import { continueInBackground, errorResponse, readJson } from "@/lib/agent/http"
import { handleCallOutcome, type CallOutcomeRequest } from "@/lib/agent/triggers"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// The autopilot's call found something a person may have to decide. The agent
// reads the call's outcome on the case and continues: a card if one is needed.
export async function POST(request: Request) {
  try {
    const { caseId, result } = await handleCallOutcome(await readJson<CallOutcomeRequest>(request))
    continueInBackground(result.followUps)
    return Response.json({ caseId, ...(result.error ? { error: result.error } : {}) })
  } catch (error) {
    return errorResponse(error)
  }
}
