"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useCallback, useEffect, useRef, useState } from "react"
import type { Milestone } from "@/lib/cr/lifecycle"
import type { FeedMessage, GpsData, ObdData } from "@/lib/cr/types"
import type { SimObd } from "@/lib/sim/motion"
import { fmtClock, fmtDateTime, fmtMoney, fmtRange, zoneName } from "@/lib/present/time"
import { Icon } from "../components/icons"
import { personColor } from "@/lib/present/color"
import { fetchFeed, sendMessage, shrinkImage, uploadPhoto } from "./channel"
import type { DriverJob, ThreadMessage } from "./data"
import styles from "./driver.module.css"
import { CallScreen } from "../components/line/call-screen"

type Readings = {
  now: string
  phone: "LIVE" | "STALE" | "NONE"
  obd: { at: string; data: SimObd } | null
  gps: { at: string; data: GpsData } | null
  codes: string[]
  mil: ObdData["mil"]
  canConnect: boolean
}

/** The drawn dashboard picture for scenario A. Fictional; no real car or person. */
const DEMO_PHOTO = { url: "/sim/dashboard-misfire.jpg", subject: "dashboard" }

/** A condition picture drawn for the demo (front, rear, sides), plainly marked as not a real photo. */
async function demoConditionPicture(side: string, vehicle: string, reference: string): Promise<Blob> {
  const canvas = document.createElement("canvas")
  canvas.width = 800
  canvas.height = 560
  const g = canvas.getContext("2d")!
  const sky = g.createLinearGradient(0, 0, 0, 560)
  sky.addColorStop(0, "#d9dde0")
  sky.addColorStop(1, "#8e969c")
  g.fillStyle = sky
  g.fillRect(0, 0, 800, 560)
  g.fillStyle = "#2b3035"
  g.beginPath()
  g.roundRect(120, 250, 560, 130, 40)
  g.roundRect(240, 180, 320, 110, 50)
  g.fill()
  g.fillStyle = "#111"
  for (const x of [230, 570]) { g.beginPath(); g.arc(x, 385, 48, 0, Math.PI * 2); g.fill() }
  g.fillStyle = "#fff"
  g.font = "600 30px sans-serif"
  g.fillText(`${side} · ${vehicle}`, 40, 70)
  g.font = "22px sans-serif"
  g.fillText(`${reference} · ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`, 40, 108)
  g.fillText("Demo picture: drawn for the demo, not a real photo", 40, 520)
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not draw the picture.")), "image/jpeg", 0.7))
}

