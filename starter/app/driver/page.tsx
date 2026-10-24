// The driver's phone app (demo surface). No login: pick a driver, then see
// the current job, the car's status and one thread with Bahn. Everything the
// driver writes, says or photographs goes to the same agent and case.

import type { Metadata } from "next"
import Link from "next/link"
import { simNowIso } from "@/lib/cr/clock"
import { DriverApp } from "./driver-app"
import { listDrivers, loadDriver, loadThread } from "./data"
import styles from "./driver.module.css"

export const dynamic = "force-dynamic"
export const metadata: Metadata = { title: "Driver app · Road Desk" }

type Search = Promise<{ [key: string]: string | string[] | undefined }>

export default async function DriverPage({ searchParams }: { searchParams: Search }) {
  const params = await searchParams
  const driverId = typeof params.driver === "string" ? params.driver : null
  const jobRef = typeof params.job === "string" ? params.job.toUpperCase() : null

  if (!driverId) return <Picker />
  const driver = await loadDriver(driverId)
  if (!driver) {
    return <Phone><div className={styles.state}><h1>Driver not found</h1><p><Link href="/driver">Pick a driver</Link></p></div></Phone>
  }
  const job = jobRef ? driver.jobs.find((candidate) => candidate.reference === jobRef) ?? null : driver.jobs[0] ?? null
  if (jobRef && !job) return <Phone><div className={styles.state}><h1>Job unavailable</h1><p>This job is not on {driver.name}'s current assignments.</p><p><Link href={`/driver?driver=${driver.id}`}>Back to your jobs</Link></p></div></Phone>
  const thread = job ? await loadThread(driver.id, job.orderId) : []
  return <Phone>
    <DriverApp key={`${driver.id}:${job?.reference ?? "none"}`} driver={{ id: driver.id, name: driver.name }} jobs={driver.jobs}
      job={job} initialThread={thread} serverNow={simNowIso()} />
  </Phone>
}

/** Drivers in the demo scenarios, shown first so the presenter finds them. */
const DEMO_ORDERS = ["CD-420584", "CD-420322", "CD-420145", "CD-420442"]

async function Picker() {
  const drivers = await listDrivers()
  const inDemo = (driver: (typeof drivers)[number]) => driver.jobs.some((job) => DEMO_ORDERS.includes(job.reference))
  const demo = drivers.filter(inDemo)
    .sort((a, b) => DEMO_ORDERS.findIndex((ref) => a.jobs.some((job) => job.reference === ref)) - DEMO_ORDERS.findIndex((ref) => b.jobs.some((job) => job.reference === ref)))
  const moving = drivers.filter((driver) => !inDemo(driver) && driver.jobs.some((job) => job.status === "IN_PROGRESS"))
  const upcoming = drivers.filter((driver) => !inDemo(driver) && !moving.includes(driver))
  return <Phone>
    <div className={styles.picker}>
      <header className={styles.pickerHead}>
        <p className={styles.kicker}>Bahn driver app · demo</p>
        <h1>Who is driving?</h1>
        <p className={styles.pickerNote}>No login in this prototype. Pick a driver to see the app as they do.</p>
      </header>
      {[{ title: "In the demo scenarios", list: demo }, { title: "On the road now", list: moving }, { title: "Upcoming work", list: upcoming }].map((group) => group.list.length > 0 && <section key={group.title}>
        <h2 className={styles.pickerGroup}>{group.title} <span>{group.list.length}</span></h2>
        <ul className={styles.pickerList}>
          {group.list.map((driver) => <li key={driver.id}>
            <Link href={`/driver?driver=${driver.id}`} className={styles.pickerItem}>
              <span className={styles.avatar} aria-hidden="true">{initials(driver.name)}</span>
              <span className={styles.pickerText}>
                <b>{driver.name}</b>
                <small>{driver.jobs.map((job) => `${job.vehicle}, ${job.route}`).join(" · ")}</small>
              </span>
              <span className={`mono ${styles.pickerRef}`}>{(driver.jobs.find((job) => DEMO_ORDERS.includes(job.reference)) ?? driver.jobs[0])?.reference}</span>
            </Link>
          </li>)}
        </ul>
      </section>)}
      {drivers.length === 0 && <p className={styles.pickerNote}>No driver has work in the dataset right now.</p>}
    </div>
  </Phone>
}

function Phone({ children }: { children: React.ReactNode }) {
  return <div className={styles.stage}><div className={styles.phone}>{children}</div></div>
}

function initials(name: string): string {
  return name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase()
}
