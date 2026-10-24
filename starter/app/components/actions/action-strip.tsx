"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import type { ActionStripView } from "@/lib/present/call-types"
import { Icon } from "../icons"
import { CallOverlay, type CallTarget } from "../line/call-screen"
import "./action-strip.css"

/** One row: where the car goes and when, and the calls the operator is there to make. */
export function ActionStrip({ orderId, compact = false }: { orderId: string; compact?: boolean }) {
  const [strip, setStrip] = useState<ActionStripView | null>(null)
  const [call, setCall] = useState<CallTarget | null>(null)
  useEffect(() => {
    let stopped = false
    fetch(`/api/actions/${encodeURIComponent(orderId)}`, { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<ActionStripView> : null)
      .then((value) => { if (!stopped) setStrip(value) })
      .catch(() => undefined)
    return () => { stopped = true }
  }, [orderId])
  if (!strip) return null
  return <div className={`action-strip${compact ? " compact" : ""}`} role="group" aria-label="Operator actions">
    {compact ? strip.when && <p className="as-route">{strip.when.charAt(0).toUpperCase() + strip.when.slice(1)}</p>
      : <p className="as-route"><b>{strip.from}</b><Icon name="arrow" size={13} /><b>{strip.to}</b>{strip.when && <span> · {strip.when}</span>}</p>}
    {strip.actions.length > 0 && <div className="as-actions">
      {strip.actions.map((action) => action.agentMay && action.cardUrl
        ? <button type="button" key={action.label} className="as-btn as-agent" title={`Mira, Bahn's assistant, calls ${action.who ?? "them"} on the VoiceChat line; you answer as them`}
          onClick={() => setCall({ orderRef: strip.reference, purpose: action.purpose ?? "CALL", cardUrl: action.cardUrl, calleeName: "Mira from Bahn", purposeLabel: action.label,
            youAre: `You answer as ${action.who ?? "the other party"}. Mira, Bahn's assistant, is calling you.` })}>
          <Icon name="phone" size={13} />{action.label}
        </button>
        : <Link key={action.label} className="as-btn as-human" href={action.href} title={action.reason ? `A person does this: ${action.reason}` : undefined}>
          {action.label}<span className="as-who" aria-hidden="true">· a person</span><span className="sr-only">{action.reason ? `, a person does this: ${action.reason}` : ""}</span>
        </Link>)}
    </div>}
    {call && <CallOverlay target={call} onClose={() => setCall(null)} />}
  </div>
}