export function DriverApp({ driver, jobs, job, initialThread, serverNow, onJob }: {
  driver: { id: string; name: string }
  /** Inside Demo: switching jobs stays on the page instead of navigating to /driver. */
  onJob?: (reference: string) => void
  jobs: DriverJob[]
  job: DriverJob | null
  initialThread: ThreadMessage[]
  serverNow: string
}) {
  const [thread, setThread] = useState<ThreadMessage[]>(initialThread)
  // A live call on the Road Desk line replaces the app until it ends.
  const [calling, setCalling] = useState(false)
  const [draft, setDraft] = useState("")
  const [streaming, setStreaming] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState("")
  const [readings, setReadings] = useState<Readings | null>(null)
  const [photoMenu, setPhotoMenu] = useState(false)
  const since = useRef<string>(serverNow)
  // Messages added here carry sim time, like everything the server stores.
  const clockOffset = useRef(Date.parse(serverNow) - Date.now())
  const simIso = () => new Date(Date.now() + clockOffset.current).toISOString()
  const fileInput = useRef<HTMLInputElement>(null)
  const pendingPhotoSubject = useRef<string | null>(null)

  const add = useCallback((messages: ThreadMessage[]) => {
    setThread((current) => {
      const known = new Set(current.map((message) => message.id))
      const fresh = messages.filter((message) => !known.has(message.id))
      return fresh.length ? [...current, ...fresh].sort((a, b) => a.at.localeCompare(b.at)) : current
    })
  }, [])

  // Messages the agent or an operator sends on their own (the proactive trigger).
  useEffect(() => {
    if (!job) return
    let stopped = false
    const poll = async () => {
      try {
        const feed = await fetchFeed(`/api/channels/driver/${driver.id}/feed`, since.current)
        since.current = feed.now
        clockOffset.current = Date.parse(feed.now) - Date.now()
        if (!stopped) add(feed.messages.filter((message) => message.orderId === job.orderId).map(fromFeed))
      } catch { /* the next poll tries again */ }
    }
    const timer = setInterval(poll, 2000)
    return () => { stopped = true; clearInterval(timer) }
  }, [add, driver.id, job])

  // The car: keep the simulation ticking and read the latest OBD and phone position.
  useEffect(() => {
    if (!job || job.status !== "IN_PROGRESS") return
    let stopped = false
    const read = async () => {
      try {
        await fetch("/api/sim/tick", { method: "POST" })
        const response = await fetch(`/api/sim/telemetry/${job.reference}`, { cache: "no-store" })
        if (response.ok && !stopped) setReadings(await response.json() as Readings)
      } catch { /* keep the last reading */ }
    }
    void read()
    const timer = setInterval(read, 3000)
    return () => { stopped = true; clearInterval(timer) }
  }, [job])

  // Keep the newest message in view: on new messages, and when the panels around the thread grow (a photo request,
  // the car's readings) while the driver is reading the latest lines. Scrolls the thread only, never the page.
  const threadBox = useRef<HTMLElement>(null)
  const pinned = useRef(true)
  useEffect(() => { const box = threadBox.current; if (box) { box.scrollTop = box.scrollHeight; pinned.current = true } }, [thread, streaming])
  useEffect(() => {
    const box = threadBox.current
    if (!box || typeof ResizeObserver === "undefined") return
    const onScroll = () => { pinned.current = box.scrollHeight - box.scrollTop - box.clientHeight < 40 }
    // The box shrinks when a panel appears; a message grows when fonts or a photo load. Either way, stay at the end.
    const observer = new ResizeObserver(() => { if (pinned.current) box.scrollTop = box.scrollHeight })
    const watch = () => { observer.observe(box); for (const child of Array.from(box.children)) observer.observe(child) }
    const added = new MutationObserver(watch)
    watch()
    added.observe(box, { childList: true })
    box.addEventListener("scroll", onScroll)
    return () => { observer.disconnect(); added.disconnect(); box.removeEventListener("scroll", onScroll) }
  }, [job])

  async function send(text: string, photoIds: string[] = [], photo?: { url: string; subject: string | null }) {
    if (!job || sending) return
    const body = text.trim()
    if (!body && photoIds.length === 0) return
    // A person is playing this driver: the simulated driver (video only) stays quiet.
    void fetch("/api/sim/driver", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ human: driver.id }) }).catch(() => undefined)
    setSending(true)
    setError("")
    const at = simIso()
    const local: ThreadMessage[] = []
    if (photo) local.push({ id: `local-photo-${at}`, at, from: "me", fromName: "You", kind: "photo", text: "Photo", voice: false, photo: photo.url, photoSubject: photo.subject, origin: null })
    if (body) local.push({ id: `local-${at}`, at, from: "me", fromName: "You", kind: "message", text: body, voice: false, photo: null, photoSubject: null, origin: null })
    add(local)
    setDraft("")
    setStreaming("")
    try {
      let reply = ""
      const done = await sendMessage("/api/channels/driver/messages",
        { orderRef: job.reference, driverId: driver.id, text: body, mode: "chat", photoIds },
        (piece) => { reply += piece; setStreaming(reply) })
      if (done.replyEventId && reply.trim()) {
        add([{ id: done.replyEventId, at: simIso(), from: "agent", fromName: "Bahn assistant", kind: "message", text: reply.trim(), voice: false, photo: null, photoSubject: null, origin: null }])
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The message could not be sent.")
    } finally {
      setStreaming(null)
      setSending(false)
    }
  }

  async function sendPhoto(file: Blob, subject: string | null) {
    if (!job) return
    setError("")
    try {
      const small = await shrinkImage(file)
      const photoId = await uploadPhoto({ file: small, orderRef: job.reference, uploadedBy: driver.id, subject, caption: subject ? `Photo of the ${subject}` : null })
      await send(subject ? `Here is the photo of the ${subject}.` : "Here is a photo.", [photoId], { url: URL.createObjectURL(small), subject })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The photo could not be sent.")
    }
  }

  async function sendDemoPhoto(subject: string | null) {
    const response = await fetch(DEMO_PHOTO.url)
    await sendPhoto(await response.blob(), subject ?? DEMO_PHOTO.subject)
  }

  const openRequest = [...thread].reverse().find((message) => message.kind === "photo_request")
  // A request is open until a photo answers it, operations has written since (the case moved on), or three hours pass.
  const answered = openRequest && thread.some((message) => (message.kind === "photo" || message.from === "operator") && message.at > openRequest.at)
  const stale = openRequest && readings && Date.parse(readings.now) - Date.parse(openRequest.at) > 3 * 3600_000
  const photoAsk = openRequest && !answered && !stale ? openRequest : null

  if (calling && job) return <CallScreen onClose={() => setCalling(false)} target={{
    orderRef: job.reference, purpose: "DRIVER_INBOUND", calleeName: "Road Desk", purposeLabel: "Calling Road Desk",
    youAre: `You are ${driver.name}, the driver. Road Desk's assistant answers; tell it what is going on with the car.`,
  }} />

  return <div className={styles.app}>
    <header className={styles.top}>
      <span className={styles.avatar} aria-hidden="true" style={{ background: personColor(driver.name), color: "#fff" }}>{driver.name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2)}</span>
      <div className={styles.topText}>
        <b>{driver.name}</b>
        {!onJob && <Link href="/driver">Switch driver</Link>}
      </div>
      {job && <button type="button" className={styles.callButton} onClick={() => setCalling(true)} title="A live call with Road Desk's assistant on the turn-based line">
        <PhoneIcon /> Call Road Desk
      </button>}
    </header>

    {jobs.length > 1 && <nav className={styles.jobTabs} aria-label="Your jobs">
      {jobs.map((candidate) => onJob
        ? <button type="button" key={candidate.reference} onClick={() => onJob(candidate.reference)} aria-current={candidate.reference === job?.reference ? "page" : undefined}>
          <span className="mono">{candidate.reference}</span> {candidate.status === "IN_PROGRESS" ? "now" : "next"}
        </button>
        : <Link key={candidate.reference} href={`/driver?driver=${driver.id}&job=${candidate.reference}`}
        aria-current={candidate.reference === job?.reference ? "page" : undefined}>
        <span className="mono">{candidate.reference}</span> {candidate.status === "IN_PROGRESS" ? "now" : "next"}
      </Link>)}
    </nav>}

    {!job && <div className={styles.state}><h1>No work right now</h1><p>{driver.name} has no current or upcoming job in the records.</p></div>}

    {job && <>
      {job.status === "IN_PROGRESS" && <CarBar job={job} readings={readings} onConnect={async () => {
        await fetch(`/api/sim/connect/${job.reference}`, { method: "POST" }).catch(() => undefined)
        const response = await fetch(`/api/sim/telemetry/${job.reference}`, { cache: "no-store" }).catch(() => null)
        if (response?.ok) setReadings(await response.json() as Readings)
      }} />}
      <JobCard job={job} />
      <StepCard job={job} driverId={driver.id} onDone={(line) => add([line])} />

      <section ref={threadBox} className={styles.thread} aria-label="Messages with Bahn" aria-live="polite">
        {thread.length === 0 && streaming === null && <p className={styles.threadEmpty}>
          Write to Bahn here, or send a photo. You get an answer straight away; a person joins when a decision is needed.
        </p>}
        {thread.map((message, index) => {
          const firstNew = message.origin === null && index > 0 && thread[index - 1].origin === "dataset"
          return <div key={message.id}>
            {index === 0 && message.origin === "dataset" && <p className={styles.divider}>Earlier on this job</p>}
            {firstNew && <p className={styles.divider}>Today</p>}
            <Bubble message={message} onAnswer={() => setCalling(true)} job={job} />
          </div>
        })}
        {streaming !== null && <div className={`${styles.bubble} ${styles.theirs}`}>
          <span className={styles.who}>Bahn assistant</span>
          {streaming ? <p>{streaming}</p> : <p className={styles.typing} aria-label="Writing"><i /><i /><i /></p>}
        </div>}
      </section>

      {photoAsk && <div className={styles.photoAsk}>
        <p><Icon name="photo" /> <span>Bahn asks for a photo of the <b>{photoAsk.photoSubject ?? "car"}</b>.</span></p>
        <div>
          <button type="button" onClick={() => { pendingPhotoSubject.current = photoAsk.photoSubject; fileInput.current?.click() }}>Take photo</button>
          <button type="button" className={styles.quiet} onClick={() => void sendDemoPhoto(photoAsk.photoSubject)}>Send demo picture</button>
        </div>
      </div>}

      {error && <p className={styles.error} role="alert">{error}</p>}

      <form className={styles.composer} onSubmit={(event) => { event.preventDefault(); void send(draft) }}>
        <button type="button" className={styles.iconButton} aria-label="Send a photo" title="Send a photo" aria-expanded={photoMenu}
          onClick={() => setPhotoMenu((value) => !value)}><Icon name="photo" size={20} /></button>
        {photoMenu && <div className={styles.photoMenu} role="menu">
          <button type="button" role="menuitem" onClick={() => { setPhotoMenu(false); pendingPhotoSubject.current = null; fileInput.current?.click() }}>
            Take or choose a photo</button>
          <button type="button" role="menuitem" onClick={() => { setPhotoMenu(false); void sendDemoPhoto(null) }}>
            Demo picture: dashboard<small>Drawn for the demo, not a real photo</small></button>
        </div>}
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" capture="environment" hidden
          onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void sendPhoto(file, pendingPhotoSubject.current) }} />
        <label className={styles.field}>
          <span className="sr-only">Message to Bahn</span>
          <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Message Bahn" disabled={sending} />
        </label>
        <button type="submit" className={styles.sendButton} disabled={sending || !draft.trim()} aria-label="Send"><Icon name="arrow" size={18} /></button>
      </form>
    </>}
  </div>
}

