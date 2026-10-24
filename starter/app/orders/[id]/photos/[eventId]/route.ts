import { getEvent } from "@/lib/cr/queries"
import type { PhotoData } from "@/lib/cr/types"

export const runtime = "nodejs"

// A photo sent on a case. Stored inline on its event, served here so the
// polled order view stays small. Only photos that belong to this order.
export async function GET(_request: Request, context: { params: Promise<{ id: string; eventId: string }> }) {
  const { id, eventId } = await context.params
  const event = await getEvent(eventId).catch(() => null)
  const data = event?.data as Partial<PhotoData> | undefined
  if (!event || event.orderId !== id || event.kind !== "photo" || !data?.base64 || !data.media_type) {
    return new Response("Photo not found", { status: 404 })
  }
  return new Response(new Uint8Array(Buffer.from(data.base64, "base64")), {
    headers: { "Content-Type": data.media_type, "Cache-Control": "private, max-age=3600, immutable" },
  })
}
