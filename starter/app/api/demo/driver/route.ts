import { NextResponse } from "next/server"
import { simNowIso } from "@/lib/cr/clock"
import { loadDriver, loadThread } from "@/app/driver/data"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** One driver's phone for the Demo page: their jobs, the chosen job and its thread with Bahn. */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const driverId = url.searchParams.get("driver")
  const jobRef = url.searchParams.get("job")?.toUpperCase() ?? null
  if (!driverId) return NextResponse.json({ error: "driver is required" }, { status: 400 })
  const driver = await loadDriver(driverId)
  if (!driver) return NextResponse.json({ error: "Driver not found" }, { status: 404 })
  const job = (jobRef ? driver.jobs.find((candidate) => candidate.reference === jobRef) : null) ?? driver.jobs[0] ?? null
  const thread = job ? await loadThread(driver.id, job.orderId) : []
  return NextResponse.json({ driver: { id: driver.id, name: driver.name }, jobs: driver.jobs, job, thread, serverNow: simNowIso() })
}
