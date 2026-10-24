"use client"

// The driver's call with Road Desk (PLAN.md 4.6). Hands-free by default: the
// screen listens, notices when the driver stops talking, sends the turn, and
// plays the reply sentence by sentence. Half-duplex: the mic is off while
// Road Desk speaks. Push-to-talk for noisy places. Stream C mounts this in
// the driver app and rings it for agent-initiated calls.

import { useCallback, useEffect, useRef, useState } from "react"
import type { CallDirection, CallPhase, SpokenLine, StartCallResponse, TelemetryHint, Urgency } from "@/lib/voice/types"
import {
  SentencePlayer, closeMic, openMic, readEvents, recognitionSupported, setMicOpen, startRecognition, startRecording, startVad,
  type Mic, type Recognition, type Recording, type Vad,
} from "./audio"
import styles from "./call-screen.module.css"

export type CallScreenProps = {
  orderRef: string
  driverId: string
  direction: CallDirection
  /** Until stream C feeds OBD and GPS: what the car and phone report. */
  telemetryHint?: TelemetryHint | null
  /** Called once the call has ended, with its id (for the transcript). */
  onEnded?: (callId: string) => void
}

type Status = "idle" | "connecting" | "speaking" | "listening" | "hearing" | "thinking" | "ended" | "error"
type Caption = { id: string; speaker: "agent" | "driver"; text: string; pending?: boolean }

const REPLY_DEADLINE_MS = 20_000
const FILLER_AFTER_MS = 1800

const URGENCY_LABEL: Record<Urgency, string> = { EMERGENCY: "Emergency", URGENT: "Urgent", ROUTINE: "Routine" }

const STATUS_TEXT: Record<Status, string> = {
  idle: "", connecting: "Connecting…", speaking: "Road Desk is speaking", listening: "Listening",
  hearing: "Listening", thinking: "One moment…", ended: "Call ended", error: "",
}

