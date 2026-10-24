import { inArray } from "drizzle-orm"
import { simNowIso } from "@/lib/cr/clock"
import { db } from "@/lib/db"
import { orders } from "@/lib/schema"
import { callBrief, callScenarios, callsFor } from "@/lib/present/call-service"
import { loadDriver, loadThread } from "../../driver/data"
import { CallSimulator, type DriverPhone } from "./call-simulator"

/**
 * The call simulator, a section of Demo. Try the robo-call scenarios. Driver scenarios open the driver's phone (the
 * driver app: chat, photos, the car's status, and the Call Road Desk line);
 * desk scenarios open the call on the desk's phone.
 */
export async function CallSimulatorSection() {
  const scenarios = await callScenarios()
  const refs = [...new Set((scenarios ?? []).map((scenario) => scenario.orderRef))]
  const [stored, ids, briefs] = await Promise.all([
    Promise.all(refs.map(async (ref) => [ref, await callsFor(ref)] as const)).then(Object.fromEntries),
    refs.length ? db.select({ id: orders.id, reference: orders.reference }).from(orders).where(inArray(orders.reference, refs)) : Promise.resolve([]),
    Promise.all((scenarios ?? []).map(async (scenario) => [scenario.id, await callBrief(scenario.orderRef, scenario.purpose)] as const)),
  ])
  const orderIds = Object.fromEntries(ids.map((row) => [row.reference, row.id]))
  const phones: Record<string, DriverPhone> = {}
  for (const [scenarioId, brief] of briefs) {
    const scenario = scenarios?.find((item) => item.id === scenarioId)
    const driverId = typeof brief?.callee.driverId === "string" ? brief.callee.driverId : null
    if (!scenario || !driverId) continue
    const driver = await loadDriver(driverId)
    if (!driver) continue
    const job = driver.jobs.find((candidate) => candidate.reference === scenario.orderRef) ?? driver.jobs[0] ?? null
    phones[scenarioId] = { driver: { id: driver.id, name: driver.name }, jobs: driver.jobs, job, thread: job ? await loadThread(driver.id, job.orderId) : [] }
  }
  return <CallSimulator scenarios={scenarios} stored={stored} orderIds={orderIds} phones={phones} serverNow={simNowIso()}
      callees={Object.fromEntries(briefs.map(([id, brief]) => [id, brief?.callee.name ?? null]))} />
}
