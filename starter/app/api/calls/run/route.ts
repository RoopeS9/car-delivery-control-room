import { NextResponse } from "next/server"
import { runCall } from "@/lib/present/call-service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Runs one simulated robo-call through the local call service. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { personaId?: unknown } | null
  if (typeof body?.personaId !== "string" || !body.personaId) return NextResponse.json({ error: "Choose a scenario." }, { status: 400 })
  const result = await runCall(body.personaId)
  return result.ok ? NextResponse.json(result.call) : NextResponse.json({ error: result.error }, { status: 502 })
}
