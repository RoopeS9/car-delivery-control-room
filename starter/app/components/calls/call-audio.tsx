"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { CallRecord } from "@/lib/present/call-types"
import { Icon } from "../icons"

// Playback of a simulated call's turns, rendered on the call service with ElevenLabs. One audio element per view;
// "Play the call" walks the turns back to back, a turn's own button plays just that turn.

export function useCallPlayer(call: CallRecord) {
  const audio = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState<number | null>(null)
  const [all, setAll] = useState(false)
  const spoken = call.turns.filter((turn) => turn.audioKey)
  const stop = useCallback(() => {
    const element = audio.current
    if (element) { element.onended = null; element.pause(); element.removeAttribute("src") }
    setPlaying(null); setAll(false)
  }, [])
  const play = useCallback((seq: number, onDone?: () => void) => {
    const element = audio.current ?? (audio.current = new Audio())
    element.onended = null
    element.pause()
    element.src = `/api/calls/${encodeURIComponent(call.id)}/audio/${seq}`
    element.onended = () => { setPlaying(null); onDone?.() }
    setPlaying(seq)
    void element.play().catch(() => { setPlaying(null); setAll(false) })
  }, [call.id])
  const playAll = useCallback(() => {
    const seqs = spoken.map((turn) => turn.seq)
    if (!seqs.length) return
    setAll(true)
    const next = (index: number) => { if (index >= seqs.length) { setAll(false); return } play(seqs[index], () => next(index + 1)) }
    next(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [play, call.id])
  useEffect(() => () => { const element = audio.current; if (element) { element.pause(); element.removeAttribute("src") } }, [])
  // A different call: stop whatever was playing.
  useEffect(() => { stop() }, [call.id, stop])
  return { spoken: spoken.length, playing, all, play, playAll, stop }
}

export function PlayCallButton({ player }: { player: ReturnType<typeof useCallPlayer> }) {
  if (!player.spoken) return null
  return player.all
    ? <button type="button" className="btn play-call" onClick={player.stop}><Icon name="stop" size={12} />Stop</button>
    : <button type="button" className="btn play-call" onClick={player.playAll} title="Hear the call, turn by turn, in the voices the line uses"><Icon name="play" size={12} />Play the call</button>
}

export function PlayTurnButton({ player, seq, has }: { player: ReturnType<typeof useCallPlayer>; seq: number; has: boolean }) {
  if (!has) return null
  const on = player.playing === seq
  return <button type="button" className={`play-turn${on ? " on" : ""}`} aria-label={on ? "Stop" : "Play this turn"} onClick={() => on ? player.stop() : player.play(seq)}><Icon name={on ? "stop" : "play"} size={11} /></button>
}
