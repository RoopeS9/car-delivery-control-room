"use client"

import { useRouter } from "next/navigation"
import { useMemo, useState } from "react"
import type { RecordView } from "@/lib/present/types"
import { label } from "@/lib/present/labels"
import { Composer, postJson, type Draft } from "./composer"

type Party = { type: "customer" | "driver" | "site_contact"; id: string; name: string; role: string }

const CATEGORIES = ["pickup_and_release", "schedule_and_eta", "delivery_and_receiver", "documents_and_proof", "driver_travel", "driver_availability", "ferry_and_route", "vehicle_condition", "vehicle_custody", "order_information", "order_change", "costs_and_payments"]
const CHANNELS: Record<Party["type"], string[]> = { customer: ["email", "support_chat", "whatsapp"], driver: ["driver_chat", "whatsapp", "support_chat"], site_contact: ["email", "site_chat", "support_chat"] }

/** Everyone on the order the desk can write to: the customer, each booked driver, each managed site. */
export function partiesOf(view: RecordView): Party[] {
  const out: Party[] = [{ type: "customer", id: view.header.customer.id, name: view.header.customer.name, role: "customer" }]
  const seen = new Set<string>()
  for (const group of view.journey.groups) {
    for (const leg of group.legs) {
      const driver = leg.assignment?.driver
      if (driver?.id && !seen.has(driver.id)) { seen.add(driver.id); out.push({ type: "driver", id: driver.id, name: driver.name, role: "driver" }) }
    }
    for (const step of group.steps) {
      if (step.site && !seen.has(step.site.id)) { seen.add(step.site.id); out.push({ type: "site_contact", id: step.site.id, name: `${step.site.name} desk`, role: `${step.roleLabel.toLowerCase()} site` }) }
    }
  }
  return out
}

/** Opens a conversation with one party on the order: who, over what, about what, then the composer with drafts. */
export function NewConversation({ view, orderId, onOpened, onCancel }: { view: RecordView; orderId: string; onOpened: () => void; onCancel: () => void }) {
  const router = useRouter()
  const parties = useMemo(() => partiesOf(view), [view])
  const [party, setParty] = useState<Party>(parties[0] ?? { type: "customer", id: view.header.customer.id, name: view.header.customer.name, role: "customer" })
  const [channel, setChannel] = useState(CHANNELS[party.type][0])
  const [category, setCategory] = useState("order_information")
  const pick = (id: string) => { const next = parties.find((item) => item.id === id); if (next) { setParty(next); setChannel(CHANNELS[next.type][0]) } }
  const base = { category, channel, counterpartyType: party.type, counterpartyId: party.id, counterpartyName: party.name }
  return <div className="new-conv">
    <div className="new-conv-fields">
      <label>With<select value={party.id} onChange={(event) => pick(event.target.value)}>{parties.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.role}</option>)}</select></label>
      <label>Over<select value={channel} onChange={(event) => setChannel(event.target.value)}>{CHANNELS[party.type].map((item) => <option key={item} value={item}>{label(item)}</option>)}</select></label>
      <label>About<select value={category} onChange={(event) => setCategory(event.target.value)}>{CATEGORIES.map((item) => <option key={item} value={item}>{label(item)}</option>)}</select></label>
      <button type="button" className="btn quiet" onClick={onCancel}>Cancel</button>
    </div>
    <Composer to={party.name} channelLabel={label(channel)} autoFocus openingPrompt
      suggest={(intent) => postJson<Draft>(`/api/orders/${encodeURIComponent(orderId)}/conversations`, { ...base, draft: true, intent })}
      send={(body, internal, language) => postJson<{ conversation: { id: string } }>(`/api/orders/${encodeURIComponent(orderId)}/conversations`, { ...base, body, language, internal }).then((opened) => { onOpened(); router.push(`/inbox#${opened.conversation.id}`) })}
      />
  </div>
}
