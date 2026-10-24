import { NextResponse } from "next/server"
import { callJob } from "@/lib/present/call-service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Polls a model-played call job on the call service: running, done (with the call and its review) or failed. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const job = await callJob(id)
  return job ? NextResponse.json(job) : NextResponse.json({ error: "No such job." }, { status: 404 })
}
