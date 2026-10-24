import { errorResponse } from "@/lib/agent/http"
import { tick } from "@/lib/agent/tick"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Timers without workers (PLAN.md 4.2): due follow-ups and the watchdog,
// evaluated against the simulated clock. Operator pages call this on every
// poll; it returns at once and any agent turns run in the background.
export async function POST() {
  try {
    return Response.json(await tick())
  } catch (error) {
    return errorResponse(error)
  }
}