function fromFeed(message: FeedMessage): ThreadMessage {
  const mine = message.from === "driver"
  return {
    id: message.id, at: message.at, from: mine ? "me" : message.from === "agent" ? "agent" : message.from === "operator" ? "operator" : "system",
    fromName: mine ? "You" : message.from === "agent" ? "Bahn assistant" : "Bahn operations",
    kind: message.kind, text: message.text, voice: false, photo: null, photoSubject: message.photoRequest?.subject ?? null, origin: null,
    callId: message.callId ?? null,
  }
}

/**
 * A time as the driver's phone shows it: in the zone the driver is in then. Before the ferry lands that is the pickup
 * side, after it the delivery side, and the delivery's own steps are at the delivery. In UTC a driver in Germany had
 * to do sums on the motorway (review R25).
 */
export function phoneClock(job: DriverJob | null, iso: string | null | undefined, atDelivery = false): string {
  if (!iso) return ""
  const zone = !job ? "UTC" : atDelivery || (job.ferry?.arrivalAt && iso >= job.ferry.arrivalAt) ? job.delivery.timezone : job.pickup.timezone
  const name = zone === "UTC" ? "UTC" : zoneName(new Date(iso), zone)
  return `${fmtClock(iso, zone)} ${name}`
}

const DELIVERY_SIDE: readonly Milestone[] = ["ARRIVED_DELIVERY", "DELIVERED"]

