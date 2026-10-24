import { NextResponse } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const BASE = process.env.CALL_SERVICE_URL ?? "http://127.0.0.1:8799"

/** One spoken turn of a simulated call, streamed from the call service (rendered there with ElevenLabs). */
export async function GET(_request: Request, context: { params: Promise<{ id: string; seq: string }> }) {
  const { id, seq } = await context.params
  if (!/^[a-z0-9-]+$/i.test(id) || !/^\d+$/.test(seq)) return NextResponse.json({ error: "bad turn" }, { status: 400 })
  try {
    const response = await fetch(`${BASE}/calls/${id}/audio/${seq}`, { cache: "no-store", signal: AbortSignal.timeout(10_000) })
    if (!response.ok) return NextResponse.json({ error: "No audio for this turn." }, { status: 404 })
    return new Response(response.body, { headers: { "content-type": "audio/mpeg", "cache-control": "public, max-age=86400" } })
  } catch {
    return NextResponse.json({ error: "The call service did not answer." }, { status: 502 })
  }
}
