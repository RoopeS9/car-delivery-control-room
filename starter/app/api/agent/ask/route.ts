import { errorResponse, readJson } from "@/lib/agent/http"
import { askAgent } from "@/lib/agent/triggers"
import type { AskAgentRequest, AskAgentResponse } from "@/lib/cr/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// The "Ask the agent" box: a read-only answer with sources. Never changes anything.
export async function POST(request: Request) {
  try {
    const { caseId, result } = await askAgent(await readJson<AskAgentRequest>(request))
    return Response.json({ case_id: caseId, reply: result.reply, run_id: result.runId, ...(result.error ? { error: result.error } : {}) } satisfies AskAgentResponse)
  } catch (error) {
    return errorResponse(error)
  }
}
