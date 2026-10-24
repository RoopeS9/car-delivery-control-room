"use client"

import Link from "next/link"
import type { RecordView } from "@/lib/present/types"
import { CasePanel } from "./case/case-panel"
import { MakeMark } from "./queue"
import { RecordHero, Tiles } from "./record/header"
import { RecordsPanel } from "./record/records"
import { ActivitySection, AttentionPanel, ConversationsSection, DecisionsSection, EvidenceSection, RouteStrip } from "./record/sections"

export type Detail = { order: { id: string; reference: string }; view: RecordView }

/** The car and order in one line, above a case. */
function CaseOrderLine({ view }: { view: RecordView }) {
  const { header } = view
  return <div className="case-order">
    <MakeMark make={header.vehicle?.make ?? null} size={26} />
    <div>
      <p className="case-order-car"><b>{header.vehicle?.title ?? "Vehicle not linked"}</b><span className="mono">{header.reference}</span>{header.vehicle?.plate && <span className="mono">{header.vehicle.plate}</span>}</p>
      <p className="case-order-sub">{header.from.city} → {header.to.city} · <Link className="name-link" href={`/customers/${header.customer.id}`}>{header.customer.name}</Link> · {header.laneLabel}</p>
    </div>
  </div>
}

export function OrderPane({ detail, onChange }: { detail: Detail; onChange: () => void }) {
  const { view } = detail
  if (view.cases.length || view.calls.length) return <>
    <CaseOrderLine view={view} />
    <CasePanel view={view} onChange={onChange} />
    <div className="order-divider"><h2>The order</h2><p>Everything below is from the order record.</p></div>
    <RecordHero view={view} compact />
    <AttentionPanel view={view} />
    <Tiles tiles={view.tiles} />
    <RouteStrip view={view} />
    <ConversationsSection view={view} />
    <EvidenceSection view={view} />
    <DecisionsSection view={view} />
    <RecordsPanel view={view} orderId={detail.order.id} />
  </>
  return <>
    <RecordHero view={view} />
    <AttentionPanel view={view} />
    <Tiles tiles={view.tiles} />
    <RouteStrip view={view} />
    <ConversationsSection view={view} />
    <EvidenceSection view={view} />
    <DecisionsSection view={view} />
    <ActivitySection view={view} />
    <RecordsPanel view={view} orderId={detail.order.id} />
  </>
}
