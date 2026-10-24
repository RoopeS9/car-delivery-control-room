import { endCall } from "@/lib/voice/call"
import { errorResponse, originOf } from "@/lib/voice/http"

export const runtime = "nodejs"

/** Hang up: { reason } -> { transcriptUrl }. Records the call_ended trigger for the agent. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params
    const body = (await request.json().catch(() => ({}))) as { reason?: string }
    const result = await endCall(id, body.reason ?? "hang_up", { origin: originOf(request) })
    return Response.json({ transcriptUrl: result.transcriptUrl })
  } catch (error) {
    return errorResponse(error)
  }
}
