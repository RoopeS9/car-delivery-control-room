import { NextResponse } from "next/server"
import { buildDossier } from "@/lib/present/dossier"
import { loadOrder } from "@/lib/present/load"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** One delivery's dossier for the chart's side panel. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const loaded = await loadOrder(id)
  if (!loaded) return NextResponse.json({ error: "Order not found" }, { status: 404 })
  return NextResponse.json(await buildDossier(loaded.bundle))
}
