import { getCallView } from "@/lib/voice/call"
import { errorResponse } from "@/lib/voice/http"

export const runtime = "nodejs"

/** The transcript of record: turns, slots with their quotes, urgency, missing items, triggers. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params
    const view = await getCallView(id)
    if (!view) return Response.json({ error: "No such call." }, { status: 404 })
    return Response.json(view)
  } catch (error) {
    return errorResponse(error)
  }
}
