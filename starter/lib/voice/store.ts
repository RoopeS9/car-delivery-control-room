// Reads and writes for cr_calls and cr_call_turns.

import { asc, eq } from "drizzle-orm"
import { db } from "@/lib/db"
import { crCallTurns, crCalls } from "./schema"

export type CallRow = typeof crCalls.$inferSelect
export type TurnRow = typeof crCallTurns.$inferSelect

export async function insertCall(row: typeof crCalls.$inferInsert): Promise<CallRow> {
  const [created] = await db.insert(crCalls).values(row).returning()
  return created
}

export async function getCall(id: string): Promise<CallRow | null> {
  const [row] = await db.select().from(crCalls).where(eq(crCalls.id, id)).limit(1)
  return row ?? null
}

export async function updateCall(id: string, patch: Partial<typeof crCalls.$inferInsert>): Promise<CallRow> {
  const [row] = await db.update(crCalls).set(patch).where(eq(crCalls.id, id)).returning()
  return row
}

export async function insertTurn(row: typeof crCallTurns.$inferInsert): Promise<TurnRow> {
  const [created] = await db.insert(crCallTurns).values(row).returning()
  return created
}

export async function updateTurn(id: string, patch: Partial<typeof crCallTurns.$inferInsert>): Promise<void> {
  await db.update(crCallTurns).set(patch).where(eq(crCallTurns.id, id))
}

export async function listTurns(callId: string): Promise<TurnRow[]> {
  return db.select().from(crCallTurns).where(eq(crCallTurns.callId, callId)).orderBy(asc(crCallTurns.seq))
}

export async function getTurn(id: string): Promise<TurnRow | null> {
  const [row] = await db.select().from(crCallTurns).where(eq(crCallTurns.id, id)).limit(1)
  return row ?? null
}
