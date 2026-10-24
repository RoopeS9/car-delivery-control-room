// The real driver call surface. The selected order must belong to the chosen
// driver's active work; the route never silently switches to a different job.

import type { Metadata } from "next"
import Link from "next/link"
import { carReadings } from "@/lib/sim/status"
import type { TelemetryHint } from "@/lib/voice/types"
import { loadDriver } from "../data"
import { DriverCall } from "./driver-call"
import styles from "../driver.module.css"

export const dynamic = "force-dynamic"
export const metadata: Metadata = { title: "Driver call · Road Desk" }

type Search = Promise<{ [key: string]: string | string[] | undefined }>

export default async function DriverCallPage({ searchParams }: { searchParams: Search }) {
  const params = await searchParams
  const driverId = typeof params.driver === "string" ? params.driver : null
  const orderRef = typeof params.order === "string" ? params.order.toUpperCase() : null
  const direction = params.direction === "AGENT_INITIATED" ? "AGENT_INITIATED" : "DRIVER_INITIATED"
  const driver = driverId ? await loadDriver(driverId) : null
  const job = driver?.jobs.find((candidate) => candidate.reference === orderRef)
  if (!driver || !job) {
    return <main className={styles.stage}><div className={styles.state}>
      <h1>Call unavailable</h1>
      <p>Choose one of your current jobs before calling Road Desk.</p>
      <p><Link href={driver ? `/driver?driver=${driver.id}` : "/driver"}>Back to driver app</Link></p>
    </div></main>
  }

  const readings = job.status === "IN_PROGRESS" ? await carReadings(job.reference) : null
  const freshGps = readings?.gps && readings.phone === "LIVE"
    && Date.parse(readings.now) - Date.parse(readings.gps.at) <= 90_000
  const telemetryHint: TelemetryHint | null = readings ? {
    codes: readings.codes,
    milFlashing: readings.mil === "FLASHING",
    place: freshGps ? readings.gps?.data.place_label ?? undefined : undefined,
    note: readings.obd ? `latest simulated OBD reading at ${readings.obd.at}` : undefined,
  } : null

  return <main className={styles.stage}>
    <div>
      <p style={{ marginBottom: 12 }}><Link href={`/driver?driver=${driver.id}&job=${job.reference}`}>Back to messages</Link></p>
      <DriverCall orderRef={job.reference} driverId={driver.id} direction={direction} telemetryHint={telemetryHint} />
    </div>
  </main>
}
