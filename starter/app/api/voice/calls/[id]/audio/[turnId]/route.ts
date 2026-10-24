import { clipMime, readClip } from "@/lib/voice/clips"
import { getTurn } from "@/lib/voice/store"

export const runtime = "nodejs"

/** The audio clip of one turn (driver recording or the agent's spoken reply), for the case page's play button. */
export async function GET(_request: Request, context: { params: Promise<{ id: string; turnId: string }> }) {
  const { id, turnId } = await context.params
  const turn = await getTurn(turnId)
  if (!turn || turn.callId !== id || !turn.audioKey) return Response.json({ error: "No recording for this turn." }, { status: 404 })
  const bytes = await readClip(turn.audioKey)
  if (!bytes) return Response.json({ error: "The recording is not available." }, { status: 404 })
  return new Response(new Uint8Array(bytes), { headers: { "Content-Type": clipMime(turn.audioKey), "Cache-Control": "private, max-age=3600" } })
}