export function CallScreen({ orderRef, driverId, direction, telemetryHint, onEnded }: CallScreenProps) {
  const [status, setStatus] = useState<Status>("idle")
  const [captions, setCaptions] = useState<Caption[]>([])
  const [urgency, setUrgency] = useState<{ level: Urgency; quote: string | null } | null>(null)
  const [muted, setMuted] = useState(false)
  const [pushToTalk, setPushToTalk] = useState(false)
  const [holding, setHolding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [seconds, setSeconds] = useState(0)

  const mic = useRef<Mic | null>(null)
  const call = useRef<StartCallResponse | null>(null)
  const player = useRef<SentencePlayer | null>(null)
  const vad = useRef<Vad | null>(null)
  const recording = useRef<Recording | null>(null)
  const recognition = useRef<Recognition | null>(null)
  const deadline = useRef<number | null>(null)
  const turnOpen = useRef(false)
  const turnDone = useRef(true)
  const callEnded = useRef(false)
  const live = useRef(true)
  const flags = useRef({ muted: false, pushToTalk: false })
  const captionList = useRef<HTMLOListElement | null>(null)
  const startedAt = useRef<number | null>(null)
  const afterSpeakingRef = useRef<() => void>(() => undefined)

  flags.current = { muted, pushToTalk }

  useEffect(() => {
    captionList.current?.scrollTo({ top: captionList.current.scrollHeight, behavior: "smooth" })
  }, [captions])

  useEffect(() => {
    if (!startedAt.current || status === "ended" || status === "idle") return
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - (startedAt.current ?? Date.now())) / 1000)), 1000)
    return () => window.clearInterval(timer)
  }, [status])

  const addCaption = useCallback((caption: Caption) => {
    setCaptions((list) => {
      const index = list.findIndex((item) => item.id === caption.id)
      if (index === -1) return [...list, caption]
      const next = [...list]
      next[index] = caption
      return next
    })
  }, [])

  const clearDeadline = () => {
    if (deadline.current) window.clearTimeout(deadline.current)
    deadline.current = null
  }

  const stopCapture = () => {
    vad.current?.stop()
    vad.current = null
    recognition.current?.abort()
    recognition.current = null
    void recording.current?.stop()
    recording.current = null
    clearDeadline()
  }

  const finish = useCallback(async (reason: string) => {
    if (!live.current) return
    live.current = false
    stopCapture()
    player.current?.stop()
    closeMic(mic.current)
    mic.current = null
    setStatus("ended")
    const id = call.current?.callId
    if (id) {
      if (!callEnded.current) {
        await fetch(`/api/voice/calls/${id}/end`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason }) }).catch(() => undefined)
      }
      onEnded?.(id)
    }
  }, [onEnded])

  // ------------------------------------------------------------ one driver turn

  const sendTurn = useCallback(async (input: { audio: Blob | null; liveText: string; durationMs: number; silence: boolean }) => {
    const id = call.current?.callId
    if (!id || !live.current) return
    setStatus("thinking")
    setMicOpen(mic.current, false)
    turnDone.current = false
    let heardSentence = false
    const filler = window.setTimeout(() => {
      const line = call.current?.fillers[0]
      if (!heardSentence && line && !player.current?.busy) player.current?.enqueue(line.text, line.audioUrl)
    }, FILLER_AFTER_MS)
    const form = new FormData()
    if (input.audio) form.append("audio", input.audio, `turn.${input.audio.type.includes("ogg") ? "ogg" : input.audio.type.includes("mp4") ? "m4a" : "webm"}`)
    form.append("liveText", input.liveText)
    form.append("durationMs", String(input.durationMs))
    if (input.silence) form.append("silence", "1")
    const agentCaption = `agent-${Date.now()}`
    let agentText = ""
    try {
      const response = await fetch(`/api/voice/calls/${id}/turns`, { method: "POST", body: form })
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? "The line dropped. Please try again.")
      await readEvents(response, (event, data) => {
        if (event === "driver") {
          const { turnId, text } = data as { turnId: string; text: string }
          addCaption({ id: "driver-pending", speaker: "driver", text })
          setCaptions((list) => list.map((item) => (item.id === "driver-pending" ? { ...item, id: turnId, pending: false } : item)))
        } else if (event === "sentence") {
          heardSentence = true
          const { text, audioUrl } = data as SpokenLine
          agentText = agentText ? `${agentText} ${text}` : text
          addCaption({ id: agentCaption, speaker: "agent", text: agentText })
          player.current?.enqueue(text, audioUrl)
        } else if (event === "state") {
          const state = data as { urgency: Urgency | null; urgencyQuote: string | null; phase: CallPhase }
          if (state.urgency) setUrgency({ level: state.urgency, quote: state.urgencyQuote })
        } else if (event === "done") {
          callEnded.current = (data as { ended: boolean }).ended
        } else if (event === "error") {
          setError((data as { message: string }).message)
        }
      })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The line dropped. Please try again.")
    } finally {
      window.clearTimeout(filler)
      turnDone.current = true
      if (!player.current?.busy) afterSpeakingRef.current()
    }
  }, [addCaption])

  // ------------------------------------------------------------ listening

  const endUtterance = useCallback(async () => {
    if (!turnOpen.current) return
    turnOpen.current = false
    vad.current?.stop()
    vad.current = null
    clearDeadline()
    setMicOpen(mic.current, false)
    const rec = recording.current
    const recog = recognition.current
    recording.current = null
    recognition.current = null
    const [audio, liveText] = await Promise.all([rec?.stop() ?? Promise.resolve(null), recog?.stop() ?? Promise.resolve("")])
    await sendTurn({ audio, liveText, durationMs: rec ? Date.now() - rec.startedAt : 0, silence: false })
  }, [sendTurn])

  const beginCapture = useCallback(() => {
    if (!mic.current || turnOpen.current) return
    turnOpen.current = true
    setMicOpen(mic.current, true)
    recording.current = startRecording(mic.current)
    if (call.current?.liveStt !== "server" && recognitionSupported()) {
      recognition.current = startRecognition((text) => addCaption({ id: "driver-pending", speaker: "driver", text, pending: true }), () => {
        clearDeadline()
        setStatus("hearing")
      })
    }
  }, [addCaption])

  const listen = useCallback(() => {
    if (!live.current || !mic.current) return
    if (flags.current.muted) { setStatus("listening"); return }
    setStatus("listening")
    clearDeadline()
    deadline.current = window.setTimeout(() => {
      // Reply deadline: nothing said. Tell the server; it asks again, then ends the call.
      turnOpen.current = false
      stopCapture()
      void sendTurn({ audio: null, liveText: "", durationMs: 0, silence: true })
    }, REPLY_DEADLINE_MS)
    if (flags.current.pushToTalk) return
    beginCapture()
    vad.current = startVad(mic.current, {
      onStart: () => { clearDeadline(); setStatus("hearing") },
      onEnd: () => void endUtterance(),
    })
  }, [beginCapture, endUtterance, sendTurn])

  function afterSpeaking() {
    if (!live.current || !turnDone.current) return
    if (callEnded.current) { void finish("completed"); return }
    listen()
  }
  // Player and stream callbacks outlive renders; always call the latest version.
  afterSpeakingRef.current = afterSpeaking

  // ------------------------------------------------------------ start and stop

  const start = useCallback(async () => {
    setError(null)
    setCaptions([])
    setUrgency(null)
    live.current = true
    callEnded.current = false
    setStatus("connecting")
    try {
      mic.current = await openMic()
      setMicOpen(mic.current, false)
    } catch {
      setStatus("error")
      setError("Road Desk needs the microphone. Allow it in the browser and try again.")
      return
    }
    player.current = new SentencePlayer({
      onStart: () => { setStatus("speaking"); setMicOpen(mic.current, false) },
      onIdle: () => afterSpeakingRef.current(),
    })
    try {
      const response = await fetch("/api/voice/calls", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderRef, driverId, direction, telemetryHint: telemetryHint ?? null }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body?.error ?? "Could not reach Road Desk.")
      call.current = body as StartCallResponse
      startedAt.current = Date.now()
      setSeconds(0)
      addCaption({ id: "opening", speaker: "agent", text: call.current.opening.text })
      turnDone.current = true
      player.current.enqueue(call.current.opening.text, call.current.opening.audioUrl)
    } catch (failure) {
      closeMic(mic.current)
      mic.current = null
      live.current = false
      setStatus("error")
      setError(failure instanceof Error ? failure.message : "Could not reach Road Desk.")
    }
  }, [orderRef, driverId, direction, telemetryHint, addCaption])

  useEffect(() => () => {
    live.current = false
    stopCapture()
    player.current?.stop()
    closeMic(mic.current)
  }, [])

  const toggleMute = () => {
    const next = !muted
    setMuted(next)
    flags.current.muted = next
    if (next) {
      turnOpen.current = false
      stopCapture()
      setMicOpen(mic.current, false)
    } else if (status === "listening" || status === "hearing") {
      listen()
    }
  }

  const toggleMode = () => {
    const next = !pushToTalk
    setPushToTalk(next)
    flags.current.pushToTalk = next
    if (status === "listening" || status === "hearing") {
      turnOpen.current = false
      stopCapture()
      listen()
    }
  }

  const pressTalk = () => {
    if (status !== "listening" || muted) return
    setHolding(true)
    clearDeadline()
    beginCapture()
    setStatus("hearing")
  }
  const releaseTalk = () => {
    if (!holding) return
    setHolding(false)
    void endUtterance()
  }

  // ------------------------------------------------------------ view

  const inCall = !["idle", "ended", "error"].includes(status)
  const ringing = direction === "AGENT_INITIATED"
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`

  return (
    <section className={styles.phone} aria-label="Call with Road Desk">
      <header className={styles.header}>
        <div className={styles.who}>
          <span className={styles.name}>Road Desk</span>
          <span className={styles.meta}>{orderRef}{inCall ? ` · ${clock}` : ""}</span>
        </div>
        {urgency && (
          <span className={`${styles.badge} ${styles[urgency.level.toLowerCase()]}`} title={urgency.quote ? `“${urgency.quote}”` : undefined}>
            {URGENCY_LABEL[urgency.level]}
          </span>
        )}
      </header>

      <div className={styles.stage}>
        <div className={`${styles.orb} ${status === "speaking" ? styles.orbSpeaking : ""} ${status === "hearing" ? styles.orbHearing : ""}`} aria-hidden />
        <p className={styles.status} aria-live="polite">
          {status === "idle" ? (ringing ? "Road Desk is calling" : "Call Road Desk") : muted && inCall ? "Muted" : STATUS_TEXT[status]}
        </p>
        {error && <p className={styles.error} role="alert">{error}</p>}
      </div>

      <ol className={styles.captions} ref={captionList} aria-label="Live captions">
        {captions.map((caption) => (
          <li key={caption.id} className={`${styles.caption} ${caption.speaker === "agent" ? styles.agent : styles.driver} ${caption.pending ? styles.pending : ""}`}>
            <span className={styles.speaker}>{caption.speaker === "agent" ? "Road Desk" : "You"}</span>
            {caption.text}
          </li>
        ))}
      </ol>

      {inCall && pushToTalk && (
        <button
          type="button"
          className={`${styles.talk} ${holding ? styles.talkHeld : ""}`}
          disabled={status !== "listening" && !holding}
          onPointerDown={pressTalk}
          onPointerUp={releaseTalk}
          onPointerLeave={releaseTalk}
        >
          {holding ? "Release to send" : "Hold to talk"}
        </button>
      )}

      <footer className={styles.controls}>
        <button type="button" className={styles.small} onClick={toggleMute} disabled={!inCall} aria-pressed={muted}>
          <MicIcon off={muted} />
          <span>{muted ? "Unmute" : "Mute"}</span>
        </button>
        {inCall ? (
          <button type="button" className={`${styles.big} ${styles.hangup}`} onClick={() => void finish("hang_up")} aria-label="Hang up">
            <PhoneIcon down />
          </button>
        ) : (
          <button type="button" className={`${styles.big} ${styles.answer}`} onClick={() => void start()} aria-label={ringing ? "Answer" : "Call"}>
            <PhoneIcon />
          </button>
        )}
        <button type="button" className={styles.small} onClick={toggleMode} aria-pressed={pushToTalk}>
          <HandIcon />
          <span>{pushToTalk ? "Hands-free" : "Push to talk"}</span>
        </button>
      </footer>
    </section>
  )
}

function PhoneIcon({ down = false }: { down?: boolean }) {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" aria-hidden style={down ? { transform: "rotate(135deg)" } : undefined}>
      <path fill="currentColor" d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z" />
    </svg>
  )
}

function MicIcon({ off }: { off: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
      {off && <path d="M4 4l16 16" />}
    </svg>
  )
}

function HandIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11m0-6.5a1.5 1.5 0 0 1 3 0V11m0-5a1.5 1.5 0 0 1 3 0v7c0 4-2.5 7-6 7-2.5 0-4-1.2-5.3-3L4 14.6a1.5 1.5 0 0 1 2.4-1.8L8 14.5" />
    </svg>
  )
}
