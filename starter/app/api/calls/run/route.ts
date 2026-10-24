import { NextResponse } from "next/server"
import { runCall } from "@/lib/present/call-service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Starts one simulated robo-call. Model-played runs answer 202 with a job id to poll; scripted runs answer 201 with the record. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { personaId?: unknown; mode?: unknown } | null
  if (typeof body?.personaId !== "string" || !body.personaId) return NextResponse.json({ error: "Choose a scenario." }, { status: 400 })
  const result = await runCall(body.personaId, body.mode === "scripted" || body.mode === "llm" ? body.mode : undefined)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 502 })
  return NextResponse.json(result.start, { status: "jobId" in result.start ? 202 : 201 })
}