function Bubble({ message, onAnswer, job }: { message: ThreadMessage; onAnswer: (() => void) | null; job: DriverJob | null }) {
  const mine = message.from === "me"
  const time = phoneClock(job, message.at)
  if (message.kind === "call") {
    return <div className={styles.call} role="status">
      <span className={styles.who}>Road Desk is calling · {time}</span>
      <p>{message.text}</p>
      {onAnswer
        ? <button type="button" className={styles.callButton} onClick={onAnswer}><PhoneIcon /> Answer</button>
        : <small>Calls open in the voice screen, which is not installed in this build. Reply here instead.</small>}
    </div>
  }
  if (message.kind === "milestone") {
    return <p className={styles.stepLine} role="status"><Icon name="check" size={13} /> {message.text} <span>{time}</span></p>
  }
  if (message.kind === "safety") {
    return <div className={styles.safety} role="alert">
      <span className={styles.who}>Safety instruction · {time}</span>
      <p>{message.text}</p>
    </div>
  }
  return <div className={`${styles.bubble} ${mine ? styles.mine : styles.theirs}${message.origin ? ` ${styles.old}` : ""}`}>
    {!mine && <span className={styles.who}>{message.fromName}</span>}
    {message.kind === "photo"
      ? message.photo
        // eslint-disable-next-line @next/next/no-img-element
        ? <img className={styles.photo} src={message.photo} alt={message.photoSubject ? `Photo of the ${message.photoSubject}` : "Photo"} />
        : <p>Photo sent{message.photoSubject ? `: ${message.photoSubject}` : ""}</p>
      : <p>{message.text}</p>}
    <span className={styles.meta}>{message.voice ? "Spoken · " : ""}{time}</span>
  </div>
}

