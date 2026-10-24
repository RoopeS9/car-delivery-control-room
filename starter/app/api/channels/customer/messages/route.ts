import { continueInBackground, errorResponse, readJson } from "@/lib/agent/http"
import { handleCustomerMessage } from "@/lib/agent/triggers"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// The customer writes in (simulated email, from the Demo page): { orderRef, text }. The agent drafts the reply as a card.
export async function POST(request: Request) {
  try {
    const { caseId, followUps } = await handleCustomerMessage(await readJson<{ orderRef: string; text: string }>(request))
    continueInBackground(followUps)
    return Response.json({ caseId })
  } catch (error) {
    return errorResponse(error)
  }
}
