// Speech in and out behind one interface, so the pipeline can swap providers
// later (a speech-to-speech model, another TTS) without touching the call code.
//
// - OpenRouterVoiceProvider: ElevenLabs speech and server transcription via
//   OpenRouter (formats verified 24 Oct: mp3, webm/opus, ogg, wav, m4a).
// - BrowserVoiceProvider: the server does neither; the call screen speaks with
//   `speechSynthesis` and the live browser transcript is the only text.

import { openRouterKey, voiceConfig } from "./config"

export type AudioFormat = "webm" | "ogg" | "mp3" | "wav" | "m4a"

export type SynthResult = { audio: Buffer; mime: "audio/mpeg"; model: string }
export type TranscriptResult = { text: string; model: string; cost: number }

export interface VoiceProvider {
  readonly name: "openrouter" | "browser"
  /** Null means the browser should speak this text itself. */
  synthesize(text: string, voice: string): Promise<SynthResult | null>
  /** Null means no server transcript; keep the live text. */
  transcribe(audio: Buffer, format: AudioFormat): Promise<TranscriptResult | null>
}

const OPENROUTER = "https://openrouter.ai/api/v1"

export class OpenRouterVoiceProvider implements VoiceProvider {
  readonly name = "openrouter" as const

  async synthesize(text: string, voice: string): Promise<SynthResult> {
    const model = voiceConfig.ttsModel()
    const response = await fetch(`${OPENROUTER}/audio/speech`, {
      method: "POST",
      headers: { Authorization: `Bearer ${openRouterKey()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: text, voice, response_format: "mp3" }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`Speech failed (${response.status}): ${(await response.text()).slice(0, 200)}`)
    return { audio: Buffer.from(await response.arrayBuffer()), mime: "audio/mpeg", model }
  }

  async transcribe(audio: Buffer, format: AudioFormat): Promise<TranscriptResult> {
    const model = voiceConfig.sttModel()
    const response = await fetch(`${OPENROUTER}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${openRouterKey()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, input_audio: { data: audio.toString("base64"), format } }),
      signal: AbortSignal.timeout(20_000),
    })
    const body = await response.text()
    if (!response.ok) throw new Error(`Transcription failed (${response.status}): ${body.slice(0, 200)}`)
    const json = JSON.parse(body) as { text?: string; usage?: { cost?: number } }
    return { text: (json.text ?? "").trim(), model, cost: json.usage?.cost ?? 0 }
  }
}

export class BrowserVoiceProvider implements VoiceProvider {
  readonly name = "browser" as const
  async synthesize(): Promise<null> { return null }
  async transcribe(): Promise<null> { return null }
}

export function voiceProvider(): VoiceProvider {
  return voiceConfig.provider() === "openrouter" ? new OpenRouterVoiceProvider() : new BrowserVoiceProvider()
}

export function audioFormatFromMime(mime: string | null | undefined): AudioFormat {
  const value = (mime ?? "").toLowerCase()
  if (value.includes("ogg")) return "ogg"
  if (value.includes("mpeg") || value.includes("mp3")) return "mp3"
  if (value.includes("wav")) return "wav"
  if (value.includes("mp4") || value.includes("m4a") || value.includes("aac")) return "m4a"
  return "webm"
}
