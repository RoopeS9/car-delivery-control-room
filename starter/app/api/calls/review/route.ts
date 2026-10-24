import { NextResponse } from "next/server"
import { callReview } from "@/lib/present/call-service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** The goal-alignment review of a stored outbound call. */
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id")
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 })
  const review = await callReview(id)
  return review ? NextResponse.json(review) : NextResponse.json({ error: "No review for this call." }, { status: 404 })
}
