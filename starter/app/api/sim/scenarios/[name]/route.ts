import { NextResponse, after } from "next/server"
import { notifyAgent } from "@/lib/sim/agent-hooks"
import { runScenario } from "@/lib/sim/scenarios"

export const runtime = "nodejs"

export async function POST(request: Request, context: { params: Promise<{ name: string }> }) {
  const { name } = await context.params
  const result = await runScenario(name)
  const trigger = result.notifyAgent
  if (trigger) {
    const origin = new URL(request.url).origin
    after(async () => { await notifyAgent(origin, trigger) })
  }
  return NextResponse.json(result, { status: result.ok ? 200 : 409 })
}
