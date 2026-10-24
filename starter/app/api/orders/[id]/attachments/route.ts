import { GetObjectCommand } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { eq } from "drizzle-orm"
import { NextResponse } from "next/server"
import { attachmentKey, readAttachmentManifest } from "@/lib/attachments"
import { db } from "@/lib/db"
import { objectStore } from "@/lib/object-store"
import { orders } from "@/lib/schema"

export const runtime = "nodejs"

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const [order] = await db.select({ id: orders.id }).from(orders).where(eq(orders.id, id)).limit(1)
  if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 })
  const attachments = (await readAttachmentManifest()).filter((attachment) => attachment.order_id === id)
  if (!attachments.length) return NextResponse.json({ attachments: [] })
  const { client, bucket } = objectStore()
  try {
    const records = await Promise.all(attachments.map(async (attachment) => ({
      ...attachment,
      url: await getSignedUrl(client, new GetObjectCommand({
        Bucket: bucket,
        Key: attachmentKey(attachment),
        ResponseContentType: attachment.content_type,
        ResponseContentDisposition: "inline",
      }), { expiresIn: 900 }),
    })))
    return NextResponse.json({ attachments: records })
  } finally {
    client.destroy()
  }
}
