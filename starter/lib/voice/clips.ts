// Audio clips of record: one per turn. Stored in the object store
// (lib/object-store.ts, local S3 on port 9009) under `voice/calls/<callId>/`.
// When the store is not configured or not reachable, the clip goes to local
// disk (`.voice-cache/clips/`) and its key starts with "disk:".

import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { objectStore } from "@/lib/object-store"
import { voiceConfig } from "./config"

export async function storeClip(key: string, bytes: Buffer, contentType: string): Promise<string> {
  try {
    const { client, bucket } = objectStore()
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: contentType }))
    return key
  } catch (error) {
    console.warn(`[voice] object store unavailable, keeping the clip on disk: ${error instanceof Error ? error.message : String(error)}`)
    const path = join(voiceConfig.cacheDir(), "clips", key)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes)
    return `disk:${key}`
  }
}

export async function readClip(key: string): Promise<Buffer | null> {
  try {
    if (key.startsWith("disk:")) return await readFile(join(voiceConfig.cacheDir(), "clips", key.slice(5)))
    const { client, bucket } = objectStore()
    const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    const bytes = await result.Body?.transformToByteArray()
    return bytes ? Buffer.from(bytes) : null
  } catch {
    return null
  }
}

export function clipMime(key: string): string {
  if (key.endsWith(".mp3")) return "audio/mpeg"
  if (key.endsWith(".ogg")) return "audio/ogg"
  if (key.endsWith(".wav")) return "audio/wav"
  if (key.endsWith(".m4a")) return "audio/mp4"
  return "audio/webm"
}
