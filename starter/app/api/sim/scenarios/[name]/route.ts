import { NextResponse, after } from "next/server"
import { runActions } from "@/lib/sim/actions"
import { runScenario } from "@/lib/sim/scenarios"

export const runtime = "nodejs"

export async function POST(request: Request, context: { params: Promise<{ name: string }> }) {
  const { name } = await context.params
  const origin = new URL(request.url).origin
  const result = await runScenario(name, origin)
  const actions = result.actions ?? []
  // Messages and triggers go out after we answer, so the demo panel is not kept waiting on the agent.
  if (actions.length) after(async () => { await runActions(origin, actions) })
  return NextResponse.json({ ok: result.ok, name: result.name, message: result.message, orderId: result.orderId, eventId: result.eventId },
    { status: result.ok ? 200 : 409 })
}
