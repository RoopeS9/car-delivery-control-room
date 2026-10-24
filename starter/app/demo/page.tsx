"use client"

// Demo controls. Not linked from the operations navigation: this is the
// presenter's panel for starting scenarios and resetting between takes.

import Link from "next/link"
import { useCallback, useEffect, useState } from "react"
import { Icon } from "../components/icons"
import styles from "./demo.module.css"

type Scenario = { name: string; title: string; orderRef: string | null; description: string; started: boolean; links: { label: string; href: string }[] }
type FleetRow = {
  reference: string; orderId: string; vehicleTitle: string; driverName: string; driverId: string
  phone: "LIVE" | "STALE" | "NONE"; state: string; placeLabel: string; speedKmh: number; fault: string | null; quietFrom: string | null
}
type FleetState = { now: string; start: string; spend: { dollars: number; runs: number }; cars: FleetRow[] }

const STATE_WORDS: Record<string, string> = {
  DRIVING: "Driving", AT_TERMINAL: "At the ferry terminal", ON_FERRY: "On the ferry", ARRIVED: "Near delivery", PARKED: "Stopped",
  LIMPING: "Reduced power", STOPPING: "Pulling over", STOPPED_IDLING: "Stopped, engine running", STOPPED_ENGINE_OFF: "Stopped, engine off",
  OVERHEATING: "Overheating", UNKNOWN: "Position unknown", LAST_SEEN: "Not reporting",
}

const clock = (iso: string) => new Date(iso).toISOString().slice(11, 19)

