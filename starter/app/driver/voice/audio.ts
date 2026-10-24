"use client"

// Browser audio for the call screen: microphone with echo cancellation, an
// energy-based voice activity detector, recording of each utterance, Chrome's
// live speech recognition, and an in-order sentence player that falls back
// to speechSynthesis when server audio fails.

// ---------------------------------------------------------------- microphone

export type Mic = { stream: MediaStream; context: AudioContext; analyser: AnalyserNode; track: MediaStreamTrack }

export async function openMic(): Promise<Mic> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  })
  const context = new AudioContext()
  if (context.state === "suspended") await context.resume()
  const source = context.createMediaStreamSource(stream)
  const analyser = context.createAnalyser()
  analyser.fftSize = 1024
  source.connect(analyser)
  return { stream, context, analyser, track: stream.getAudioTracks()[0] }
}

export function closeMic(mic: Mic | null): void {
  if (!mic) return
  mic.stream.getTracks().forEach((track) => track.stop())
  void mic.context.close().catch(() => undefined)
}

/** Half-duplex: the mic is off while the agent speaks or when muted. */
export function setMicOpen(mic: Mic | null, open: boolean): void {
  if (mic) mic.track.enabled = open
}

// ---------------------------------------------------------------- voice activity

export type Vad = { stop: () => void }

/**
 * Calls onStart when speech begins and onEnd after ~0.9 s of quiet. The first
 * 250 ms measure the room's noise floor.
 */
export function startVad(mic: Mic, handlers: { onStart: () => void; onEnd: () => void; onLevel?: (level: number) => void }): Vad {
  const data = new Float32Array(mic.analyser.fftSize)
  let floor = 0.005
  let calibrating = 5
  let loud = 0
  let quiet = 0
  let speaking = false
  let spokenMs = 0
  const tickMs = 50
  const timer = window.setInterval(() => {
    mic.analyser.getFloatTimeDomainData(data)
    let sum = 0
    for (const value of data) sum += value * value
    const rms = Math.sqrt(sum / data.length)
    handlers.onLevel?.(rms)
    if (calibrating > 0) {
      floor = Math.max(floor, rms)
      calibrating -= 1
      return
    }
    const threshold = Math.max(0.018, floor * 2.5)
    if (rms > threshold) {
      loud += 1
      quiet = 0
      if (speaking) spokenMs += tickMs
      if (!speaking && loud >= 3) {
        speaking = true
        handlers.onStart()
      }
    } else {
      loud = 0
      if (!speaking) floor = floor * 0.95 + rms * 0.05
      if (speaking) {
        quiet += 1
        if (quiet * tickMs >= 900 && spokenMs >= 300) {
          speaking = false
          window.clearInterval(timer)
          handlers.onEnd()
        }
      }
    }
  }, tickMs)
  return { stop: () => window.clearInterval(timer) }
}

// ---------------------------------------------------------------- recording

export type Recording = { stop: () => Promise<Blob | null>; startedAt: number }

export function startRecording(mic: Mic): Recording | null {
  if (typeof MediaRecorder === "undefined") return null
  const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"].find((type) => MediaRecorder.isTypeSupported(type))
  const recorder = new MediaRecorder(mic.stream, mimeType ? { mimeType } : undefined)
  const chunks: Blob[] = []
  recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data) }
  recorder.start()
  const startedAt = Date.now()
  return {
    startedAt,
    stop: () => new Promise((resolve) => {
      if (recorder.state === "inactive") return resolve(chunks.length ? new Blob(chunks, { type: recorder.mimeType }) : null)
      recorder.onstop = () => resolve(chunks.length ? new Blob(chunks, { type: recorder.mimeType }) : null)
      recorder.stop()
    }),
  }
}

// ---------------------------------------------------------------- live recognition (Chrome)

type RecognitionResult = { isFinal: boolean; 0: { transcript: string } }
type RecognitionEvent = { resultIndex: number; results: ArrayLike<RecognitionResult> }
type SpeechRecognitionLike = {
  lang: string; continuous: boolean; interimResults: boolean
  onresult: ((event: RecognitionEvent) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start: () => void; stop: () => void; abort: () => void
}

export function recognitionSupported(): boolean {
  const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown }
  return Boolean(w.SpeechRecognition ?? w.webkitSpeechRecognition)
}

