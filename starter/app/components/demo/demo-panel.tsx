"use client"

// Demo: where things are made to happen. Scenarios, clock jumps, the
// simulated driver and reset all propagate through the simulation to the map,
// the node panels and the calls. The call simulator sits below as a section.

import Link from "next/link"
import { useCallback, useEffect, useState } from "react"
import styles from "../../demo/demo.module.css"
import { recall, remember } from "../role-memory"

type Scenario = { name: string; title: string; orderRef: string | null; description: string; started: boolean; runLabel?: string | null; links: { label: string; href: string }[] }
type FleetRow = {
  reference: string; orderId: string; vehicleTitle: string; driverName: string; driverId: string
  phone: "LIVE" | "STALE" | "NONE"; state: string; placeLabel: string; speedKmh: number; fault: string | null; quietFrom: string | null
}
type FleetState = { now: string; start: string; spend: { dollars: number; runs: number }; routineCases: number; cars: FleetRow[] }

const STATE_WORDS: Record<string, string> = {
  DRIVING: "Driving", AT_TERMINAL: "At the ferry terminal", ON_FERRY: "On the ferry", ARRIVED: "Near delivery", PARKED: "Stopped",
  LIMPING: "Reduced power", STOPPING: "Pulling over", STOPPED_IDLING: "Stopped, engine running", STOPPED_ENGINE_OFF: "Stopped, engine off",
  OVERHEATING: "Overheating", UNKNOWN: "Position unknown", LAST_SEEN: "Not reporting",
}

const clock = (iso: string) => new Date(iso).toISOString().slice(11, 19)

type Autopilot = {
  enabled: boolean; available: boolean; calls: number; holdReason: string | null
  inFlight: { reference: string; purpose: string; who: string; startedAt: string } | null
  due: { orderId: string; reference: string; purpose: string; reason: string; who: string }[]
}
const PURPOSE_WORDS: Record<string, string> = { POSITION_CHECK: "Position check", FERRY_CHECKIN: "Ferry check-in", PICKUP_READINESS: "Pickup readiness", DRIVER_START_CHECK: "Start check" }
const purposeWords = (purpose: string) => PURPOSE_WORDS[purpose] ?? purpose.toLowerCase().replace(/_/g, " ")

/** The driver a scenario is about, from its driver-app link ("/driver?driver=drv-042"). */
function scenarioDriver(scenario: Scenario): string | null {
  for (const link of scenario.links) {
    const match = link.href.match(/[?&]driver=([^&]+)/)
    if (match) return decodeURIComponent(match[1])
  }
  return null
}

/** "deepseek/deepseek-v4-flash" → "DeepSeek v4 flash", "anthropic/claude-haiku-5.5" → "Claude Haiku 5.5". */
function modelName(model: string | null | undefined): string {
  if (!model) return "a model"
  const name = model.split("/").pop() ?? model
  return name.replace(/^deepseek-/, "DeepSeek ").replace(/^claude-/, "Claude ").replace(/-(\d)/g, " $1").replace(/-/g, " ")
    .replace(/\b(haiku|sonnet|opus|fable)\b/gi, (word) => word[0].toUpperCase() + word.slice(1).toLowerCase())
}

