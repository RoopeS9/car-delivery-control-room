// One order's history as the agent reads it: the dataset's messages and
// operational events merged with our cr_events, oldest first, each line with
// who said or did it, on which channel, and its source.

import { and, asc, eq, inArray } from "drizzle-orm"
import { crDb } from "@/lib/cr/db"
import { listEvents, type EventRow } from "@/lib/cr/queries"
import type { SourceRef } from "@/lib/cr/types"
import { customers, drivers, messages, operationalEvents, relatedRecords } from "@/lib/schema"
import { AGENT_ID, AGENT_NAME } from "./config"
import { utcTime } from "./format"

export type TimelineLine = { at: string; who: string; channel: string; text: string; source: SourceRef }

type Names = { drivers: Map<string, string>; customers: Map<string, string>; operators: Map<string, string>; agents: Map<string, string> }

let namesCache: Names | null = null

export async function names(): Promise<Names> {
  if (namesCache) return namesCache
  const db = crDb()
  const [driverRows, customerRows, shared] = await Promise.all([
    db.select({ id: drivers.id, name: drivers.displayName }).from(drivers),
    db.select({ id: customers.id, name: customers.name }).from(customers),
    db.select().from(relatedRecords).where(inArray(relatedRecords.collection, ["operators", "agents"])),
  ])
  namesCache = {
    drivers: new Map(driverRows.map((row) => [row.id, row.name])),
    customers: new Map(customerRows.map((row) => [row.id, row.name])),
    operators: new Map(shared.filter((row) => row.collection === "operators").map((row) => [row.id, String(row.details.title ?? row.id)])),
    agents: new Map(shared.filter((row) => row.collection === "agents").map((row) => [row.id, String(row.details.title ?? row.id)])),
  }
  return namesCache
}

/** A person-readable name for an actor in either the dataset or our events. */
export function actorName(n: Names, type: string, id: string | null, snapshot?: string | null): string {
  switch (type) {
    case "driver": return `${(id && n.drivers.get(id)) || "Driver"} (driver)`
    case "operator": return (id && n.operators.get(id)) || "Operations"
    case "customer": return `${(id && n.customers.get(id)) || "Customer"} (customer)`
    case "agent": return id === AGENT_ID ? AGENT_NAME : (id && n.agents.get(id)) || "Agent"
    case "site":
    case "site_contact": return `${snapshot || "Site contact"} (site)`
    case "handoff_contact": return `${snapshot || "Handover contact"} (handover contact)`
    case "obd": return "OBD dongle"
    case "phone": return "Driver's phone"
    default: return "System"
  }
}

function crEventLine(n: Names, event: EventRow): TimelineLine {
  const who = actorName(n, event.actorType, event.actorId, typeof event.data.name === "string" ? event.data.name : null)
  const to = event.recipientType ? ` → ${actorName(n, event.recipientType, event.recipientId)}` : ""
  return {
    at: event.at.toISOString(),
    who: `${who}${to}`,
    channel: event.channel.replace(/_/g, " "),
    text: event.kind === "photo" ? `[photo, event ${event.id}] ${event.body}` : event.body,
    source: { kind: "cr_events", id: event.id, label: `${who}, ${event.channel.replace(/_/g, " ")}, ${utcTime(event.at)}`, at: event.at.toISOString() },
  }
}

/**
 * The merged history of an order. `includeDataset` adds the packet's messages
 * and operational events (operators only); our own events are always in.
 */
export async function orderTimeline(orderId: string, options: { since?: Date; includeDataset?: boolean; limit?: number } = {}): Promise<TimelineLine[]> {
  const n = await names()
  const lines: TimelineLine[] = (await listEvents({ orderId, since: options.since })).map((event) => crEventLine(n, event))
  if (options.includeDataset !== false) {
    const db = crDb()
    const [messageRows, eventRows] = await Promise.all([
      db.select().from(messages).where(eq(messages.orderId, orderId)).orderBy(asc(messages.authoredAt)),
      db.select().from(operationalEvents).where(and(eq(operationalEvents.orderId, orderId))).orderBy(asc(operationalEvents.recordedAt)),
    ])
    for (const row of messageRows) {
      const d = row.details
      const who = actorName(n, row.authorType, String(d.author_id ?? ""), typeof d.author_name_snapshot === "string" ? d.author_name_snapshot : null)
      const to = d.recipient_type ? ` → ${actorName(n, String(d.recipient_type), String(d.recipient_id ?? ""))}` : ""
      lines.push({
        at: row.authoredAt.toISOString(), who: `${who}${to}`, channel: String(d.channel ?? "message").replace(/_/g, " "), text: row.body,
        source: { kind: "messages", id: row.id, label: `${who}, ${String(d.channel ?? "").replace(/_/g, " ")}, ${utcTime(row.authoredAt)}`, at: row.authoredAt.toISOString() },
      })
    }
    for (const row of eventRows) {
      const d = row.details
      const who = actorName(n, String(d.actor_type ?? "system"), typeof d.actor_id === "string" ? d.actor_id : null)
      const changes = d.changes && typeof d.changes === "object" ? Object.entries(d.changes as Record<string, unknown>)
        .filter(([, value]) => value !== null && typeof value !== "object").map(([key, value]) => `${key.replace(/_/g, " ")}: ${value}`).join(", ") : ""
      lines.push({
        at: row.recordedAt.toISOString(), who, channel: "record",
        text: `${row.command.replace(/[._]/g, " ")}${changes ? ` (${changes})` : ""}`,
        source: { kind: "operational_events", id: row.id, label: `Event log, ${row.command}, ${utcTime(row.recordedAt)}`, at: row.recordedAt.toISOString() },
      })
    }
  }
  lines.sort((a, b) => a.at.localeCompare(b.at))
  const filtered = options.since ? lines.filter((line) => line.at >= options.since!.toISOString()) : lines
  return options.limit ? filtered.slice(-options.limit) : filtered
}

/** Compact text for a prompt: one line per entry. */
export function renderLines(lines: TimelineLine[]): string {
  return lines.map((line) => `[${utcTime(line.at)}] ${line.who} (${line.channel}): ${line.text}`).join("\n")
}
