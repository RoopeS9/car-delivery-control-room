import { NextRequest, NextResponse } from "next/server"
import { buildBoardCard } from "@/lib/present/board"
import { LANE_ORDER } from "@/lib/present/labels"
import { loadBoardBundles } from "@/lib/present/load"
import type { BoardCard, Overview, Tone } from "@/lib/present/types"

export const runtime = "nodejs"

const TONE_RANK: Record<Tone, number> = { danger: 0, warn: 1, accent: 2, neutral: 3, ok: 4 }

/** Cards that need a person first, then by the date that decides the next step. */
function laneSort(lane: string) {
  return (a: BoardCard, b: BoardCard): number => {
    const attention = TONE_RANK[a.attentionTone] - TONE_RANK[b.attentionTone]
    if (attention) return attention
    const aDate = a.decisive?.start ?? ""
    const bDate = b.decisive?.start ?? ""
    if (lane === "delivered" || lane === "cancelled") return bDate.localeCompare(aDate) || b.updatedAt.localeCompare(a.updatedAt)
    if (aDate && bDate && aDate !== bDate) return aDate.localeCompare(bDate)
    if (aDate !== bDate) return aDate ? -1 : 1
    return b.updatedAt.localeCompare(a.updatedAt)
  }
}

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get("q")?.trim().toLowerCase() ?? ""
  const { snapshotAt, bundles } = await loadBoardBundles()
  const all = bundles.map(buildBoardCard)
  const counts = Object.fromEntries(LANE_ORDER.map((lane) => [lane, all.filter((card) => card.displayLane === lane).length]))
  const attentionCounts = Object.fromEntries(LANE_ORDER.map((lane) => [lane, all.filter((card) => card.displayLane === lane && card.attention.length > 0).length]))
  const matches = query ? all.filter((card) => [
    card.reference, card.customer, card.vehicle, card.origin, card.destination, card.plate ?? "",
  ].some((field) => field.toLowerCase().includes(query))) : all
  const visible = LANE_ORDER.flatMap((lane) => matches.filter((card) => card.displayLane === lane).sort(laneSort(lane)))
  const body: Overview = { snapshotAt, total: all.length, counts, attentionCounts, visible, query }
  return NextResponse.json(body)
}
