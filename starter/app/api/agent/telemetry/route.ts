import { continueInBackground, errorResponse, readJson } from "@/lib/agent/http"
import { handleTelemetryFault } from "@/lib/agent/triggers"
import type { TelemetryTriggerRequest } from "@/lib/cr/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// The simulator reports a fault. The agent opens a case and contacts the driver
// first; the response returns once that first message is sent.
export async function POST(request: Request) {
  try {
    const { caseId, result } = await handleTelemetryFault(await readJson<TelemetryTriggerRequest>(request))
    continueInBackground(result.followUps)
    return Response.json({ caseId, replyEventId: result.replyEventId, reply: result.reply, ...(result.error ? { error: result.error } : {}) })
  } catch (error) {
    return errorResponse(error)
  }
}
