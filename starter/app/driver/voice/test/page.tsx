"use client"

// Temporary test bench for the voice call (stream V). Pick a driver and an
// order, start a call, and read the transcript of record afterwards. Stream C
// mounts <CallScreen> in the real driver app.

import { useState } from "react"
import type { CallDirection, CallView, TelemetryHint } from "@/lib/voice/types"
import { CallScreen } from "../call-screen"
import styles from "./test.module.css"

type Preset = { label: string; orderRef: string; driverId: string; direction: CallDirection; codes: string; milFlashing: boolean; place: string; note: string }

const PRESETS: Preset[] = [
  { label: "A · warning light (agent calls Leo)", orderRef: "CD-420584", driverId: "drv-042", direction: "AGENT_INITIATED", codes: "P0300, P0302", milFlashing: true, place: "on the A1 near Osnabrück", note: "reduced power" },
  { label: "Emergency (Tobias calls)", orderRef: "CD-420089", driverId: "drv-055", direction: "DRIVER_INITIATED", codes: "", milFlashing: false, place: "", note: "" },
  { label: "C · keys question (Kasper calls)", orderRef: "CD-420145", driverId: "drv-130", direction: "DRIVER_INITIATED", codes: "", milFlashing: false, place: "", note: "" },
]

export default function VoiceTestPage() {
  const [form, setForm] = useState<Preset>(PRESETS[0])
  const [session, setSession] = useState(0)
  const [view, setView] = useState<CallView | null>(null)

  const hint: TelemetryHint | null = form.codes.trim() || form.milFlashing || form.place.trim()
    ? {
      codes: form.codes.split(",").map((code) => code.trim().toUpperCase()).filter(Boolean),
      milFlashing: form.milFlashing, place: form.place.trim() || undefined, note: form.note.trim() || undefined,
    }
    : null

  const set = (patch: Partial<Preset>) => setForm((current) => ({ ...current, ...patch }))
  const restart = () => { setView(null); setSession((value) => value + 1) }

  const loadTranscript = async (callId: string) => {
    const response = await fetch(`/api/voice/calls/${callId}`)
    if (response.ok) setView((await response.json()) as CallView)
  }

  return (
    <main className={styles.page}>
      <section className={styles.panel}>
        <h1 className={styles.title}>Voice call test</h1>
        <p className={styles.lead}>Temporary bench for the driver call. Use Chrome, allow the microphone, and wear headphones if you can.</p>
        <div className={styles.presets}>
          {PRESETS.map((preset) => (
            <button key={preset.label} type="button" className={styles.preset} aria-pressed={form.label === preset.label}
              onClick={() => { setForm(preset); setView(null); setSession((value) => value + 1) }}>
              {preset.label}
            </button>
          ))}
        </div>
        <div className={styles.grid}>
          <label>Order<input value={form.orderRef} onChange={(event) => set({ orderRef: event.target.value })} /></label>
          <label>Driver<input value={form.driverId} onChange={(event) => set({ driverId: event.target.value })} /></label>
          <label>Who calls
            <select value={form.direction} onChange={(event) => set({ direction: event.target.value as CallDirection })}>
              <option value="AGENT_INITIATED">Road Desk calls the driver</option>
              <option value="DRIVER_INITIATED">The driver calls Road Desk</option>
            </select>
          </label>
          <label>Trouble codes (simulated)<input value={form.codes} onChange={(event) => set({ codes: event.target.value })} placeholder="P0300, P0302" /></label>
          <label>Phone position (simulated)<input value={form.place} onChange={(event) => set({ place: event.target.value })} placeholder="on the A1 near Osnabrück" /></label>
          <label>Other car data<input value={form.note} onChange={(event) => set({ note: event.target.value })} placeholder="reduced power" /></label>
          <label className={styles.check}><input type="checkbox" checked={form.milFlashing} onChange={(event) => set({ milFlashing: event.target.checked })} />Check-engine light flashing</label>
        </div>
        <button type="button" className={styles.apply} onClick={restart}>Use these settings</button>

        {view && <Transcript view={view} />}
      </section>

      <CallScreen key={session} orderRef={form.orderRef} driverId={form.driverId} direction={form.direction} telemetryHint={hint}
        onEnded={(callId) => void loadTranscript(callId)} />
    </main>
  )
}

function Transcript({ view }: { view: CallView }) {
  return (
    <div className={styles.transcript}>
      <h2>Transcript of record</h2>
      <p className={styles.lead}>
        {view.urgency ? `${view.urgency.toLowerCase()}, from “${view.urgencyQuote}”` : "Urgency not established"} ·{" "}
        {view.situation?.toLowerCase().replace(/_/g, " ") ?? "situation unknown"} · ended: {view.endReason?.replace(/_/g, " ") ?? "open"} ·{" "}
        read-back {view.readbackConfirmed ? "confirmed" : "not confirmed"}
      </p>
      <h3>What the driver told us</h3>
      <dl className={styles.slots}>
        {Object.entries(view.slots).map(([key, slot]) => (
          <div key={key}>
            <dt>{view.slotLabels[key] ?? key}</dt>
            <dd>{slot.value} <span className={styles.quote}>“{slot.quote}”, turn {slot.turn_id.split("-").pop()}</span></dd>
          </div>
        ))}
      </dl>
      {view.missing.length > 0 && <p className={styles.lead}>Still unknown: {view.missing.map((item) => item.label).join(", ")}</p>}
      <h3>Turns</h3>
      <ol className={styles.turns}>
        {view.turns.map((turn) => (
          <li key={turn.id}>
            <strong>{turn.speaker === "agent" ? "Road Desk" : "Driver"}</strong>{" "}
            {turn.flags.silence ? <em>(no answer)</em> : turn.textFinal ?? turn.textLive}
            {turn.speaker === "driver" && turn.textLive && turn.textFinal && turn.textLive !== turn.textFinal && (
              <span className={styles.quote}> live text: “{turn.textLive}”</span>
            )}
            {turn.flags.safetyTemplates?.length ? <span className={styles.quote}> safety: {turn.flags.safetyTemplates.join(", ")}</span> : null}
            {turn.flags.screened?.length ? <span className={styles.quote}> screened: {turn.flags.screened.map((flag) => flag.category).join(", ")}</span> : null}
            {turn.audioUrl && <audio controls preload="none" src={turn.audioUrl} className={styles.audio} />}
          </li>
        ))}
      </ol>
    </div>
  )
}
