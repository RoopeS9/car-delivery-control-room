import { inArray } from "drizzle-orm"
import { connection } from "next/server"
import { db } from "@/lib/db"
import { orders } from "@/lib/schema"
import { callBrief, callScenarios, callsFor } from "@/lib/present/call-service"
import { AppFrame } from "../components/app-frame"
import { CallSimulator } from "../components/calls/call-simulator"

export const metadata = { title: "Call simulator · Road Desk" }

/** Try the robo-call scenarios: who is called, why, and what the call established. */
export default async function CallsPage() {
  await connection()
  const scenarios = await callScenarios()
  const refs = [...new Set((scenarios ?? []).map((scenario) => scenario.orderRef))]
  const [stored, ids, callees] = await Promise.all([
    Promise.all(refs.map(async (ref) => [ref, await callsFor(ref)] as const)).then(Object.fromEntries),
    refs.length ? db.select({ id: orders.id, reference: orders.reference }).from(orders).where(inArray(orders.reference, refs)) : Promise.resolve([]),
    Promise.all((scenarios ?? []).map(async (scenario) => [scenario.id, (await callBrief(scenario.orderRef, scenario.purpose))?.callee.name ?? null] as const)).then(Object.fromEntries),
  ])
  return <AppFrame section="calls">
    <CallSimulator scenarios={scenarios} stored={stored} orderIds={Object.fromEntries(ids.map((row) => [row.reference, row.id]))} callees={callees} />
  </AppFrame>
}
