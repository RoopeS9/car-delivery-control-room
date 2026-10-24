// The Driver panel: the driver we roleplay. A switcher of drivers on the left,
// their phone in the middle: the current job, the car's status, one thread
// with Bahn, photos, and Call Road Desk. Everything the driver writes or
// photographs goes to the same agent and case and shows on the map.

import { personColor } from "@/lib/present/color"
import type { Metadata } from "next"
import Link from "next/link"
import { simNowIso } from "@/lib/cr/clock"
import { DriverApp } from "./driver-app"
import { listDrivers, loadDriver, loadThread } from "./data"
import styles from "./driver.module.css"
import { AppFrame } from "../components/app-frame"
import "./panel.css"

export const dynamic = "force-dynamic"
export const metadata: Metadata = { title: "Driver app · Road Desk" }

type Search = Promise<{ [key: string]: string | string[] | undefined }>

export default async function DriverPage({ searchParams }: { searchParams: Search }) {
  const params = await searchParams
  const driverId = typeof params.driver === "string" ? params.driver : null
  const jobRef = typeof params.job === "string" ? params.job.toUpperCase() : null
  const drivers = await listDrivers()
  let phone: React.ReactNode
  if (!driverId) {
    phone = <div className={styles.state}><h1>Pick a driver</h1><p>Choose who you are playing on the left. Scenarios in Demo link here with the right driver.</p></div>
  } else {
    const driver = await loadDriver(driverId)
    const job = driver ? (jobRef ? driver.jobs.find((candidate) => candidate.reference === jobRef) ?? null : driver.jobs[0] ?? null) : null
    if (!driver) phone = <div className={styles.state}><h1>Driver not found</h1><p>Pick a driver on the left.</p></div>
    else if (jobRef && !job) phone = <div className={styles.state}><h1>Job unavailable</h1><p>This job is not on {driver.name}&apos;s current assignments.</p><p><Link href={`/driver?driver=${driver.id}`}>Back to their jobs</Link></p></div>
    else {
      const thread = job ? await loadThread(driver.id, job.orderId) : []
      phone = <DriverApp key={`${driver.id}:${job?.reference ?? "none"}`} driver={{ id: driver.id, name: driver.name }} jobs={driver.jobs}
        job={job} initialThread={thread} serverNow={simNowIso()} />
    }
  }
  return <AppFrame section="driver">
    <main className="driver-panel">
      <Picker drivers={drivers} current={driverId} />
      <div className="driver-stage">
        <div className={styles.phone}>{phone}</div>
        <p className="driver-note">Call Road Desk is a live call with Road Desk&apos;s assistant on the Road Desk line (local speech recognition, the dossier model, a synthetic voice). Allow the microphone when asked.</p>
      </div>
    </main>
  </AppFrame>
}

/** Drivers in the demo scenarios, shown first so the presenter finds them. */
const DEMO_ORDERS = ["CD-420584", "CD-420322", "CD-420145", "CD-420439", "CD-420442"]

function Picker({ drivers, current }: { drivers: Awaited<ReturnType<typeof listDrivers>>; current: string | null }) {
  const inDemo = (driver: (typeof drivers)[number]) => driver.jobs.some((job) => DEMO_ORDERS.includes(job.reference))
  const demo = drivers.filter(inDemo)
    .sort((a, b) => DEMO_ORDERS.findIndex((ref) => a.jobs.some((job) => job.reference === ref)) - DEMO_ORDERS.findIndex((ref) => b.jobs.some((job) => job.reference === ref)))
  const moving = drivers.filter((driver) => !inDemo(driver) && driver.jobs.some((job) => job.status === "IN_PROGRESS"))
  const upcoming = drivers.filter((driver) => !inDemo(driver) && !moving.includes(driver))
  return <nav className="driver-picker" aria-label="Drivers" data-keep-scroll="drivers">
    <header>
      <h1>Driver</h1>
      <p>The driver&apos;s side of the story. No login in this prototype: pick who you are playing.</p>
    </header>
    {[{ title: "In the demo scenarios", list: demo }, { title: "On the road now", list: moving }, { title: "Upcoming work", list: upcoming }].map((group) => group.list.length > 0 && <section key={group.title}>
      <h2 className={styles.pickerGroup}>{group.title} <span>{group.list.length}</span></h2>
      <ul className={styles.pickerList}>
        {group.list.map((driver) => <li key={driver.id}>
          <Link href={`/driver?driver=${driver.id}`} className={`${styles.pickerItem}${driver.id === current ? " picked" : ""}`} aria-current={driver.id === current ? "page" : undefined}>
            <span className={styles.avatar} aria-hidden="true" style={{ background: personColor(driver.name), color: "#fff" }}>{initials(driver.name)}</span>
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
  </nav>
}

function initials(name: string): string {
  return name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase()
}
