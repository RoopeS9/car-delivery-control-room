import { NextResponse } from "next/server"
import { loadEntity } from "@/lib/present/entity"
import type { EntityKind } from "@/lib/present/types"

export const runtime = "nodejs"

const KINDS: EntityKind[] = ["driver", "customer", "site"]

export async function GET(_request: Request, context: { params: Promise<{ kind: string; id: string }> }) {
  const { kind, id } = await context.params
  if (!KINDS.includes(kind as EntityKind)) return NextResponse.json({ error: "Unknown record kind" }, { status: 404 })
  const view = await loadEntity(kind as EntityKind, id)
  if (!view) return NextResponse.json({ error: `${kind} not found` }, { status: 404 })
  return NextResponse.json(view)
}
