import { startCall } from "@/lib/voice/call"
import { errorResponse, originOf } from "@/lib/voice/http"
import type { StartCallRequest } from "@/lib/voice/types"

export const runtime = "nodejs"

/** Start a call: { orderRef, driverId, direction, telemetryHint? } -> { callId, opening, fillers } */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as StartCallRequest
    return Response.json(await startCall(body, { origin: originOf(request) }))
  } catch (error) {
    return errorResponse(error)
  }
}
