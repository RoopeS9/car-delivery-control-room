// Server-side sender for the channel contract (PLAN.md 4.2c), used by
// scenarios and the simulated driver. It goes through the same HTTP routes a
// driver's phone or a site's browser uses, so the demo exercises the real path.

import type { DriverMessageRequest, PhotoUploadResponse, SiteMessageRequest } from "@/lib/cr/types"

export type SentMessage = { ok: boolean; reply: string; caseId: string | null; replyEventId: string | null; heldForApproval: boolean; error: string | null }

async function postStream(url: URL, body: unknown): Promise<SentMessage> {
  const result: SentMessage = { ok: false, reply: "", caseId: null, replyEventId: null, heldForApproval: false, error: null }
  try {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    if (!response.ok || !response.body) {
      result.error = ((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${response.status}`
      return result
    }
    const text = await response.text()
    for (const block of text.split("\n\n")) {
      const event = /^event: (.+)$/m.exec(block)?.[1]
      const data = /^data: (.+)$/m.exec(block)?.[1]
      if (!event || !data) continue
      const parsed = JSON.parse(data) as Record<string, unknown>
      if (event === "text_delta") result.reply += String(parsed.text ?? "")
      if (event === "error") result.error = String(parsed.message ?? "error")
      if (event === "done") {
        result.ok = true
        result.caseId = (parsed.caseId as string | undefined) ?? null
        result.replyEventId = (parsed.replyEventId as string | null | undefined) ?? null
        result.heldForApproval = Boolean(parsed.heldForApproval)
      }
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
  }
  if (result.error) console.warn(`[sim] channel message to ${url.pathname} failed: ${result.error}`)
  return result
}

export function sendDriverMessage(origin: string, request: DriverMessageRequest): Promise<SentMessage> {
  return postStream(new URL("/api/channels/driver/messages", origin), request)
}

export function sendSiteMessage(origin: string, request: SiteMessageRequest): Promise<SentMessage> {
  return postStream(new URL("/api/channels/site/messages", origin), request)
}

/** Upload a picture from public/ (drawn for the demo) as if the driver took it. */
export async function uploadPublicPhoto(origin: string, input: { path: string; orderRef: string; uploadedBy: string; subject: string; caption?: string }): Promise<string | null> {
  try {
    const image = await fetch(new URL(input.path, origin))
    if (!image.ok) return null
    const form = new FormData()
    form.set("file", new File([await image.arrayBuffer()], input.path.split("/").pop() ?? "photo.jpg", { type: image.headers.get("content-type") ?? "image/jpeg" }))
    form.set("orderRef", input.orderRef)
    form.set("uploadedBy", input.uploadedBy)
    form.set("subject", input.subject)
    if (input.caption) form.set("caption", input.caption)
    const response = await fetch(new URL("/api/channels/photos", origin), { method: "POST", body: form })
    const body = (await response.json().catch(() => null)) as PhotoUploadResponse | null
    return response.ok && body?.photoId ? body.photoId : null
  } catch (error) {
    console.warn(`[sim] photo upload failed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}