export function DemoPanel({ onFocus }: { onFocus?: (driverId: string, orderRef: string | null) => void }) {
  const [scenarios, setScenarios] = useState<Scenario[] | null>(null)
  const [fleet, setFleet] = useState<FleetState | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [log, setLog] = useState<{ at: string; text: string; ok: boolean }[]>([])
  // What happened from this panel survives switching roles and back.
  useEffect(() => { const saved = recall<{ at: string; text: string; ok: boolean }[]>("demo:log"); if (saved?.length) setLog(saved) }, [])
  useEffect(() => { if (log.length) remember("demo:log", log) }, [log])
  const [error, setError] = useState("")
  const [keepRoutine, setKeepRoutine] = useState(true)
  const [simDriver, setSimDriver] = useState<{ available: boolean; enabled: boolean; humans: string[]; usesModel: boolean; model?: string | null } | null>(null)
  const [autopilot, setAutopilot] = useState<Autopilot | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [scenarioResponse, stateResponse] = await Promise.all([fetch("/api/sim/scenarios"), fetch("/api/sim/state")])
      if (!scenarioResponse.ok || !stateResponse.ok) throw new Error("The simulator did not answer")
      setScenarios(((await scenarioResponse.json()) as { scenarios: Scenario[] }).scenarios)
      setFleet((await stateResponse.json()) as FleetState)
      const driverResponse = await fetch("/api/sim/driver")
      if (driverResponse.ok) setSimDriver(await driverResponse.json())
      const autopilotResponse = await fetch("/api/sim/autopilot")
      if (autopilotResponse.ok) setAutopilot(await autopilotResponse.json())
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
      const response = await fetch(`/api/sim/scenarios/${name}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(name === "reset" ? { keepRoutine } : {}),
      })
      const result = (await response.json()) as { ok: boolean; message: string }
      const started = scenarios?.find((scenario) => scenario.name === name)
      const driverId = started ? scenarioDriver(started) : null
      if (result.ok && driverId && onFocus) onFocus(driverId, started?.orderRef ?? null)
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
      const result = (await response.json()) as { now?: string; error?: string; caseTimers?: { ran: boolean; followedUp?: number; escalated?: number } }
      const timers = !result.caseTimers?.ran ? "The agent's case timers did not answer."
        : `Case timers ran: ${result.caseTimers.followedUp ?? 0} followed up, ${result.caseTimers.escalated ?? 0} handed to a person.`
      setLog((items) => [{ at: new Date().toISOString(), ok: response.ok,
        text: response.ok && result.now ? `Clock jumped ${minutes} min to ${clock(result.now).slice(0, 5)} UTC. ${timers}` : result.error ?? "The clock did not move." }, ...items].slice(0, 8))
    } finally {
      setBusy(null)
      void refresh()
    }
  }

  async function toggleAutopilot(enabled: boolean) {
    const response = await fetch("/api/sim/autopilot", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) })
    if (response.ok) setAutopilot(await response.json())
  }

  async function toggleSimDriver(enabled: boolean) {
    const response = await fetch("/api/sim/driver", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) })
    if (response.ok) setSimDriver(await response.json())
  }

  const reset = scenarios?.find((scenario) => scenario.name === "reset")
  const stories = scenarios?.filter((scenario) => scenario.name !== "reset") ?? []
  const attention = fleet?.cars.filter((car) => car.fault || car.phone !== "LIVE") ?? []

  return <div className="studio-controls">
    <header className={styles.head}>
      <div>
        <p className={styles.eyebrow}>Everything started here shows up on the map, in the node panels and in calls</p>
        <h1>Demo</h1>
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
            {scenarioDriver(scenario) && <p className={styles.scenarioLinks}>
              <Link className="studio-link" href={`/driver?driver=${encodeURIComponent(scenarioDriver(scenario)!)}${scenario.orderRef ? `&job=${scenario.orderRef}` : ""}`}>Show the driver</Link>
            </p>}
          </div>
          <div className={styles.scenarioActions}>
            {scenario.started
              ? <span className="chip tone-accent"><span className="chip-dot" />Running</span>
              : <button type="button" className={styles.primary} disabled={busy !== null} onClick={() => void run(scenario.name)}>
                {busy === scenario.name ? "Starting…" : scenario.runLabel ?? "Run"}
              </button>}
          </div>
        </li>)}
      </ul>
    </section>

    <CustomerWrites stories={stories} onLog={(text, ok) => setLog((items) => [{ at: new Date().toISOString(), text, ok }, ...items].slice(0, 8))} />

    {autopilot && <section className={styles.section} aria-labelledby="autopilot">
      <h2 id="autopilot">Autopilot <span className={styles.count}>{autopilot.calls} call{autopilot.calls === 1 ? "" : "s"} this session</span></h2>
      <label className={styles.keep}>
        <input type="checkbox" checked={autopilot.enabled} onChange={(event) => void toggleAutopilot(event.target.checked)} />
        Let the agent make its own check-up calls as the simulation runs: a quiet phone on a moving car, a ferry check-in closing, a pickup slot with unverified access, a driver who has not started.
      </label>
      {autopilot.inFlight && <p className={styles.muted}>Calling {autopilot.inFlight.who} now ({purposeWords(autopilot.inFlight.purpose)}, {autopilot.inFlight.reference}). The outcome lands on the order in about a minute.</p>}
      {autopilot.enabled && !autopilot.available && <p className={styles.muted}>Calls need the call service and a model key; without them the checks are listed but not placed.</p>}
      {autopilot.enabled && autopilot.due.length > 0 && <>
        <p className={styles.muted}>Due now{autopilot.holdReason ? `, held: ${autopilot.holdReason}` : ", next on the next beat"}:</p>
        <ul className={styles.dueList}>{autopilot.due.slice(0, 5).map((check) => <li key={`${check.orderId}-${check.purpose}`}>
          <b>{purposeWords(check.purpose)}</b> · <Link href={`/orders/${check.orderId}`} className="name-link">{check.reference}</Link> · {check.who}: {check.reason}</li>)}</ul>
      </>}
      {autopilot.enabled && !autopilot.due.length && <p className={styles.muted}>Nothing is due. Every call it places shows on the order's timeline, with what was said.</p>}
      <p className={styles.muted}>The scenario orders above are yours: the autopilot leaves them alone. Elsewhere a scenario started here takes precedence on its order (the readiness and start checks stand down; the position and ferry checks follow the car and still run), and an order the agent or a person is working on is left alone.</p>
    </section>}

    {simDriver?.available && <section className={styles.section} aria-labelledby="simdriver">
      <h2 id="simdriver">Simulated driver <span className={styles.count}>video only</span></h2>
      <label className={styles.keep}>
        <input type="checkbox" checked={simDriver.enabled} onChange={(event) => void toggleSimDriver(event.target.checked)} />
        Let a simulated driver answer the agent in scenarios A, B and C ({simDriver.usesModel ? `${modelName(simDriver.model)} from a fact sheet` : "scripted answers, no model key"}).
      </label>
      <p className={styles.muted}>Keep this off in the live demo: a teammate plays the driver. Typing in a driver app takes over from it for that driver.
        In scenario F nobody answers, on purpose.{simDriver.humans.length ? ` A person is playing ${simDriver.humans.length} driver${simDriver.humans.length === 1 ? "" : "s"}.` : ""}</p>
    </section>}

    <section className={styles.section} aria-labelledby="log">
      <h2 id="log">What happened</h2>
      {log.length === 0
        ? <p className={styles.muted}>Nothing started from this panel yet.</p>
        : <ol className={styles.log}>{log.map((item) => <li key={item.at + item.text} className={item.ok ? undefined : styles.logBad}>
          <time className="num">{clock(item.at)}</time><span>{item.text}</span>
        </li>)}</ol>}
    </section>

    <details className={`${styles.section} studio-fold`}>
      <summary><h2 id="fleet">Cars on the road <span className={styles.count}>{fleet?.cars.length ?? ""}</span></h2></summary>
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
    </details>

    {reset && <div className={`${styles.muted} ${styles.foot}`}>
      <p>Reset: {reset.description}</p>
      <label className={styles.keep}>
        <input type="checkbox" checked={keepRoutine} onChange={(event) => setKeepRoutine(event.target.checked)} />
        Keep the agent&apos;s routine cases on reset{fleet ? ` (${fleet.routineCases} stored)` : ""}. Seed them with <code>npm run sim:seed-routine</code>.
      </label>
    </div>}
  </div>
}

function phoneWords(car: FleetRow, now: string): string {
  if (car.phone === "NONE") return "Never reported"
  if (car.phone === "STALE") return "Silent (dataset gap)"
  if (car.quietFrom && car.quietFrom < now) return `Silent since ${clock(car.quietFrom).slice(0, 5)}`
  return "Live"
}

/** Quick lines a customer might send; anything can be typed instead. */
const CUSTOMER_LINES = [
  "Hello, can you tell us where our car is and whether it still arrives on time? We have a buyer coming.",
  "We agree to the new delivery date you proposed.",
  "Please do not tow the car yourselves; our own roadside partner will collect it this afternoon.",
  "The car arrived, thank you. One of the keys is missing, can you check with the driver?",
]

/**
 * The paying customer writes by email (simulated). The message lands on the order's case and conversations; the
 * agent drafts the answer as a card a person approves, because nothing reaches a customer without a person.
 */
function CustomerWrites({ stories, onLog }: { stories: Scenario[]; onLog: (text: string, ok: boolean) => void }) {
  const refs = [...new Set(stories.map((story) => story.orderRef).filter((ref): ref is string => Boolean(ref)))]
  const [orderRef, setOrderRef] = useState("CD-420584")
  const [text, setText] = useState(CUSTOMER_LINES[0])
  const [busy, setBusy] = useState(false)
  async function send() {
    setBusy(true)
    try {
      const response = await fetch("/api/channels/customer/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderRef: orderRef.trim().toUpperCase(), text }) })
      const result = (await response.json()) as { caseId?: string; error?: string }
      onLog(response.ok ? `The customer on ${orderRef.toUpperCase()} wrote by email (simulated). The agent drafts the answer as a card for a person.` : result.error ?? "The message was not delivered.", response.ok)
    } catch {
      onLog("The request failed. Is the app running?", false)
    } finally {
      setBusy(false)
    }
  }
  return <section className={styles.section} aria-labelledby="customer-writes">
    <h2 id="customer-writes">The customer writes <span className={styles.count}>simulated email</span></h2>
    <p className={styles.muted}>Anything the agent drafts back waits for a person before it goes out.</p>
    <div className={styles.customerForm}>
      <label>Order
        <input list="customer-orders" value={orderRef} onChange={(event) => setOrderRef(event.target.value)} placeholder="CD-420584" />
        <datalist id="customer-orders">{refs.map((ref) => <option key={ref} value={ref} />)}</datalist>
      </label>
      <label>Message
        <textarea rows={3} value={text} onChange={(event) => setText(event.target.value)} />
      </label>
      <div className={styles.customerLines}>{CUSTOMER_LINES.map((line) => <button key={line} type="button" onClick={() => setText(line)}>{line.length > 48 ? `${line.slice(0, 46)}…` : line}</button>)}</div>
      <button type="button" className={styles.primary} disabled={busy || !text.trim() || !/^CD-\d{6}$/i.test(orderRef.trim())} onClick={() => void send()}>{busy ? "Sending…" : "Send as the customer"}</button>
    </div>
  </section>
}
