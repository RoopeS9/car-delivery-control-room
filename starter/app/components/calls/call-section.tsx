import { inArray } from "drizzle-orm"
import { db } from "@/lib/db"
import { orders } from "@/lib/schema"
import { callBrief, callScenarios, callsFor } from "@/lib/present/call-service"
import type { CallRecord, CallScenario } from "@/lib/present/call-types"

/**
 * Data for the call simulator in Demo. Try the robo-call scenarios. Driver scenarios open the driver's phone (the
 * driver app: chat, photos, the car's status, and the Call Road Desk line);
 * desk scenarios open the call on the desk's phone.
 */
export async function loadCallData(): Promise<CallData> {
  const scenarios = await callScenarios()
  const refs = [...new Set((scenarios ?? []).map((scenario) => scenario.orderRef))]
  const [stored, ids, briefs] = await Promise.all([
    Promise.all(refs.map(async (ref) => [ref, await callsFor(ref)] as const)).then(Object.fromEntries),
    refs.length ? db.select({ id: orders.id, reference: orders.reference }).from(orders).where(inArray(orders.reference, refs)) : Promise.resolve([]),
    Promise.all((scenarios ?? []).map(async (scenario) => [scenario.id, await callBrief(scenario.orderRef, scenario.purpose)] as const)),
  ])
  const orderIds: Record<string, string> = Object.fromEntries(ids.map((row) => [row.reference, row.id]))
  const drivers: Record<string, string> = {}
  for (const [scenarioId, brief] of briefs) if (typeof brief?.callee.driverId === "string") drivers[scenarioId] = brief.callee.driverId
  const callees: Record<string, string | null> = Object.fromEntries(briefs.map(([id, brief]) => [id, brief?.callee.name ?? null]))
  return { scenarios, stored, orderIds, callees, drivers }
}

export type CallData = { scenarios: CallScenario[] | null; stored: Record<string, CallRecord[]>; orderIds: Record<string, string>; callees: Record<string, string | null>; drivers: Record<string, string> }
