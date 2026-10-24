"use client"

import Link from "next/link"
import { useCallback, useEffect, useRef, useState } from "react"
import { Icon } from "../components/icons"
import { fetchFeed, sendMessage } from "../driver/channel"
import type { SiteContact, SiteThreadMessage } from "./data"
import styles from "./site.module.css"

export function SiteChat({ contact, initialThread, serverNow }: { contact: SiteContact; initialThread: SiteThreadMessage[]; serverNow: string }) {
  const [thread, setThread] = useState(initialThread)
  const [draft, setDraft] = useState("")
  const [streaming, setStreaming] = useState<string | null>(null)
  const [held, setHeld] = useState(false)
  const [error, setError] = useState("")
  const since = useRef(serverNow)
  const clockOffset = useRef(Date.parse(serverNow) - Date.now())
  const bottom = useRef<HTMLDivElement>(null)
  const simIso = () => new Date(Date.now() + clockOffset.current).toISOString()

  const add = useCallback((messages: SiteThreadMessage[]) => {
    setThread((current) => {
      const known = new Set(current.map((message) => message.id))
      const fresh = messages.filter((message) => !known.has(message.id))
      return fresh.length ? [...current, ...fresh].sort((a, b) => a.at.localeCompare(b.at)) : current
    })
  }, [])

  // Replies that arrive later: an approved answer, or a question Bahn asks this desk.
  useEffect(() => {
    let stopped = false
    const poll = async () => {
      try {
        const feed = await fetchFeed(`/api/channels/site/${contact.id}/feed`, since.current)
        since.current = feed.now
        if (stopped) return
        const mine = feed.messages.filter((message) => message.orderId === contact.orderId)
        if (mine.length) setHeld(false)
        add(mine.map((message) => ({ id: message.id, at: message.at, mine: false, fromName: message.from === "agent" ? "Bahn assistant" : "Bahn operations", text: message.text, origin: null })))
      } catch { /* try again on the next poll */ }
    }
    const timer = setInterval(poll, 2000)
    return () => { stopped = true; clearInterval(timer) }
  }, [add, contact.id, contact.orderId])

  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }) }, [thread, streaming, held])

  async function send(event: React.FormEvent) {
    event.preventDefault()
    const text = draft.trim()
    if (!text || streaming !== null) return
    setError("")
    setHeld(false)
    add([{ id: `local-${Date.now()}`, at: simIso(), mine: true, fromName: "You", text, origin: null }])
    setDraft("")
    setStreaming("")
    try {
      let reply = ""
      const done = await sendMessage("/api/channels/site/messages",
        { orderRef: contact.reference, siteContactId: contact.id, text, mode: "chat" },
        (piece) => { reply += piece; setStreaming(reply) })
      // No answer streamed back: it waits for a person (customer's own place) or the agent handed over.
      if (done.heldForApproval || !reply.trim()) setHeld(true)
      else if (done.replyEventId) {
        add([{ id: done.replyEventId, at: simIso(), mine: false, fromName: "Bahn assistant", text: reply.trim(), origin: null }])
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The message could not be sent.")
    } finally {
      setStreaming(null)
    }
  }

  return <div className={styles.chat}>
    <header className={styles.chatHead}>
      <Link href="/site" className={styles.back}><Icon name="arrow" size={14} style={{ transform: "rotate(180deg)" }} /> All desks</Link>
      <h1>{contact.placeName}</h1>
      <p>{contact.contactName ? `Signed in as ${contact.contactName}, ${contact.contactRole ?? "contact"}` : "Signed in as the desk"} · about order <span className="mono">{contact.reference}</span>, {contact.vehicle}</p>
    </header>

    <section className={styles.thread} aria-label="Messages with Bahn" aria-live="polite">
      {thread.length === 0 && streaming === null && <p className={styles.empty}>Write to Bahn about this order. You get an answer straight away when we can give one.</p>}
      {thread.map((message, index) => <div key={message.id}>
        {index === 0 && message.origin === "dataset" && <p className={styles.divider}>Earlier</p>}
        {message.origin === null && index > 0 && thread[index - 1].origin === "dataset" && <p className={styles.divider}>Today</p>}
        <div className={`${styles.message} ${message.mine ? styles.mine : styles.theirs}`}>
          <span className={styles.who}>{message.fromName} · {message.at.slice(11, 16)} UTC</span>
          <p>{message.text}</p>
        </div>
      </div>)}
      {streaming !== null && <div className={`${styles.message} ${styles.theirs}`}>
        <span className={styles.who}>Bahn assistant</span>
        <p>{streaming || "…"}</p>
      </div>}
      {held && <p className={styles.held}>Bahn has your message. Operations will reply here.</p>}
      <div ref={bottom} />
    </section>

    {error && <p className={styles.error} role="alert">{error}</p>}
    <form className={styles.composer} onSubmit={(event) => void send(event)}>
      <label className={styles.field}>
        <span className="sr-only">Message to Bahn</span>
        <textarea rows={2} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={`Message Bahn about ${contact.reference}`}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} />
      </label>
      <button type="submit" disabled={streaming !== null || !draft.trim()}>Send</button>
    </form>
  </div>
}
