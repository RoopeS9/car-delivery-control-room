// Text-to-speech with a cache keyed by (model, voice, text). Renders are
// shared while in flight (memory) and kept on disk (`.voice-cache/tts/`), so
// fixed phrases cost once and play instantly. A sentence is registered first
// and rendered in the background; the call screen fetches it by id.

import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { TTS_DOLLARS_PER_CHAR, voiceConfig } from "./config"
import { voiceProvider } from "./provider"

type Entry = { text: string; voice: string; render?: Promise<Buffer | null> }

const holder = globalThis as unknown as { __voiceTts?: Map<string, Entry>; __voiceTtsSpend?: number }
const entries = (holder.__voiceTts ??= new Map())

export function ttsId(text: string, voice: string): string {
  return createHash("sha256").update(`${voiceConfig.ttsModel()}|${voice}|${text}`).digest("hex").slice(0, 32)
}

function diskPath(id: string): string {
  return join(voiceConfig.cacheDir(), "tts", `${id}.mp3`)
}

async function fromDisk(id: string): Promise<Buffer | null> {
  try { return await readFile(diskPath(id)) } catch { return null }
}

async function render(id: string, text: string, voice: string): Promise<Buffer | null> {
  const cached = await fromDisk(id)
  if (cached) return cached
  const result = await voiceProvider().synthesize(text, voice)
  if (!result) return null
  holder.__voiceTtsSpend = (holder.__voiceTtsSpend ?? 0) + text.length * TTS_DOLLARS_PER_CHAR
  await mkdir(join(voiceConfig.cacheDir(), "tts"), { recursive: true })
  await writeFile(diskPath(id), result.audio)
  return result.audio
}

/** Register a line and start rendering it. Returns the id and whether a server render is possible. */
export function prepareSpeech(text: string, voice = voiceConfig.agentVoice()): { id: string; spoken: boolean } {
  const id = ttsId(text, voice)
  if (voiceProvider().name === "browser") return { id, spoken: false }
  const entry = entries.get(id) ?? { text, voice }
  if (!entry.render) {
    entry.render = render(id, text, voice).catch((error) => {
      console.warn(`[voice] speech failed: ${error instanceof Error ? error.message : String(error)}`)
      entry.render = undefined
      return null
    })
  }
  entries.set(id, entry)
  return { id, spoken: true }
}

/** Audio for a registered or cached id, waiting for an in-flight render. */
export async function speechAudio(id: string): Promise<Buffer | null> {
  const entry = entries.get(id)
  if (entry?.render) return entry.render
  return fromDisk(id)
}

/** Render now and wait (used by POST /api/voice/speak and the opening). */
export async function speak(text: string, voice = voiceConfig.agentVoice()): Promise<{ id: string; audio: Buffer | null }> {
  const { id, spoken } = prepareSpeech(text, voice)
  return { id, audio: spoken ? await speechAudio(id) : null }
}

export function speechUrl(id: string | null): string | null {
  return id ? `/api/voice/speak?id=${id}` : null
}

/** Dollars spent on uncached renders by this process (estimated from characters). */
export function ttsSpend(): number {
  return holder.__voiceTtsSpend ?? 0
}
