// Browser side of the channel contract (PLAN.md 4.2c): send a message and read
// the streamed reply, upload a photo, poll the feed. Shared by the driver app
// and the site chat.

import type { FeedResponse, PhotoUploadResponse } from "@/lib/cr/types"

export type StreamDone = { caseId: string; replyEventId: string | null; heldForApproval: boolean }

/** POST a message and call `onText` with each piece of the reply as it streams. */
export async function sendMessage(
  path: "/api/channels/driver/messages" | "/api/channels/site/messages",
  body: Record<string, unknown>,
  onText: (text: string) => void,
  signal?: AbortSignal,
): Promise<StreamDone> {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal })
  if (!response.ok || !response.body) {
    const problem = await response.json().catch(() => null) as { error?: string } | null
    throw new Error(problem?.error ?? "The message could not be sent.")
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let done: StreamDone | null = null
  for (;;) {
    const { value, done: finished } = await reader.read()
    if (value) buffer += decoder.decode(value, { stream: true })
    let split = buffer.indexOf("\n\n")
    while (split >= 0) {
      const block = buffer.slice(0, split)
      buffer = buffer.slice(split + 2)
      const event = /^event: (.+)$/m.exec(block)?.[1]
      const data = /^data: (.+)$/m.exec(block)?.[1]
      if (event && data) {
        const parsed = JSON.parse(data) as Record<string, unknown>
        if (event === "text_delta") onText(String(parsed.text ?? ""))
        if (event === "done") done = parsed as unknown as StreamDone
        if (event === "error") throw new Error(String(parsed.message ?? "The reply failed."))
      }
      split = buffer.indexOf("\n\n")
    }
    if (finished) break
  }
  if (!done) throw new Error("The reply ended early.")
  return done
}

/** Scale a picture down to at most `max` pixels on its long side and re-encode as JPEG. */
export async function shrinkImage(file: Blob, max = 1600): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height))
  if (scale === 1 && file.type === "image/jpeg" && file.size < 1_500_000) return file
  const canvas = document.createElement("canvas")
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not read the picture.")), "image/jpeg", 0.85))
}

export async function uploadPhoto(input: { file: Blob; orderRef: string; uploadedBy: string; subject?: string | null; caption?: string | null }): Promise<string> {
  const form = new FormData()
  form.set("file", new File([input.file], "photo.jpg", { type: input.file.type || "image/jpeg" }))
  form.set("orderRef", input.orderRef)
  form.set("uploadedBy", input.uploadedBy)
  if (input.subject) form.set("subject", input.subject)
  if (input.caption) form.set("caption", input.caption)
  const response = await fetch("/api/channels/photos", { method: "POST", body: form })
  const body = await response.json().catch(() => null) as (PhotoUploadResponse & { error?: string }) | null
  if (!response.ok || !body?.photoId) throw new Error(body?.error ?? "The photo could not be sent.")
  return body.photoId
}

export async function fetchFeed(path: string, since: string | null): Promise<FeedResponse> {
  const response = await fetch(`${path}${since ? `?since=${encodeURIComponent(since)}` : ""}`, { cache: "no-store" })
  if (!response.ok) throw new Error("Feed unavailable")
  return response.json() as Promise<FeedResponse>
}
