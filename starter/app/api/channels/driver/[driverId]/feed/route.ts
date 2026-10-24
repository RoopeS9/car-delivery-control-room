import { feedMessages } from "@/lib/agent/views"
import { simNow } from "@/lib/cr/clock"
import { eventsForRecipient } from "@/lib/cr/queries"
import type { FeedResponse } from "@/lib/cr/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Messages for the driver app: everything the agent or an operator sent this
// driver after `since`, oldest first. Poll every 2 s.
export async function GET(request: Request, context: { params: Promise<{ driverId: string }> }) {
  const { driverId } = await context.params
  const since = new URL(request.url).searchParams.get("since")
  const sinceDate = since && !Number.isNaN(Date.parse(since)) ? new Date(since) : undefined
  const events = await eventsForRecipient("driver", driverId, sinceDate)
  return Response.json({ now: simNow().toISOString(), messages: await feedMessages(events) } satisfies FeedResponse)
}
