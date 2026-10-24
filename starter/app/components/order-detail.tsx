"use client"

import type { RecordView } from "@/lib/present/types"
import { RecordHero, Tiles } from "./record/header"
import { RecordsPanel } from "./record/records"
import { ActivitySection, AttentionPanel, ConversationsSection, DecisionsSection, EvidenceSection, RouteStrip } from "./record/sections"

export type Detail = { order: { id: string; reference: string }; view: RecordView }

export function OrderPane({ detail }: { detail: Detail }) {
  const { view } = detail
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
