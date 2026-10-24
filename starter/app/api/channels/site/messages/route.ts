import { continueInBackground, errorResponse, readJson, sseResponse } from "@/lib/agent/http"
import { handleSiteMessage, prepareSiteMessage } from "@/lib/agent/triggers"
import type { SiteMessageRequest } from "@/lib/cr/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// A pickup or delivery place writes to us. When the place belongs to the
// customer, nothing streams back: the reply waits for a person (heldForApproval).
export async function POST(request: Request) {
  let prepared
  try {
    prepared = await prepareSiteMessage(await readJson<SiteMessageRequest>(request))
  } catch (error) {
    return errorResponse(error)
  }
  return sseResponse(async (send) => {
    const { caseId, result } = await handleSiteMessage(prepared, (text) => send("text_delta", { text }))
    send("done", { caseId, replyEventId: result.replyEventId, heldForApproval: result.heldForApproval })
    continueInBackground(result.followUps)
  })
}
