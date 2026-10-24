"use client"

import Link from "next/link"
import { useCallback, useEffect, useRef, useState } from "react"
import type { FeedMessage, GpsData, ObdData } from "@/lib/cr/types"
import type { SimObd } from "@/lib/sim/motion"
import { fmtDateTime, fmtMoney, fmtRange } from "@/lib/present/time"
import { Icon } from "../components/icons"
import { fetchFeed, sendMessage, shrinkImage, uploadPhoto } from "./channel"
import type { DriverJob, ThreadMessage } from "./data"
import styles from "./driver.module.css"

type Readings = {
  now: string
  phone: "LIVE" | "STALE" | "NONE"
  obd: { at: string; data: SimObd } | null
  gps: { at: string; data: GpsData } | null
  codes: string[]
  mil: ObdData["mil"]
  canConnect: boolean
}

/**
 * Calls go to the owner's duplex phone, which hosts the VoiceChat line, with a
 * per-call card from the call service. The in-app voice pipeline is no longer
 * linked (it had no recording and fell back to the browser's own voice).
 */
export function roadDeskCallUrl(reference: string): string {
  const card = `http://127.0.0.1:8799/card/${reference}/DRIVER_INBOUND`
  return `https://duplex.hopeajahti.lol/?dial=voicechat&card=${encodeURIComponent(card)}`
}

/** The drawn dashboard picture for scenario A. Fictional; no real car or person. */
const DEMO_PHOTO = { url: "/sim/dashboard-misfire.jpg", subject: "dashboard" }

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
  const bottom = useRef<HTMLDivElement>(null)
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

  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }) }, [thread, streaming])

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
  const answered = openRequest && thread.some((message) => message.kind === "photo" && message.at > openRequest.at)
  const photoAsk = openRequest && !answered ? openRequest : null

  return <div className={styles.app}>
    <header className={styles.top}>
      <span className={styles.avatar} aria-hidden="true">{driver.name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2)}</span>
      <div className={styles.topText}>
        <b>{driver.name}</b>
        {!onJob && <Link href="/driver">Switch driver</Link>}
      </div>
      {job && <a className={styles.callButton} href={roadDeskCallUrl(job.reference)} target="_blank" rel="noopener" title="Opens the Road Desk line in a new tab">
        <PhoneIcon /> Call Road Desk
      </a>}
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
      {job.status === "IN_PROGRESS" && <CarBar readings={readings} onConnect={async () => {
        await fetch(`/api/sim/connect/${job.reference}`, { method: "POST" }).catch(() => undefined)
        const response = await fetch(`/api/sim/telemetry/${job.reference}`, { cache: "no-store" }).catch(() => null)
        if (response?.ok) setReadings(await response.json() as Readings)
      }} />}
      <JobCard job={job} />

      <section className={styles.thread} aria-label="Messages with Bahn" aria-live="polite">
        {thread.length === 0 && streaming === null && <p className={styles.threadEmpty}>
          Write to Bahn here, or send a photo. You get an answer straight away; a person joins when a decision is needed.
        </p>}
        {thread.map((message, index) => {
          const firstNew = message.origin === null && index > 0 && thread[index - 1].origin === "dataset"
          return <div key={message.id}>
            {index === 0 && message.origin === "dataset" && <p className={styles.divider}>Earlier on this job</p>}
            {firstNew && <p className={styles.divider}>Today</p>}
            <Bubble message={message} callHref={roadDeskCallUrl(job.reference)} />
          </div>
        })}
        {streaming !== null && <div className={`${styles.bubble} ${styles.theirs}`}>
          <span className={styles.who}>Bahn assistant</span>
          {streaming ? <p>{streaming}</p> : <p className={styles.typing} aria-label="Writing"><i /><i /><i /></p>}
        </div>}
        <div ref={bottom} />
      </section>

      {photoAsk && <div className={styles.photoAsk}>
        <p><Icon name="photo" /> Bahn asks for a photo of the <b>{photoAsk.photoSubject ?? "car"}</b>.</p>
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

function Bubble({ message, callHref }: { message: ThreadMessage; callHref: string | null }) {
  const mine = message.from === "me"
  const time = new Date(message.at).toISOString().slice(11, 16)
  if (message.kind === "call") {
    return <div className={styles.call} role="status">
      <span className={styles.who}>Road Desk is calling · {time} UTC</span>
      <p>{message.text}</p>
      {callHref
        ? <a className={styles.callButton} href={callHref} target="_blank" rel="noopener"><PhoneIcon /> Answer on the Road Desk line</a>
        : <small>Calls open in the voice screen, which is not installed in this build. Reply here instead.</small>}
    </div>
  }
  if (message.kind === "safety") {
    return <div className={styles.safety} role="alert">
      <span className={styles.who}>Safety instruction · {time} UTC</span>
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
    <span className={styles.meta}>{message.voice ? "Spoken · " : ""}{time} UTC</span>
  </div>
}

function CarBar({ readings, onConnect }: { readings: Readings | null; onConnect: () => Promise<void> }) {
  const [connecting, setConnecting] = useState(false)
  if (!readings) return <div className={styles.carBar}><span className={styles.carState}>Connecting to the car…</span></div>
  const obd = readings.obd
  const age = obd ? Math.max(0, Math.round((Date.parse(readings.now) - Date.parse(obd.at)) / 1000)) : null
  const quiet = age !== null && age > 90
  const warn = readings.mil !== "OFF"
  const state = !obd ? "No car data"
    : !obd.data.engine_on ? "Engine off"
    : quiet ? `No signal from the car since ${obd.at.slice(11, 16)} UTC`
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
    {obd && <dl className={`${styles.carValues}${quiet || !obd.data.engine_on ? ` ${styles.carValuesOld}` : ""}`} title={quiet ? `Last reading at ${obd.at.slice(11, 19)} UTC` : undefined}>
      {obd.data.speed_kmh !== undefined && <div><dt>Speed</dt><dd className="num">{obd.data.speed_kmh}<small> km/h</small></dd></div>}
      {obd.data.coolant_c !== undefined && <div><dt>Coolant</dt><dd className="num">{Math.round(obd.data.coolant_c)}<small> °C</small></dd></div>}
      {obd.data.battery_v !== undefined && <div><dt>Battery</dt><dd className="num">{obd.data.battery_v}<small> V</small></dd></div>}
    </dl>}
    {readings.gps?.data.place_label && <p className={styles.carPlace}><Icon name="pin" size={13} /> {readings.gps.data.place_label} <span>· simulated GPS, {readings.gps.at.slice(11, 16)} UTC</span></p>}
  </div>
}

function JobCard({ job }: { job: DriverJob }) {
  const [open, setOpen] = useState(false)
  return <section className={styles.job} aria-label="Your job">
    <button type="button" className={styles.jobHead} onClick={() => setOpen((value) => !value)} aria-expanded={open}>
      <span className={styles.jobKicker}>{job.status === "IN_PROGRESS" ? "Driving now" : "Next job"} · <span className="mono">{job.reference}</span></span>
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
        {job.ferry.arrivalAt && <> Arrival {fmtDateTime(job.ferry.arrivalAt, job.ferry.timezone)}.</>}
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
  if (job.status === "ASSIGNED" && job.pickupSlot) return `Pick up ${fmtRange(job.pickupSlot.startAt, job.pickupSlot.endAt, job.pickupSlot.timezone)}`
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
