import { NextResponse } from "next/server"
import { loadChart } from "@/lib/present/chart-load"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** The home chart, polled by the map every few seconds. */
export async function GET() {
  return NextResponse.json(await loadChart())
}