function CarBar({ readings, onConnect, job }: { readings: Readings | null; onConnect: () => Promise<void>; job: DriverJob | null }) {
  const [connecting, setConnecting] = useState(false)
  if (!readings) return <div className={styles.carBar}><span className={styles.carState}>Connecting to the car…</span></div>
  const obd = readings.obd
  const age = obd ? Math.max(0, Math.round((Date.parse(readings.now) - Date.parse(obd.at)) / 1000)) : null
  const quiet = age !== null && age > 90
  const warn = readings.mil !== "OFF"
  const state = !obd ? "No car data"
    : !obd.data.engine_on ? "Engine off"
    : quiet ? `No signal from the car since ${phoneClock(job, obd.at)}`
    : (obd.data.speed_kmh ?? 0) > 0 ? "Driving" : "Engine running"
  const ago = age === null ? "" : age < 60 ? `${age} s ago` : age < 3600 ? `${Math.round(age / 60)} min ago` : `${Math.round(age / 3600)} h ago`
  return <div className={`${styles.carBar}${warn ? ` ${styles.carWarn}` : ""}`}>
    <div className={styles.carTop}>
      <span className={styles.carState}><span className={styles.carDot} aria-hidden="true" />{state}</span>
      {obd && <span className={styles.carSource}>Simulated OBD · {ago}</span>}
    </div>
    {readings.canConnect && <div className={styles.connect}>
      <p>Plug the OBD dongle in and switch the ignition on (engine off) so Bahn can read the car.</p>
      <button type="button" disabled={connecting} onClick={async () => { setConnecting(true); await onConnect(); setConnecting(false) }}>
        {connecting ? "Connecting…" : "Connect the car"}
      </button>
    </div>}
    {warn && <p className={styles.carAlert}>
      <EngineIcon /> Check-engine light {readings.mil === "FLASHING" ? "flashing" : "on"}
      {readings.codes.length > 0 && <span className="mono"> · {readings.codes.join(" ")}</span>}
    </p>}
    {obd && <dl className={`${styles.carValues}${quiet || !obd.data.engine_on ? ` ${styles.carValuesOld}` : ""}`} title={quiet ? `Last reading at ${phoneClock(job, obd.at)}` : undefined}>
      {obd.data.speed_kmh !== undefined && <div><dt>Speed</dt><dd className="num">{obd.data.speed_kmh}<small> km/h</small></dd></div>}
      {obd.data.coolant_c !== undefined && <div><dt>Coolant</dt><dd className="num">{Math.round(obd.data.coolant_c)}<small> °C</small></dd></div>}
      {obd.data.battery_v !== undefined && <div><dt>Battery</dt><dd className="num">{obd.data.battery_v}<small> V</small></dd></div>}
    </dl>}
    {readings.gps?.data.place_label && <p className={styles.carPlace}><Icon name="pin" size={13} /> {readings.gps.data.place_label} <span>· simulated GPS, {phoneClock(job, readings.gps.at)}</span></p>}
  </div>
}

/** What the button says for each step. */
const STEP_ACTION: Record<Milestone, string> = {
  ARRIVED_PICKUP: "I'm at the pickup",
  COLLECTED: "Car and keys collected",
  CHECKED_IN: "Checked in at the terminal",
  ARRIVED_DELIVERY: "I'm at the delivery address",
  DELIVERED: "Hand over the car",
}

/**
 * The delivery's steps, one tap each, in order. Collecting and handing over ask for the keys counted; the handover
 * asks who took the car. Each report shows on the map and the order at once; the handover brings operations the
 * customer's delivery confirmation to approve.
 */
