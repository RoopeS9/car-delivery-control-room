// Routine driver questions for the queue's "Handled by the agent" section
// (PLAN.md 4.5). Each one is answerable from the order and site records, on a
// quiet moving order that no demo scenario touches. `npm run sim:seed-routine`
// runs the real agent on them; the demo reset can keep the results.

import { and, inArray, isNull, like, notInArray, or } from "drizzle-orm"
import { crDb } from "@/lib/cr/db"
import { resetCrData } from "@/lib/cr/queries"
import { crAgentRuns, crCases, crEffects, crEvents, crProposals, crTelemetry } from "@/lib/cr/schema"
import { crCalls, crCallTurns } from "@/lib/voice/schema"

export type RoutineQuestion = { reference: string; text: string; answerFrom: string }

export const ROUTINE_QUESTIONS: RoutineQuestion[] = [
  { reference: "CD-420452", text: "What time does Kervandorio in Tampere close today? I'll probably get there around five.",
    answerFrom: "site opening hours 09:00–18:00 and the call-ahead instruction" },
  { reference: "CD-420338", text: "Who do I give the keys to at Kovellin in Hamburg?",
    answerFrom: "delivery instruction: reception receives the keys and signs the handover" },
  { reference: "CD-420917", text: "Which entrance do I use at Norvessia in Turku?",
    answerFrom: "delivery instruction: the marked vehicle entrance, confirmed by site staff for this order" },
  { reference: "CD-420619", text: "Where do I drive in at the storage place in Helsinki?",
    answerFrom: "delivery instruction: the courtyard vehicle gate, confirmed by the local contact" },
]

export const ROUTINE_REFERENCES = ROUTINE_QUESTIONS.map((question) => question.reference)

async function routineOrderIds(): Promise<string[]> {
  const { orders } = await import("@/lib/schema")
  const rows = await crDb().select({ id: orders.id }).from(orders).where(inArray(orders.reference, ROUTINE_REFERENCES))
  return rows.map((row) => row.id)
}

/** How many routine cases are stored now. */
export async function routineCaseCount(): Promise<number> {
  const ids = await routineOrderIds()
  if (ids.length === 0) return 0
  return (await crDb().select({ id: crCases.id }).from(crCases).where(inArray(crCases.orderId, ids))).length
}

/**
 * Clear our rows for a fresh take. With `keepRoutine`, the routine orders'
 * cases, messages and agent runs stay; everything else goes, telemetry included
 * (it is regenerated from the sim clock). Autonomy settings always stay.
 */
/**
 * Messages the app filed in the order conversations (sent customer and site messages, the operator's helpdesk):
 * rows with an `app-` id. The dataset's own messages stay.
 */
async function clearAppMessages(keep: string[]): Promise<void> {
  const { conversations, messages } = await import("@/lib/schema")
  const db = crDb()
  await db.delete(messages).where(and(like(messages.id, "msg-app-%"), keep.length ? notInArray(messages.orderId, keep) : undefined))
  await db.delete(conversations).where(and(like(conversations.id, "conv-app-%"), keep.length ? notInArray(conversations.orderId, keep) : undefined))
}

export async function clearDemoData(options: { keepRoutine: boolean }): Promise<void> {
  const keep = options.keepRoutine ? await routineOrderIds() : []
  await clearAppMessages(keep)
  if (keep.length === 0) {
    await clearVoiceData()
    return resetCrData()
  }
  await crDb().transaction(async (tx) => {
    const removedCalls = tx.select({ id: crCalls.id }).from(crCalls).where(notInArray(crCalls.orderId, keep))
    await tx.delete(crCallTurns).where(inArray(crCallTurns.callId, removedCalls))
    await tx.delete(crCalls).where(notInArray(crCalls.orderId, keep))
    await tx.delete(crEffects).where(notInArray(crEffects.orderId, keep))
    await tx.delete(crProposals).where(notInArray(crProposals.orderId, keep))
    await tx.delete(crEvents).where(notInArray(crEvents.orderId, keep))
    await tx.delete(crAgentRuns).where(or(isNull(crAgentRuns.orderId), notInArray(crAgentRuns.orderId, keep)))
    await tx.delete(crTelemetry)
    await tx.delete(crCases).where(notInArray(crCases.orderId, keep))
  })
}

/** Remove only the routine orders' rows, before seeding them again. */
export async function clearRoutine(): Promise<void> {
  const ids = await routineOrderIds()
  if (ids.length === 0) return
  await crDb().transaction(async (tx) => {
    const removedCalls = tx.select({ id: crCalls.id }).from(crCalls).where(inArray(crCalls.orderId, ids))
    await tx.delete(crCallTurns).where(inArray(crCallTurns.callId, removedCalls))
    await tx.delete(crCalls).where(inArray(crCalls.orderId, ids))
    await tx.delete(crEffects).where(inArray(crEffects.orderId, ids))
    await tx.delete(crProposals).where(inArray(crProposals.orderId, ids))
    await tx.delete(crEvents).where(inArray(crEvents.orderId, ids))
    await tx.delete(crAgentRuns).where(inArray(crAgentRuns.orderId, ids))
    await tx.delete(crCases).where(inArray(crCases.orderId, ids))
  })
}

/** Calls are demo data too: do not leave transcripts from a previous take. */
async function clearVoiceData(): Promise<void> {
  await crDb().transaction(async (tx) => {
    await tx.delete(crCallTurns)
    await tx.delete(crCalls)
  })
}
