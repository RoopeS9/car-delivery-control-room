import { NextResponse } from "next/server"
import { autopilotStatus, autopilotStep, setAutopilot } from "@/lib/sim/autopilot"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** The autopilot's state for the demo panel: on or off, what is due, what is in progress. */
export async function GET() {
  return NextResponse.json(await autopilotStatus())
}

/** `{ enabled: boolean }` turns it on or off; `{ step: true }` runs one scheduler step now. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { enabled?: unknown; step?: unknown } | null
  if (typeof body?.enabled === "boolean") setAutopilot(body.enabled)
  if (body?.step === true) return NextResponse.json(await autopilotStep(new URL(request.url).origin))
  return NextResponse.json(await autopilotStatus())
}
