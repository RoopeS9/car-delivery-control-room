import { CallError, driverTurn } from "@/lib/voice/call"
import { errorResponse, originOf } from "@/lib/voice/http"
import type { TurnEvent } from "@/lib/voice/types"

export const runtime = "nodejs"

const MAX_AUDIO_BYTES = 8 * 1024 * 1024

/**
 * One driver turn. Multipart form: `audio` (the recorded utterance, optional),
 * `liveText` (browser recognition), `durationMs`, `silence` ("1" when the reply
 * deadline passed). Responds with a stream of server-sent events: `driver`,
 * `sentence` (text plus audio URL, in order), `state`, `done`, `error`.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  let form: FormData
  let id: string
  try {
    id = (await context.params).id
    form = await request.formData()
  } catch (error) {
    return errorResponse(new CallError(400, "Send the turn as a multipart form."))
  }
  const audioFile = form.get("audio")
  let audio: { bytes: Buffer; mime: string } | null = null
  if (audioFile instanceof Blob && audioFile.size > 0) {
    if (audioFile.size > MAX_AUDIO_BYTES) return errorResponse(new CallError(413, "That recording is too long. Please keep answers short."))
    audio = { bytes: Buffer.from(await audioFile.arrayBuffer()), mime: audioFile.type || "audio/webm" }
  }
  const liveText = String(form.get("liveText") ?? "")
  const durationMs = Number(form.get("durationMs") ?? 0) || null
  const silence = form.get("silence") === "1"
  const origin = originOf(request)

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: TurnEvent) => {
        controller.enqueue(encoder.encode(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`))
      }
      try {
        await driverTurn(id, { liveText, audio, durationMs, silence }, send, { origin })
      } catch (error) {
        const message = error instanceof CallError ? error.message : "The reply failed. Please say that again."
        if (!(error instanceof CallError)) console.error("[voice] turn failed", error)
        send({ event: "error", data: { message } })
      } finally {
        controller.close()
      }
    },
  })
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  })
}
