import { errorResponse } from "@/lib/agent/http"
import { ChannelError, storePhoto } from "@/lib/agent/triggers"
import type { PhotoUploadResponse } from "@/lib/cr/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Multipart upload: file, orderRef, optional subject, caption and uploadedBy (driver or site contact id).
export async function POST(request: Request) {
  try {
    const form = await request.formData().catch(() => { throw new ChannelError(400, "Send the photo as multipart form data.") })
    const file = form.get("file")
    const orderRef = form.get("orderRef")
    if (!(file instanceof File) || typeof orderRef !== "string") throw new ChannelError(400, "file and orderRef are required.")
    const text = (key: string) => (typeof form.get(key) === "string" ? String(form.get(key)) : null)
    const photoId = await storePhoto({
      orderRef, mediaType: file.type, bytes: Buffer.from(await file.arrayBuffer()),
      subject: text("subject"), caption: text("caption"), uploadedBy: text("uploadedBy"),
    })
    return Response.json({ photoId } satisfies PhotoUploadResponse)
  } catch (error) {
    return errorResponse(error)
  }
}