function StepCard({ job, driverId, onDone }: { job: DriverJob; driverId: string; onDone: (line: ThreadMessage) => void }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState(false)
  const [keys, setKeys] = useState(2)
  const [receiver, setReceiver] = useState("")
  const [error, setError] = useState("")
  // Condition photos at the collection and the handover: they become the pickup or delivery photo proof.
  const [photos, setPhotos] = useState<{ file: Blob; demo: boolean }[]>([])
  const picker = useRef<HTMLInputElement>(null)
  // Going straight past an optional arrival to the step after it.
  const [skipped, setSkipped] = useState<Milestone | null>(null)
  const done = job.steps.filter((step) => step.at).length
  const last = [...job.steps].reverse().find((step) => step.at)
  if (job.status === "DELIVERED" || !job.next) {
    return <section className={`${styles.steps} ${styles.stepsDone}`} aria-label="Delivery steps">
      <p><Icon name="check" size={14} /> <b>Delivered.</b> {last ? `${last.label}, ${phoneClock(job, last.at, true)}.` : ""} Thank you.</p>
    </section>
  }
  const next = skipped && job.steps.some((step) => step.milestone === skipped && !step.at) ? skipped : job.next
  const needsForm = next === "COLLECTED" || next === "DELIVERED"
  // An arrival is optional: from it the driver can go straight to the step after.
  const skipTo: Milestone | null = next === "ARRIVED_PICKUP" ? "COLLECTED" : next === "ARRIVED_DELIVERY" ? "DELIVERED" : null

  async function report(milestone: Milestone) {
    if (milestone === "DELIVERED" && !receiver.trim()) { setError("Write who took the car and keys."); return }
    setBusy(true)
    setError("")
    try {
      const counted = milestone === "COLLECTED" || milestone === "DELIVERED"
      const photoIds: string[] = []
      if (counted) {
        for (const photo of photos) {
          photoIds.push(await uploadPhoto({
            file: photo.demo ? photo.file : await shrinkImage(photo.file), orderRef: job.reference, uploadedBy: driverId,
            subject: milestone === "COLLECTED" ? "condition at pickup" : "condition at handover", caption: photo.demo ? "Demo picture, not a real photo" : null,
          }))
        }
      }
      const response = await fetch("/api/channels/driver/milestone", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderRef: job.reference, driverId, milestone, keys: counted ? keys : null, receiverName: milestone === "DELIVERED" ? receiver.trim() : null, photoIds }),
      })
      const result = await response.json() as { eventId?: string; at?: string; text?: string; error?: string }
      if (!response.ok || !result.eventId) throw new Error(result.error ?? "The step could not be recorded.")
      onDone({ id: result.eventId, at: result.at ?? new Date().toISOString(), from: "me", fromName: "You", kind: "milestone", text: result.text ?? STEP_ACTION[milestone], voice: false, photo: null, photoSubject: null, origin: null })
      setForm(false)
      setSkipped(null)
      setPhotos([])
      router.refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The step could not be recorded.")
    } finally {
      setBusy(false)
    }
  }

  return <section className={styles.steps} aria-label="Delivery steps">
    <div className={styles.stepHead}>
      <ol className={styles.stepDots} aria-label={`${done} of ${job.steps.length} steps done`}>
        {job.steps.map((step) => <li key={step.milestone} className={step.at ? styles.stepDone : step.milestone === next ? styles.stepNow : ""} title={`${step.label}${step.at ? `, ${phoneClock(job, step.at, DELIVERY_SIDE.includes(step.milestone))}` : ""}`} />)}
      </ol>
      <span className={styles.stepLast}>{last ? `${last.label} ${phoneClock(job, last.at, DELIVERY_SIDE.includes(last.milestone))}` : "Nothing reported yet"}</span>
    </div>
    {form && needsForm ? <div className={styles.stepForm}>
      {next === "DELIVERED" && <label>Who took the car?<input value={receiver} onChange={(event) => setReceiver(event.target.value)} placeholder="Name of the person at the desk" autoFocus /></label>}
      <label>Keys handed {next === "DELIVERED" ? "over" : "to you"}
        <select value={keys} onChange={(event) => setKeys(Number(event.target.value))}>{[1, 2, 3, 4].map((count) => <option key={count} value={count}>{count}</option>)}</select>
      </label>
      <div className={styles.stepPhotos}>
        <span>Photos of the car {photos.length ? `· ${photos.length} added${photos.some((photo) => photo.demo) ? " (demo pictures)" : ""}` : "· walk round it: front, rear, both sides"}</span>
        <div className={styles.stepButtons}>
          <button type="button" className={styles.quiet} onClick={() => picker.current?.click()} disabled={busy}>Add photos</button>
          <button type="button" className={styles.quiet} disabled={busy} onClick={async () => {
            const sides = ["Front", "Rear", "Left side", "Right side"]
            setPhotos(await Promise.all(sides.map(async (side) => ({ file: await demoConditionPicture(side, job.vehicle.title, job.reference), demo: true }))))
          }}>Demo pictures</button>
        </div>
        <input ref={picker} type="file" accept="image/png,image/jpeg,image/webp" capture="environment" multiple hidden
          onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ""; setPhotos((now) => [...now.filter((photo) => !photo.demo), ...files.map((file) => ({ file, demo: false }))].slice(0, 8)) }} />
      </div>
      <div className={styles.stepButtons}>
        <button type="button" onClick={() => void report(next)} disabled={busy}>{busy ? "Recording…" : next === "DELIVERED" ? "Confirm handover" : "Confirm collection"}</button>
        <button type="button" className={styles.quiet} onClick={() => { setForm(false); setSkipped(null) }} disabled={busy}>Cancel</button>
      </div>
    </div> : <div className={styles.stepButtons}>
      <button type="button" onClick={() => (needsForm ? setForm(true) : void report(next))} disabled={busy}>{busy ? "Recording…" : STEP_ACTION[next]}</button>
      {skipTo && <button type="button" className={styles.quiet} onClick={() => { setSkipped(skipTo); setForm(true) }} disabled={busy}>{STEP_ACTION[skipTo]}</button>}
    </div>}
    {error && <p className={styles.stepError} role="alert">{error}</p>}
  </section>
}

