import { voiceConfig } from "@/lib/voice/config"
import { speak, speechAudio } from "@/lib/voice/tts-cache"

export const runtime = "nodejs"

const MAX_CHARS = 600
const VOICE_ID = /^[A-Za-z0-9]{10,40}$/

function audio(bytes: Buffer): Response {
  return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "private, max-age=86400" } })
}

/** Server-side speech, cached by text and voice: { text, voice? } -> audio/mpeg */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { text?: string; voice?: string } | null
  const text = body?.text?.trim()
  if (!text) return Response.json({ error: "Nothing to say." }, { status: 400 })
  if (text.length > MAX_CHARS) return Response.json({ error: "That is too long to speak in one go." }, { status: 413 })
  const voice = body?.voice && VOICE_ID.test(body.voice) ? body.voice : voiceConfig.agentVoice()
  try {
    const result = await speak(text, voice)
    if (!result.audio) return Response.json({ error: "Server speech is off; the browser speaks instead." }, { status: 503 })
    return audio(result.audio)
  } catch {
    return Response.json({ error: "Speech is not available right now." }, { status: 502 })
  }
}

/** A sentence registered by a call turn: ?id=<speech id>. Waits for a render in progress. */
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id") ?? ""
  if (!/^[a-f0-9]{32}$/.test(id)) return Response.json({ error: "Unknown speech id." }, { status: 400 })
  const bytes = await speechAudio(id)
  if (!bytes) return Response.json({ error: "Speech is not available." }, { status: 404 })
  return audio(bytes)
}
