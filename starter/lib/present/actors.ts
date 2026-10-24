import { humanize, label } from "./labels"
import type { Actor, Row } from "./types"

export type DirectoryInput = {
  drivers: { id: string; displayName: string; homeCity?: string | null; homeCountry?: string | null }[]
  operators: Row[]
  agents: Row[]
  customers: { id: string; name: string }[]
  sites: { id: string; name: string }[]
  endpointDetails: Row[]
  /** author_id to author_name_snapshot, taken from messages. */
  snapshots?: Map<string, string>
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

/** Resolves the dataset's actor identifiers to names and roles. Unknown identifiers
 * are humanised, never hidden, so a reader can still follow the source. */
export class Directory {
  private drivers = new Map<string, DirectoryInput["drivers"][number]>()
  private operators = new Map<string, string>()
  private agents = new Map<string, string>()
  private customers = new Map<string, string>()
  private sites = new Map<string, string>()
  private contacts = new Map<string, { name: string | null; role: string | null }>()
  private snapshots: Map<string, string>

  constructor(input: DirectoryInput) {
    for (const driver of input.drivers) this.drivers.set(driver.id, driver)
    for (const row of input.operators) if (text(row.id)) this.operators.set(String(row.id), text(row.title) ?? humanize(String(row.id)))
    for (const row of input.agents) if (text(row.id)) this.agents.set(String(row.id), text(row.title) ?? humanize(String(row.id)))
    for (const customer of input.customers) this.customers.set(customer.id, customer.name)
    for (const site of input.sites) this.sites.set(site.id, site.name)
    for (const row of input.endpointDetails) {
      if (text(row.id)) this.contacts.set(String(row.id), { name: text(row.contact_name), role: text(row.contact_role) })
    }
    this.snapshots = input.snapshots ?? new Map()
  }

  /** Title of an operator role such as "Support desk"; falls back to a readable form of the id. */
  title(id: unknown): string | null {
    const key = text(id)
    if (!key) return null
    return this.operators.get(key) ?? this.agents.get(key) ?? humanize(key)
  }

  driverName(id: unknown): string | null {
    const key = text(id)
    return key ? this.drivers.get(key)?.displayName ?? null : null
  }

  driverHome(id: unknown): string | null {
    const key = text(id)
    const driver = key ? this.drivers.get(key) : undefined
    if (!driver?.homeCity) return null
    return driver.homeCountry ? `${driver.homeCity}, ${driver.homeCountry}` : driver.homeCity
  }

  siteName(id: unknown): string | null {
    const key = text(id)
    return key ? this.sites.get(key) ?? null : null
  }

  resolve(id: unknown, typeHint?: unknown): Actor {
    const key = text(id)
    const hint = text(typeHint)?.toLowerCase() ?? null
    if (!key) {
      if (hint === "system" || hint === null) return { id: null, kind: "system", name: "System", role: null }
      return { id: null, kind: "unknown", name: humanize(hint), role: null }
    }
    if (hint === "driver" || this.drivers.has(key)) {
      return { id: key, kind: "driver", name: this.drivers.get(key)?.displayName ?? humanize(key), role: "driver" }
    }
    if (hint === "operator" || this.operators.has(key)) {
      return { id: key, kind: "operator", name: this.operators.get(key) ?? humanize(key), role: "operator" }
    }
    if (hint === "agent" || this.agents.has(key)) {
      return { id: key, kind: "agent", name: this.agents.get(key) ?? humanize(key), role: "agent" }
    }
    if (hint === "customer" || this.customers.has(key)) {
      return { id: key, kind: "customer", name: this.customers.get(key) ?? humanize(key), role: "customer" }
    }
    if (hint === "site_contact" || this.sites.has(key)) {
      const site = this.sites.get(key)
      return { id: key, kind: "site_contact", name: site ? `${site} desk` : humanize(key), role: "site contact" }
    }
    if (hint === "handoff_contact" || this.contacts.has(key)) {
      const contact = this.contacts.get(key)
      const name = this.snapshots.get(key) ?? contact?.name ?? "Handoff contact"
      return { id: key, kind: "handoff_contact", name, role: contact?.role ?? "handoff contact" }
    }
    if (hint === "system") return { id: key, kind: "system", name: humanize(key), role: null }
    return { id: key, kind: "unknown", name: humanize(key), role: hint ? label(hint).toLowerCase() : null }
  }
}

export function snapshotNames(messages: { details: Row }[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const message of messages) {
    const id = text(message.details.author_id)
    const name = text(message.details.author_name_snapshot)
    if (id && name && !names.has(id)) names.set(id, name)
  }
  return names
}