function JobCard({ job }: { job: DriverJob }) {
  const [open, setOpen] = useState(false)
  return <section className={styles.job} aria-label="Your job">
    <button type="button" className={styles.jobHead} onClick={() => setOpen((value) => !value)} aria-expanded={open}>
      <span className={styles.jobKicker}>{job.status === "IN_PROGRESS" ? "On the job" : job.status === "DELIVERED" ? "Delivered" : "Next job"} · <span className="mono">{job.reference}</span></span>
      <b>{job.vehicle.title}{job.vehicle.plate ? <span className="mono"> · {job.vehicle.plate}</span> : null}</b>
      <span className={styles.jobRoute}>{job.pickup.city} <Icon name="arrow" size={13} /> {job.delivery.city}</span>
      <Icon name="chevron" size={16} className={`${styles.chevron}${open ? ` ${styles.chevronOpen}` : ""}`} />
    </button>
    {!open && <p className={styles.jobNext}>{nextLine(job)}</p>}
    {open && <div className={styles.jobMore}>
      <dl className={styles.jobFacts}>
        {job.pickupSlot && <Fact label="Pick up" value={fmtRange(job.pickupSlot.startAt, job.pickupSlot.endAt, job.pickupSlot.timezone)} />}
        {job.ferry && <Fact label="Current ferry" value={job.ferry.checkInCutoffAt ? `Check in by ${fmtDateTime(job.ferry.checkInCutoffAt, job.ferry.timezone)}` : "Check-in cutoff unknown"}
          hint={`${job.ferry.origin ?? "Origin unknown"}, ${job.ferry.departureAt ? `departs ${fmtDateTime(job.ferry.departureAt, job.ferry.timezone)}` : "departure time unknown"}${job.ferry.simulated ? " · simulated booking" : ""}`} />}
        {job.deliveryPromise && <Fact label="Deliver" value={fmtRange(job.deliveryPromise.startAt, job.deliveryPromise.endAt, job.deliveryPromise.timezone)} hint={job.deliveryPromise.source ?? undefined} />}
      </dl>
      <StopBlock stop={job.pickup} title="Pick-up" />
      <StopBlock stop={job.delivery} title="Delivery" />
      {job.ferry && <p className={styles.jobNote}>Current ferry to {job.ferry.destination ?? "an unrecorded destination"}{job.ferry.reference ? <>, booking <span className="mono">{job.ferry.reference}</span></> : null}.
        {job.ferry.arrivalAt && <> Arrival {fmtDateTime(job.ferry.arrivalAt, job.delivery.timezone)}.</>}
        {job.ferry.priceAmount !== null && <> Price {fmtMoney(job.ferry.priceAmount * 100, job.ferry.currency)}.</>}
        {job.ferry.simulated && " Simulated booking."}
        {job.ferry.checkInConfirmed ? " Check-in confirmed." : " Check-in not confirmed yet."}</p>}
      {job.historicalFerries.map((booking, index) => <p className={styles.jobNote} key={booking.reference ?? index}>
        Historical ferry reservation{booking.reference ? <> <span className="mono">{booking.reference}</span></> : null}, replaced by the current booking.
        {booking.departureAt && <> Original departure {fmtDateTime(booking.departureAt, booking.timezone)}.</>}
        {booking.checkInCutoffAt && <> Original check-in cutoff {fmtDateTime(booking.checkInCutoffAt, booking.timezone)}.</>}
      </p>)}
      {job.roadDeskBookings.filter((booking) => booking.reference !== job.ferry?.reference).map((booking, index) => <p className={styles.jobNote} key={booking.reference ?? index}>
        Road Desk {booking.kind.replace(/_/g, " ").toLowerCase()}{booking.reference ? <> <span className="mono">{booking.reference}</span></> : null}: {booking.status}.
      </p>)}
    </div>}
  </section>
}

