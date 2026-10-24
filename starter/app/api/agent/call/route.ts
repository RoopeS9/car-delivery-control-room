import { after } from "next/server"
import { beginRuntimeWork } from "@/lib/cr/activity"
import { acceptCallTrigger, analyseCallTrigger, type CallTriggerRequest } from "@/lib/agent/calls"
import { errorResponse, readJson } from "@/lib/agent/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Voice needs a fast acknowledgement; accepted facts are persisted before
// the reply and the normal gated analyst runs after the response is sent.
export async function POST(request: Request) {
  let release: (() => void) | undefined
  try {
    release = beginRuntimeWork("queued voice analysis")
    const accepted = await acceptCallTrigger(await readJson<CallTriggerRequest>(request))
    const releaseAnalysis = release
    after(async () => { try { await analyseCallTrigger(accepted) } finally { releaseAnalysis() } })
    release = undefined
    return Response.json({ caseId: accepted.caseId, accepted: true, duplicate: accepted.duplicate }, { status: 202 })
  } catch (error) {
    return errorResponse(error)
  } finally { release?.() }
}
