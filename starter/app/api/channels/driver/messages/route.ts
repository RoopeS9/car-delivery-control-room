import { continueInBackground, errorResponse, readJson, sseResponse } from "@/lib/agent/http"
import { handleDriverMessage, prepareDriverMessage } from "@/lib/agent/triggers"
import type { DriverMessageRequest } from "@/lib/cr/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// A driver writes or speaks to us. The agent's reply streams back as it is written.
export async function POST(request: Request) {
  let prepared
  try {
    prepared = await prepareDriverMessage(await readJson<DriverMessageRequest>(request))
  } catch (error) {
    return errorResponse(error)
  }
  return sseResponse(async (send) => {
    const { caseId, result } = await handleDriverMessage(prepared, (text) => send("text_delta", { text }))
    send("done", { caseId, replyEventId: result.replyEventId, heldForApproval: result.heldForApproval })
    continueInBackground(result.followUps)
  })
}
