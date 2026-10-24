import { eq } from "drizzle-orm"
import { feedMessages } from "@/lib/agent/views"
import { simNow } from "@/lib/cr/clock"
import { crDb } from "@/lib/cr/db"
import { eventsForRecipient } from "@/lib/cr/queries"
import type { FeedResponse } from "@/lib/cr/types"
import { relatedRecords } from "@/lib/schema"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Messages for a site contact. The agent may have addressed the place by its
// site id, by the endpoint contact id, or (one-off address) by end and address.
export async function GET(request: Request, context: { params: Promise<{ siteContactId: string }> }) {
  const { siteContactId } = await context.params
  const since = new URL(request.url).searchParams.get("since")
  const sinceDate = since && !Number.isNaN(Date.parse(since)) ? new Date(since) : undefined
  const ids = new Set([siteContactId])
  if (siteContactId.startsWith("ep-")) {
    const [detail] = await crDb().select().from(relatedRecords).where(eq(relatedRecords.id, siteContactId)).limit(1)
    if (detail?.details.site_id) ids.add(String(detail.details.site_id))
    if (detail?.details.address_id) ids.add(`${String(detail.details.boundary).toLowerCase()}:${String(detail.details.address_id)}`)
  }
  const events = (await Promise.all([...ids].map((id) => eventsForRecipient("site", id, sinceDate)))).flat()
    .sort((a, b) => a.at.getTime() - b.at.getTime())
  return Response.json({ now: simNow().toISOString(), messages: await feedMessages(events) } satisfies FeedResponse)
}
