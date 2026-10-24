import { NextResponse } from "next/server"
import { callsFor } from "@/lib/present/call-service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Stored robo-calls for one order, newest first. */
export async function GET(request: Request) {
  const ref = new URL(request.url).searchParams.get("ref")
  if (!ref) return NextResponse.json({ error: "ref is required" }, { status: 400 })
  return NextResponse.json(await callsFor(ref))
}
