"use client"

import { useState } from "react"
import { slotLabel } from "@/lib/present/call-types"
import type { DealerCollection, DealerView } from "@/lib/present/dealer"
import { CallScreen, type CallTarget, type LiveResult } from "../line/call-screen"
import { ClaimsList, Scorecard } from "../calls/review-parts"

/** The desk's view of its booked collections, and the phone where Mira from Bahn calls about one of them. */
export function DealerDesk({ site, collections, asks, callable }: {
  site: NonNullable<DealerView["site"]>; collections: DealerCollection[]; asks: Record<string, string[] | null>
  /** From the call service's actions: may the agent call this desk about this order, and if not, why. */
  callable: Record<string, { may: boolean; reason: string | null }>
}) {
  const [call, setCall] = useState<{ target: CallTarget; reference: string } | null>(null)
  const [result, setResult] = useState<LiveResult | null>(null)
  const ringing = (item: DealerCollection) => { setResult(null); setCall({
    reference: item.reference,
    target: {
      orderRef: item.reference, purpose: "PICKUP_READINESS", calleeName: "Mira from Bahn", purposeLabel: "Pickup readiness",
      youAre: `You are the desk at ${site.name}. Mira from Bahn is calling about the ${item.vehicle}${item.slot ? ` collected ${item.slot}` : ""}. Answer as the desk would.`,
    },
  }) }
  const asked = call ? asks[call.reference] ?? null : null
  return <>
    <section className="dealer-desk" aria-label={`${site.name} desk`} data-keep-scroll="desk">
      <header className="dealer-head">
        <h2>{site.name}</h2>
        <p>{[site.address, site.hours].filter(Boolean).join(" · ")}</p>
        {site.access && <p className="dealer-access">{site.access}</p>}
      </header>
      <h3>Booked collections <span>{collections.length}</span></h3>
      <ul className="dealer-list">{collections.map((item) => <li key={item.orderId} className={`dealer-card${call?.reference === item.reference ? " active" : ""}`}>
        <div className="dc-main">
          <b>{item.vehicle}</b> <span className="q-ref">{item.reference}</span>
          <p>{item.slot ? `Collection ${item.slot}` : "No collection slot yet"} · {item.driver ? `driver ${item.driver}` : "no driver booked"} · {item.stage}</p>
          {item.plate && <p className="dc-quiet">Plate <span className="mono">{item.plate}</span></p>}
        </div>
        {!callable[item.reference]?.may
          ? <p className="dc-reason"><b>{/paying customer/i.test(callable[item.reference]?.reason ?? "") ? "Customer site · a person calls" : "A person calls"}</b>{callable[item.reference]?.reason ? <><br />{callable[item.reference].reason}</> : null}</p>
          : <button type="button" className="btn primary" disabled={!!call} onClick={() => ringing(item)}>Simulate outbound call</button>}
      </li>)}</ul>
    </section>
    <section className="dealer-phone" aria-label="The desk phone">
      <div className="dealer-phone-frame">
        {call ? <CallScreen key={call.reference} target={call.target} onClose={() => { setCall(null); setResult(null) }} onResult={setResult} />
          : <div className="dealer-idle"><b>The desk phone</b><p>Pick a collection and press Simulate outbound call: Mira from Bahn calls you about it, with a brief the model composed from the order. You answer as the desk.</p></div>}
      </div>
      {call && result && <div className="dealer-result">
        {result.review && <Scorecard review={result.review} />}
        <div className="call-side"><ClaimsList call={result.call} /></div>
      </div>}
      {call && !result && asked && <div className="dealer-asks">
        <h3>What Mira sets out to find</h3>
        <ul>{asked.map((slot) => <li key={slot}>{slotLabel(slot)}</li>)}</ul>
        <p className="dc-quiet">After the call, the call service reads the transcript: each answer becomes a claim citing its turn, with a review of the call. The call lands on the order&apos;s panel on the map.</p>
      </div>}
    </section>
  </>
}
