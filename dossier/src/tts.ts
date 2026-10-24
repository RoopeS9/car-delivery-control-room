// Speech for simulated calls: ElevenLabs through OpenRouter, the same voice the live line uses for Mira, so a
// simulated call and a live one sound alike. One mp3 per turn under data/out/audio/<callId>/<seq>.mp3; the turn's
// audioKey is that relative path. Off without SIM_TTS=1 (then every audioKey stays null).
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import type { CallRecord } from "./live"

export const TTS = {
  url: "https://openrouter.ai/api/v1/audio/speech",
  model: process.env.TTS_MODEL ?? "elevenlabs/eleven-v4-turbo",
  /** Mira: the voice the phone's roaddesk contact uses. */
  voiceCaller: process.env.TTS_VOICE_CALLER ?? "21m00Tcm4TlvDq8ikWAM",
  /** The other party: a different ElevenLabs voice, so the two sides are told apart by ear. */
  voiceCallee: process.env.TTS_VOICE_CALLEE ?? "pNInz6obpgDQGcFmaJgB",
}
/** OpenRouter bills ElevenLabs by the character; this is the public list price, used for the cost note only. */
const DOLLARS_PER_CHAR = 0.00003

export const ttsEnabled = () => process.env.SIM_TTS === "1" && !!process.env.OPENROUTER_API_KEY

export async function synthesize(text: string, voice: string, apiKey = process.env.OPENROUTER_API_KEY): Promise<Buffer> {
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set")
  const res = await fetch(TTS.url, {
    method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "x-title": "road-dossier sim tts" },
    body: JSON.stringify({ model: TTS.model, input: text, voice, response_format: "mp3" }), signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`tts ${res.status}: ${(await res.text()).slice(0, 160)}`)
  return Buffer.from(await res.arrayBuffer())
}

/** Renders every turn of a call that has no audio yet. Returns the call with audioKeys set, and what it cost. */
export async function renderCallAudio(call: CallRecord, audioRoot: URL): Promise<{ call: CallRecord; costUsd: number; rendered: number; failed: string | null }> {
  if (!ttsEnabled()) return { call, costUsd: 0, rendered: 0, failed: null }
  const dir = new URL(`${call.id}/`, audioRoot)
  mkdirSync(dir, { recursive: true })
  let cost = 0, rendered = 0, failed: string | null = null
  const turns: CallRecord["turns"] = []
  for (const turn of call.turns) {
    const key = `${call.id}/${turn.seq}.mp3`
    const file = new URL(`${turn.seq}.mp3`, dir)
    if (turn.audioKey || existsSync(file)) { turns.push({ ...turn, audioKey: turn.audioKey ?? key }); continue }
    if (failed) { turns.push(turn); continue }
    try {
      const audio = await synthesize(turn.text, turn.speaker === "CALLER" ? TTS.voiceCaller : TTS.voiceCallee)
      writeFileSync(file, audio)
      cost += turn.text.length * DOLLARS_PER_CHAR; rendered++
      turns.push({ ...turn, audioKey: key })
    } catch (e) { failed = (e as Error).message.slice(0, 200); turns.push(turn) }
  }
  return { call: { ...call, turns }, costUsd: cost, rendered, failed }
}