/** The one time that matters next, for the folded card. */
function nextLine(job: DriverJob): string {
  if (job.status === "DELIVERED") return "Handed over. Nothing more to do on this job."
  if (job.status === "ASSIGNED" && job.pickupSlot) return `Pick up ${fmtRange(job.pickupSlot.startAt, job.pickupSlot.endAt, job.pickupSlot.timezone)}`
  if (job.ferry?.checkInConfirmed) return job.ferry.departureAt ? `Checked in. Ferry departs ${fmtDateTime(job.ferry.departureAt, job.ferry.timezone)}` : "Checked in for the ferry"
  if (job.ferry?.checkInCutoffAt) return `Ferry check-in by ${fmtDateTime(job.ferry.checkInCutoffAt, job.ferry.timezone)}`
  if (job.ferry) return job.ferry.departureAt ? `Ferry departs ${fmtDateTime(job.ferry.departureAt, job.ferry.timezone)}` : "Ferry sailing time unknown"
  if (job.deliveryPromise) return `Deliver ${fmtRange(job.deliveryPromise.startAt, job.deliveryPromise.endAt, job.deliveryPromise.timezone)}`
  return "Tap for the pick-up and delivery details"
}

function StopBlock({ stop, title }: { stop: DriverJob["pickup"]; title: string }) {
  return <div className={styles.stop}>
    <h3>{title}: {stop.name}</h3>
    <p>{[stop.addressLine, stop.city].filter(Boolean).join(", ")}{stop.hours ? ` · ${stop.hours}` : ""}</p>
    {stop.instruction && <p className={styles.stopNote}>{stop.instruction}<small>From {stop.instructionSource}</small></p>}
    {stop.contactName && <p>Ask for {stop.contactName}{stop.contactRole ? `, ${stop.contactRole}` : ""}.</p>}
  </div>
}

function Fact({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return <div><dt>{label}</dt><dd>{value}{hint && <small>{hint}</small>}</dd></div>
}

function PhoneIcon() {
  return <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
    <path d="M3.5 2.5h2.6l1.2 3-1.6 1.1a8 8 0 0 0 3.7 3.7l1.1-1.6 3 1.2v2.6a1.5 1.5 0 0 1-1.6 1.5A11 11 0 0 1 2 4.1a1.5 1.5 0 0 1 1.5-1.6Z" />
  </svg>
}

function EngineIcon() {
  return <svg viewBox="0 0 100 64" width="22" height="14" aria-hidden="true" fill="currentColor">
    <path d="M22 6h30v8h-9v6h17l8 8h8V20h8v30h-8v-8h-6l-10 14H30l-8-10h-6v10H8V22h8v10h6V20h17v-6h-9z" />
  </svg>
}