export type Recognition = { stop: () => Promise<string>; abort: () => void }

/** Live text while the driver speaks. `stop` resolves with the final text (waits up to 800 ms). */
export function startRecognition(onText: (text: string) => void, onFirstWords?: () => void): Recognition | null {
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike }
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition
  if (!Ctor) return null
  const recognition = new Ctor()
  recognition.lang = navigator.language || "en-GB"
  recognition.continuous = true
  recognition.interimResults = true
  let finals = ""
  let interim = ""
  let ended = false
  let heard = false
  let resolveEnd: (() => void) | null = null
  recognition.onresult = (event) => {
    interim = ""
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i]
      if (result.isFinal) finals += `${result[0].transcript} `
      else interim += result[0].transcript
    }
    if (!heard && (finals + interim).trim()) { heard = true; onFirstWords?.() }
    onText(`${finals}${interim}`.trim())
  }
  recognition.onerror = () => undefined
  recognition.onend = () => { ended = true; resolveEnd?.() }
  try { recognition.start() } catch { return null }
  return {
    stop: () => new Promise((resolve) => {
      const done = () => resolve(`${finals}${interim}`.trim())
      if (ended) return done()
      const timeout = window.setTimeout(done, 800)
      resolveEnd = () => { window.clearTimeout(timeout); done() }
      try { recognition.stop() } catch { done() }
    }),
    abort: () => { try { recognition.abort() } catch { /* already stopped */ } },
  }
}

// ---------------------------------------------------------------- playback

type Item = { text: string; audioUrl: string | null; element: HTMLAudioElement | null }

/** Plays sentences strictly in order. Server audio first; speechSynthesis if it fails. */
export class SentencePlayer {
  private queue: Item[] = []
  private playing = false
  private current: HTMLAudioElement | null = null
  private stopped = false

  constructor(private handlers: { onStart: () => void; onIdle: () => void }) {}

  enqueue(text: string, audioUrl: string | null): void {
    this.stopped = false
    const element = audioUrl ? new Audio(audioUrl) : null
    if (element) element.preload = "auto"
    this.queue.push({ text, audioUrl, element })
    if (!this.playing) void this.next()
  }

  get busy(): boolean {
    return this.playing || this.queue.length > 0
  }

  stop(): void {
    this.stopped = true
    this.queue = []
    this.current?.pause()
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel()
    this.playing = false
  }

  private async next(): Promise<void> {
    const item = this.queue.shift()
    if (!item || this.stopped) {
      this.playing = false
      if (!this.stopped) this.handlers.onIdle()
      return
    }
    if (!this.playing) this.handlers.onStart()
    this.playing = true
    const ok = item.element ? await this.playElement(item.element) : false
    if (!ok && !this.stopped) await speakInBrowser(item.text)
    void this.next()
  }

  private playElement(element: HTMLAudioElement): Promise<boolean> {
    this.current = element
    return new Promise((resolve) => {
      element.onended = () => resolve(true)
      element.onerror = () => resolve(false)
      element.play().catch(() => resolve(false))
    })
  }
}

export function speakInBrowser(text: string): Promise<void> {
  return new Promise((resolve) => {
    if (typeof speechSynthesis === "undefined") return resolve()
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = "en-GB"
    utterance.rate = 1.05
    utterance.onend = () => resolve()
    utterance.onerror = () => resolve()
    speechSynthesis.speak(utterance)
  })
}

// ---------------------------------------------------------------- server-sent events over fetch

export async function readEvents(response: Response, onEvent: (event: string, data: unknown) => void): Promise<void> {
  if (!response.body) return
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let split = buffer.indexOf("\n\n")
    while (split !== -1) {
      const block = buffer.slice(0, split)
      buffer = buffer.slice(split + 2)
      const event = block.match(/^event: (.*)$/m)?.[1]
      const data = block.match(/^data: (.*)$/m)?.[1]
      if (event && data) {
        try { onEvent(event, JSON.parse(data)) } catch { /* ignore a broken event */ }
      }
      split = buffer.indexOf("\n\n")
    }
  }
}
