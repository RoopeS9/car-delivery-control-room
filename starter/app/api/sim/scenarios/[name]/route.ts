import { NextResponse, after } from "next/server"
import { beginRuntimeWork, RuntimeBusyError } from "@/lib/cr/activity"
import { reserveScenarioActions, runActions } from "@/lib/sim/actions"
import { runScenario } from "@/lib/sim/scenarios"

export const runtime = "nodejs"

export async function POST(request: Request, context: { params: Promise<{ name: string }> }) {
  const { name } = await context.params
  const origin = new URL(request.url).origin
  const body = (await request.json().catch(() => null)) as { keepRoutine?: unknown } | null
  let release: (() => void) | undefined
  try {
    // Keep preparation visible until any returned actions have been reserved.
    // Reset itself must not acquire a work token before checking for work.
    if (name !== "reset") release = beginRuntimeWork("scenario request")
    const result = await runScenario(name, origin, { keepRoutine: body?.keepRoutine === false ? false : true })
    const actions = result.actions ?? []
    if (actions.length) {
      const releaseActions = reserveScenarioActions()
      try { after(async () => { await runActions(origin, actions, releaseActions) }) }
      catch (error) { releaseActions(); throw error }
    }
    return NextResponse.json({ ok: result.ok, name: result.name, message: result.message, orderId: result.orderId, eventId: result.eventId },
      { status: result.ok ? 200 : 409 })
  } catch (error) {
    if (error instanceof RuntimeBusyError) return NextResponse.json({ ok: false, name, message: error.message }, { status: 409 })
    throw error
  } finally { release?.() }
}
