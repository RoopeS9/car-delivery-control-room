"use client"

import type { ReactNode } from "react"
import { humanize } from "@/lib/present/labels"
import type { RecordView } from "@/lib/present/types"
import { Icon } from "../icons"
import { OrderLinks } from "../ui"
import { CostsPanel, DriversPanel, FactsPanel, MarketPanel, TravelPanel, WorkPanel } from "./aside"
import { EvidenceDetails, HistoryDays, ProposalCards, RouteDetails } from "./sections"

type Entry = { id: string; icon: string; title: string; sub: string; count: number | null; body: ReactNode }

function plural(count: number, noun: string, nouns = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : nouns}`
}

/** Every linked record, folded away until someone opens it. */
export function RecordsPanel({ view, orderId }: { view: RecordView; orderId: string }) {
  const steps = view.journey.groups.reduce((sum, group) => sum + group.steps.length, 0)
  const openAlerts = view.alerts.filter((alert) => alert.status === "OPEN").length
  const openWork = view.workItems.filter((item) => item.status !== "DONE").length
  const entries: Entry[] = [
    { id: "facts", icon: "note", title: "Order facts", sub: "plate, VIN, model year, customer reference, status, created", count: null, body: <FactsPanel view={view} /> },
    { id: "route", icon: "pin", title: "Route details", sub: `${plural(steps, "stop")} with slots, contacts, access state, site procedures and proofs`, count: null, body: <RouteDetails view={view} /> },
    { id: "work", icon: "alert", title: "Alerts, work items and incidents", sub: [openAlerts ? plural(openAlerts, "open alert") : null, openWork ? plural(openWork, "open work item") : null, view.incidents.length ? plural(view.incidents.length, "incident") : null].filter(Boolean).join(" · ") || "nothing open", count: view.alerts.length + view.workItems.length + view.incidents.length, body: <WorkPanel view={view} /> },
    { id: "drivers", icon: "driver", title: "Drivers", sub: view.assignments.length ? view.assignments.map((assignment) => `${assignment.driver.name} (${assignment.statusLabel.toLowerCase()})`).join(", ") : "no assignment", count: view.assignments.length, body: <DriversPanel view={view} /> },
    { id: "market", icon: "offer", title: "Driver market", sub: view.offers.length ? view.offers.map((offer) => `${offer.statusLabel.toLowerCase()}${offer.fee ? ` ${offer.fee}` : ""}`).join(", ") : "no offer published", count: view.offers.length, body: <MarketPanel view={view} /> },
    { id: "travel", icon: "ferry", title: "Travel", sub: view.reservations.length || view.options.length ? [view.reservations.length ? plural(view.reservations.length, "booking") : null, view.options.length ? plural(view.options.length, "quote") : null].filter(Boolean).join(" · ") : "no booking or quote", count: view.reservations.length + view.options.length, body: <TravelPanel view={view} /> },
    { id: "costs", icon: "file", title: "Costs", sub: view.expenses.length ? ["APPROVED", "SUBMITTED", "REJECTED", "SUPERSEDED"].map((status) => [status, view.expenses.filter((expense) => expense.status === status).length] as const).filter(([, count]) => count).map(([status, count]) => `${count} ${status.toLowerCase()}`).join(" · ") : "no cost claim", count: view.expenses.length, body: <CostsPanel view={view} /> },
    { id: "evidence-details", icon: "photo", title: "Proofs, documents and custody", sub: `${plural(view.proofs.length, "proof")} · ${plural(view.documents.length, "document")}${view.custody.assets.length ? ` · ${plural(view.custody.assets.length, "tracked asset")}` : ""}${view.siteVisits.length ? ` · ${plural(view.siteVisits.length, "site visit")}` : ""}`, count: view.proofs.length + view.documents.length, body: <EvidenceDetails view={view} /> },
    { id: "proposals", icon: "proposal", title: "Prior agent work and room activity", sub: view.proposals.length || view.notifications.length ? `${plural(view.proposals.length, "proposal")} with rationale, evidence and execution · ${plural(view.notifications.length, "room post")}` : "nothing recorded", count: view.proposals.length + view.notifications.length, body: <ProposalCards view={view} /> },
    { id: "events", icon: "waiting", title: "All events", sub: "the recorded history by day, with what each event changed", count: view.historyTotal, body: <HistoryDays view={view} /> },
  ]
  return <section className="records" id="records">
    <div className="sec-head"><h2>Everything on this order</h2><span className="note">Folded away. Open what you need; the <a href={`/api/orders/${orderId}`} target="_blank" rel="noopener noreferrer">order API</a> has every field.</span></div>
    {entries.map((entry) => <details className="rec" key={entry.id} id={entry.id}>
      <summary>
        <Icon name={entry.icon} size={15} />
        <span><span className="rec-title">{entry.title}</span><span className="rec-sub">{entry.sub}</span></span>
        <span className="rec-count num">{entry.count != null && entry.count > 0 ? entry.count : ""}</span>
        <Icon name="chevron" size={13} className="chev" />
      </summary>
      <div className="rec-body">{entry.body}</div>
    </details>)}
    {(view.inboxHints.length > 0 || view.otherRecords.length > 0) && <p className="rec-note">
      {view.inboxHints.map((hint) => <span key={hint.id}>Support inbox: {hint.stateLabel.toLowerCase()}{hint.confirmed ? "" : " (candidate, not a confirmed link)"}{hint.candidates.length ? <> among <OrderLinks orders={hint.candidates} /></> : ""}. </span>)}
      {view.otherRecords.length > 0 && <>Also linked in the API: {view.otherRecords.map((record) => `${humanize(record.collection).toLowerCase()} (${record.count})`).join(", ")}.</>}
    </p>}
  </section>
}
