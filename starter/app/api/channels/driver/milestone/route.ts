import { errorResponse, readJson } from "@/lib/agent/http"
import { recordMilestone, type MilestoneRequest } from "@/lib/agent/milestones"
import { loadFleet } from "@/lib/sim/fleet"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// The driver reports a step of the delivery: { orderRef, driverId, milestone, keys?, receiverName?, photoIds?, note? }.
export async function POST(request: Request) {
  try {
    const result = await recordMilestone(await readJson<MilestoneRequest>(request))
    // A collected car joins the simulated traffic and a delivered one leaves it, from the next sync on.
    await loadFleet({ fresh: true }).catch(() => undefined)
    return Response.json(result)
  } catch (error) {
    return errorResponse(error)
  }
}