export default function DemoPage() {
  const [scenarios, setScenarios] = useState<Scenario[] | null>(null)
  const [fleet, setFleet] = useState<FleetState | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [log, setLog] = useState<{ at: string; text: string; ok: boolean }[]>([])
  const [error, setError] = useState("")

  const refresh = useCallback(async () => {
    try {
      const [scenarioResponse, stateResponse] = await Promise.all([fetch("/api/sim/scenarios"), fetch("/api/sim/state")])
      if (!scenarioResponse.ok || !stateResponse.ok) throw new Error("The simulator did not answer")
      setScenarios(((await scenarioResponse.json()) as { scenarios: Scenario[] }).scenarios)
      setFleet((await stateResponse.json()) as FleetState)
      setError("")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The simulator did not answer")
    }
  }, [])

  // Keep the simulated telemetry flowing while this panel is open.
  useEffect(() => {
    void refresh()
    const tick = () => fetch("/api/sim/tick", { method: "POST" }).catch(() => undefined)
    void tick()
    const ticker = setInterval(tick, 5000)
    const poller = setInterval(() => void refresh(), 3000)
    return () => { clearInterval(ticker); clearInterval(poller) }
  }, [refresh])

  async function run(name: string) {
    if (name === "reset" && !window.confirm("Reset the demo? Every case, message and decision added since the start is removed.")) return
    setBusy(name)
    try {
      const response = await fetch(`/api/sim/scenarios/${name}`, { method: "POST" })
      const result = (await response.json()) as { ok: boolean; message: string }
      setLog((items) => [{ at: new Date().toISOString(), text: result.message, ok: result.ok }, ...items].slice(0, 8))
      if (name === "reset") setLog([{ at: new Date().toISOString(), text: result.message, ok: result.ok }])
    } catch {
      setLog((items) => [{ at: new Date().toISOString(), text: "The request failed. Is the app running?", ok: false }, ...items])
    } finally {
      setBusy(null)
      void refresh()
    }
  }

  async function jump(minutes: number) {
    setBusy(`jump-${minutes}`)
    try {
      const response = await fetch("/api/sim/clock", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ minutes }) })
      const result = (await response.json()) as { now?: string; error?: string; caseTimers?: string }
      const timers = result.caseTimers === "ran" ? "Due follow-ups ran." : "The agent's case timers are not available yet."
      setLog((items) => [{ at: new Date().toISOString(), ok: response.ok,
        text: response.ok && result.now ? `Clock jumped ${minutes} min to ${clock(result.now).slice(0, 5)} UTC. ${timers}` : result.error ?? "The clock did not move." }, ...items].slice(0, 8))
    } finally {
      setBusy(null)
      void refresh()
    }
  }

  const reset = scenarios?.find((scenario) => scenario.name === "reset")
  const stories = scenarios?.filter((scenario) => scenario.name !== "reset") ?? []
  const attention = fleet?.cars.filter((car) => car.fault || car.phone !== "LIVE") ?? []

  return <main className={styles.page}>
    <header className={styles.head}>
      <div>
        <p className={styles.eyebrow}>Presenter only · not part of the control room</p>
        <h1>Demo controls</h1>
        {fleet && <p className={styles.spend}>Agent spend so far: <b className="num">${fleet.spend.dollars.toFixed(2)}</b> over {fleet.spend.runs} run{fleet.spend.runs === 1 ? "" : "s"}</p>}
      </div>
      <div className={styles.headRight}>
        <div className={styles.clock} aria-live="polite">
          <span>Sim time</span>
          <b className="num">{fleet ? clock(fleet.now) : "--:--:--"}</b>
          <span>UTC · {fleet ? new Date(fleet.now).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : "21 Oct"}</span>
        </div>
        <div className={styles.jumps} role="group" aria-label="Jump the sim clock forward">
          {[5, 15, 60].map((minutes) => <button key={minutes} type="button" disabled={busy !== null} onClick={() => void jump(minutes)}>+{minutes} min</button>)}
        </div>
        <button type="button" className={styles.danger} disabled={busy !== null} onClick={() => void run("reset")}
          title={reset?.description}>
          {busy === "reset" ? "Resetting…" : "Reset demo"}
        </button>
      </div>
    </header>

    {error && <p className={styles.error} role="alert">{error}. Check that the app and the database are running.</p>}

    <section className={styles.section} aria-labelledby="scenarios">
      <h2 id="scenarios">Scenarios</h2>
      {!scenarios && <p className={styles.muted}>Loading scenarios…</p>}
      <ul className={styles.scenarios}>
        {stories.map((scenario) => <li key={scenario.name} className={styles.scenario}>
          <div className={styles.scenarioText}>
            <h3>{scenario.title}{scenario.orderRef && <span className="mono"> · {scenario.orderRef}</span>}</h3>
            <p>{scenario.description}</p>
            {scenario.links.length > 0 && <p className={styles.scenarioLinks}>
              {scenario.links.map((link) => <Link key={link.href} href={link.href} target="_blank">{link.label} <Icon name="arrow" size={12} /></Link>)}
            </p>}
          </div>
          <div className={styles.scenarioActions}>
            {scenario.started
              ? <span className="chip tone-accent"><span className="chip-dot" />Running</span>
              : <button type="button" className={styles.primary} disabled={busy !== null} onClick={() => void run(scenario.name)}>
                {busy === scenario.name ? "Starting…" : "Run"}
              </button>}
          </div>
        </li>)}
      </ul>
    </section>

    <section className={styles.section} aria-labelledby="open">
      <h2 id="open">Open in another window</h2>
      <div className={styles.links}>
        <Link href="/" target="_blank"><Icon name="work" />Control room</Link>
        <Link href="/driver" target="_blank"><Icon name="driver" />Driver app, pick a driver</Link>
        <Link href="/site" target="_blank"><Icon name="building" />Site chat, pick a place</Link>
      </div>
    </section>

    <section className={styles.section} aria-labelledby="log">
      <h2 id="log">What happened</h2>
      {log.length === 0
        ? <p className={styles.muted}>Nothing started from this panel yet.</p>
        : <ol className={styles.log}>{log.map((item) => <li key={item.at + item.text} className={item.ok ? undefined : styles.logBad}>
          <time className="num">{clock(item.at)}</time><span>{item.text}</span>
        </li>)}</ol>}
    </section>

    <section className={styles.section} aria-labelledby="fleet">
      <h2 id="fleet">Cars on the road <span className={styles.count}>{fleet?.cars.length ?? ""}</span></h2>
      <p className={styles.muted}>Positions and engine readings are simulated from each car&apos;s last driver-app report and the sim clock.
        {attention.length > 0 && ` ${attention.length} cars have a fault or a silent phone.`}</p>
      <table className={styles.fleet}>
        <thead><tr><th>Order</th><th>Car and driver</th><th>Now</th><th>Phone</th></tr></thead>
        <tbody>
          {fleet?.cars.map((car) => <tr key={car.orderId} className={car.fault ? styles.rowFault : undefined}>
            <td className="mono">{car.reference}</td>
            <td>{car.vehicleTitle}<small>{car.driverName}</small></td>
            <td>{STATE_WORDS[car.state] ?? car.state}{car.speedKmh > 0 ? `, ${car.speedKmh} km/h` : ""}<small>{car.placeLabel}{car.fault ? ` · codes ${car.fault}` : ""}</small></td>
            <td>{phoneWords(car, fleet.now)}</td>
          </tr>)}
        </tbody>
      </table>
    </section>

    {reset && <p className={`${styles.muted} ${styles.foot}`}>Reset: {reset.description}</p>}
  </main>
}

function phoneWords(car: FleetRow, now: string): string {
  if (car.phone === "NONE") return "Never reported"
  if (car.phone === "STALE") return "Silent (dataset gap)"
  if (car.quietFrom && car.quietFrom < now) return `Silent since ${clock(car.quietFrom).slice(0, 5)}`
  return "Live"
}
