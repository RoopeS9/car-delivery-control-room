"use client"

import type { CallTranscriptView } from "@/lib/present/types"
import { When } from "../ui"
import styles from "./call-transcript.module.css"

export function CallTranscripts({ calls }: { calls: CallTranscriptView[] }) {
  if (!calls.length) return null
  return <section className="sec" aria-label="Driver calls">
    <div className="sec-head"><h2>Driver calls</h2><span className="note">The recording transcript is the source. Agent conclusions appear in the case above.</span></div>
    {calls.map((call) => <article key={call.id} id={`call-${call.id}`} className={styles.call}>
      <header className={styles.header}>
        <h3>{call.driverName}</h3>
        {call.urgencyLabel && <span className={`chip tone-${call.tone}`}><span className="chip-dot" />{call.urgencyLabel}</span>}
        <span className={styles.state}>{call.endedAt ? "Call ended" : "Call in progress"}</span>
      </header>
      <p className={styles.meta}>{call.directionLabel} · <When at={call.startedAt} withZone={false} />{call.endedAt && <> to <When at={call.endedAt} withZone={false} /></>}</p>
      {call.urgencyQuote && <p className={styles.quote}><b>Urgency came from:</b> {call.urgencyTurnId ? <a href={`#call-turn-${call.urgencyTurnId}`}>“{call.urgencyQuote}”</a> : <>“{call.urgencyQuote}”</>}</p>}
      {call.endedAt && <p className={styles.meta}>{call.readbackConfirmed ? "Driver confirmed the read-back." : "Read-back was not confirmed; check the driver's exact words."}</p>}
      <ol className={styles.turns}>{call.turns.map((turn) => <li id={`call-turn-${turn.id}`} key={turn.id} className={styles.turn}>
        <div className={styles.turnHead}><b>{turn.speakerName}</b><When at={turn.at} withZone={false} />{turn.interrupted && <span>Interrupted</span>}</div>
        <p className={styles.words}>{turn.text}</p>
        <span className={styles.meta}>{turn.transcriptLabel}</span>
        {turn.liveText && <details className={styles.live}><summary>Live speech recognition differed</summary><p>{turn.liveText}</p></details>}
        {turn.audioUrl && <audio className={styles.audio} controls preload="none" src={turn.audioUrl} aria-label={`Play ${turn.speakerName}'s words`} />}
      </li>)}</ol>
      {!call.turns.length && <p className="empty">The call has started. Its transcript will appear as people speak.</p>}
    </article>)}
  </section>
}
