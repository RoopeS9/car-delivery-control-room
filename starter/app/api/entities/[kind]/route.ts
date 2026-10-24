import { NextResponse } from "next/server"
import { listEntities } from "@/lib/present/entity"
import type { EntityKind } from "@/lib/present/types"

export const runtime = "nodejs"

const KINDS: EntityKind[] = ["driver", "customer", "site"]

export async function GET(_request: Request, context: { params: Promise<{ kind: string }> }) {
  const { kind } = await context.params
  if (!KINDS.includes(kind as EntityKind)) return NextResponse.json({ error: "Unknown record kind" }, { status: 404 })
  return NextResponse.json(await listEntities(kind as EntityKind))
}
