// A driver, customer or site, read through the orders it touches. The page
// reuses the board card so the same facts and attention signals appear here.

import { eq } from "drizzle-orm"
import { db } from "@/lib/db"
import { customers, drivers, sites } from "@/lib/schema"
import { buildBoardCard } from "./board"
import { type Bundle, bool, num, rows, str, strings } from "./bundle"
import { label, labelIn, LANE_ORDER } from "./labels"
import { loadBoardBundles } from "./load"
import type { BoardCard, EntityKind, EntityList, EntityView, Fact } from "./types"

const KIND_LABEL: Record<EntityKind, string> = { driver: "Driver", customer: "Customer", site: "Managed site" }

function hoursText(value: unknown): string | null {
  const hours = typeof value === "object" && value && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  if (!hours) return null
  const parts = [
    str(hours.mon_fri) ? `Mon–Fri ${str(hours.mon_fri)}` : null,
    str(hours.sat) ? `Sat ${str(hours.sat)}` : "Sat closed",
    str(hours.sun) ? `Sun ${str(hours.sun)}` : "Sun closed",
  ].filter((part): part is string => !!part)
  return parts.length ? parts.join(" · ") : null
}

function laneSorted(cards: BoardCard[]): BoardCard[] {
  return [...cards].sort((a, b) => LANE_ORDER.indexOf(a.displayLane as (typeof LANE_ORDER)[number]) - LANE_ORDER.indexOf(b.displayLane as (typeof LANE_ORDER)[number])
    || String(a.decisive?.start ?? "").localeCompare(String(b.decisive?.start ?? "")))
}

function laneCounts(cards: BoardCard[]): string {
  const counts = LANE_ORDER.map((lane) => [lane, cards.filter((card) => card.displayLane === lane).length] as const).filter(([, count]) => count > 0)
  return counts.map(([lane, count]) => `${count} ${label(lane === "intake" ? "new" : lane).toLowerCase()}`).join(" · ")
}

export async function loadEntity(kind: EntityKind, id: string): Promise<EntityView | null> {
  if (kind === "driver") return loadDriver(id)
  if (kind === "customer") return loadCustomer(id)
  return loadSite(id)
}

async function loadDriver(id: string): Promise<EntityView | null> {
  const [driver] = await db.select().from(drivers).where(eq(drivers.id, id)).limit(1)
  if (!driver) return null
  const { snapshotAt, bundles } = await loadBoardBundles()
  const involved: { bundle: Bundle; role: string; at: string }[] = []
  for (const bundle of bundles) {
    const assignments = rows(bundle, "work_assignments").filter((row) => row.details.driver_id === id)
    const exposures = rows(bundle, "market_offer_exposures").filter((row) => row.details.driver_id === id)
    const reports = rows(bundle, "custody_reports").filter((row) => row.details.driver_id === id)
    if (!assignments.length && !exposures.length && !reports.length) continue
    const live = assignments.find((row) => row.details.status !== "CANCELLED") ?? assignments[0]
    const parts: string[] = []
    if (live && live.details.status !== "CANCELLED") parts.push(label(str(live.details.status)))
    if (assignments.some((row) => row.details.status === "CANCELLED")) parts.push(live && live.details.status !== "CANCELLED" ? "an earlier booking cancelled" : "Booking cancelled")
    for (const exposure of exposures) parts.push(`directed offer ${labelIn(str(exposure.details.status))}`)
    if (reports.length) parts.push("custody report filed")
    const at = str(live?.details.started_at) ?? str(live?.details.accepted_at) ?? str(exposures[0]?.details.shown_at) ?? bundle.order.createdAt
    involved.push({ bundle, role: parts.join(" · "), at })
  }
  involved.sort((a, b) => a.at.localeCompare(b.at))
  const cards = involved.map((item) => buildBoardCard(item.bundle))
  const statuses = involved.flatMap((item) => rows(item.bundle, "work_assignments").filter((row) => row.details.driver_id === id).map((row) => str(row.details.status) ?? ""))
  const facts: Fact[] = [
    { label: "Home base", value: `${driver.homeCity}, ${driver.homeCountry}`, hint: "a home base is not a current location" },
    { label: "Status", value: bool(driver.details.active) === false ? "Inactive" : "Active" },
    { label: "Assignments in this snapshot", value: statuses.length ? ["IN_PROGRESS", "ASSIGNED", "COMPLETED", "CANCELLED"].map((status) => [status, statuses.filter((item) => item === status).length] as const).filter(([, count]) => count).map(([status, count]) => `${count} ${labelIn(status)}`).join(" · ") : "none" },
  ]
  return {
    snapshotAt, kind: "driver", kindLabel: KIND_LABEL.driver, id, title: driver.displayName, subtitle: null, facts,
    notes: ["Orders are in the order the driver took them on. A prior duty's delivery city is a past observation, not where the driver is now."],
    links: [], cards, roles: Object.fromEntries(involved.map((item) => [item.bundle.order.id, item.role])),
  }
}

async function loadCustomer(id: string): Promise<EntityView | null> {
  const [customer] = await db.select().from(customers).where(eq(customers.id, id)).limit(1)
  if (!customer) return null
  const { snapshotAt, bundles } = await loadBoardBundles()
  const own = bundles.filter((bundle) => bundle.order.details && bundle.customer.id === id)
  const cards = laneSorted(own.map(buildBoardCard))
  const siteRows = await db.select().from(sites).where(eq(sites.customerId, id))
  const facts: Fact[] = [
    { label: "Account", value: label(customer.accountTier) },
    { label: "Country", value: customer.country },
    { label: "Orders in this snapshot", value: cards.length ? `${cards.length} · ${laneCounts(cards)}` : "none" },
  ]
  return {
    snapshotAt, kind: "customer", kindLabel: KIND_LABEL.customer, id, title: customer.name, subtitle: null, facts,
    notes: siteRows.length ? ["A site profile associated with this account does not grant access to every order using that site."] : [],
    links: siteRows.map((site) => ({ label: site.name, href: `/sites/${site.id}`, hint: `${label(site.kind)} · ${site.city}, ${site.country}` })),
    cards, roles: Object.fromEntries(own.map((bundle) => [bundle.order.id, "Contracting customer"])),
  }
}

async function loadSite(id: string): Promise<EntityView | null> {
  const [site] = await db.select().from(sites).where(eq(sites.id, id)).limit(1)
  if (!site) return null
  const { snapshotAt, bundles } = await loadBoardBundles()
  const involved: { bundle: Bundle; role: string }[] = []
  for (const bundle of bundles) {
    const pickupSite = bundle.order.pickupSiteId ?? bundle.places.get(bundle.order.pickupAddressId)?.managedSiteId ?? null
    const deliverySite = bundle.order.deliverySiteId ?? bundle.places.get(bundle.order.deliveryAddressId)?.managedSiteId ?? null
    const transfer = rows(bundle, "transport_points").some((point) => point.details.site_id === id && point.details.role === "TRANSFER")
    const roles: string[] = []
    if (pickupSite === id) roles.push("Pickup")
    if (deliverySite === id) roles.push("Delivery")
    if (transfer) roles.push("Transfer yard")
    if (!roles.length) continue
    involved.push({ bundle, role: roles.join(" and ") })
  }
  const cards = laneSorted(involved.map((item) => buildBoardCard(item.bundle)))
  const d = site.details
  const facts: Fact[] = [
    { label: "Kind", value: label(site.kind) },
    { label: "Address", value: `${str(d.address_line1) ?? "Street not recorded"}, ${site.city}, ${site.country}` },
    { label: "Hours", value: hoursText(d.opening_hours) ?? "Not recorded", hint: str(d.timezone) ? `local time, ${str(d.timezone)}` : null },
    { label: "Handover", value: str(d.handover_mode) ? label(str(d.handover_mode)) : "Not recorded", hint: num(d.advance_notice_minutes) ? `${num(d.advance_notice_minutes)} min advance notice` : null },
    { label: "Signed release", value: bool(d.requires_signed_release) == null ? "Not recorded" : bool(d.requires_signed_release) ? "Required" : "Not required" },
    { label: "Pickup contact", value: str(d.pickup_contact_email) ?? "Not recorded", mono: !!str(d.pickup_contact_email) },
    { label: "Orders in this snapshot", value: cards.length ? `${cards.length} · ${laneCounts(cards)}` : "none" },
  ]
  const notes = [
    str(d.pickup_access_note) ? `Pickup procedure: ${str(d.pickup_access_note)}` : null,
    str(d.delivery_access_note) && str(d.delivery_access_note) !== str(d.pickup_access_note) ? `Delivery procedure: ${str(d.delivery_access_note)}` : null,
    str(d.release_document_rule) ? `Release rule: ${str(d.release_document_rule)}` : null,
    "A standing site procedure is not a confirmation for a specific car, key set or appointment. Each order's endpoint detail records what was checked for that order.",
  ].filter((note): note is string => !!note)
  const customerLink = site.customerId ? await db.select({ id: customers.id, name: customers.name }).from(customers).where(eq(customers.id, site.customerId)).limit(1) : []
  return {
    snapshotAt, kind: "site", kindLabel: KIND_LABEL.site, id, title: site.name, subtitle: `${label(site.kind)} · ${site.city}, ${site.country}`, facts, notes,
    links: customerLink.map((customer) => ({ label: customer.name, href: `/customers/${customer.id}`, hint: "associated account" })),
    cards, roles: Object.fromEntries(involved.map((item) => [item.bundle.order.id, item.role])),
  }
}

/** Every driver, customer or site, with how many orders in the snapshot involve it. */
export async function listEntities(kind: EntityKind): Promise<EntityList> {
  const { bundles } = await loadBoardBundles()
  if (kind === "driver") {
    const rowsAll = await db.select().from(drivers)
    const counts = new Map<string, number>()
    for (const bundle of bundles) {
      const ids = new Set(rows(bundle, "work_assignments").map((row) => str(row.details.driver_id)).filter((value): value is string => !!value))
      for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    const items = rowsAll.map((driver) => ({
      id: driver.id, title: driver.displayName, subtitle: `${driver.homeCity}, ${driver.homeCountry}`, count: counts.get(driver.id) ?? 0, href: `/drivers/${driver.id}`,
    })).sort((a, b) => b.count - a.count || a.title.localeCompare(b.title))
    return { kind, kindLabel: "Drivers", items }
  }
  if (kind === "customer") {
    const rowsAll = await db.select().from(customers)
    const counts = new Map<string, number>()
    for (const bundle of bundles) counts.set(bundle.customer.id, (counts.get(bundle.customer.id) ?? 0) + 1)
    const items = rowsAll.map((customer) => ({
      id: customer.id, title: customer.name, subtitle: `${label(customer.accountTier)} · ${customer.country}`, count: counts.get(customer.id) ?? 0, href: `/customers/${customer.id}`,
    })).sort((a, b) => b.count - a.count || a.title.localeCompare(b.title))
    return { kind, kindLabel: "Customers", items }
  }
  const rowsAll = await db.select().from(sites)
  const counts = new Map<string, number>()
  for (const bundle of bundles) {
    const ids = new Set([
      bundle.order.pickupSiteId ?? bundle.places.get(bundle.order.pickupAddressId)?.managedSiteId ?? null,
      bundle.order.deliverySiteId ?? bundle.places.get(bundle.order.deliveryAddressId)?.managedSiteId ?? null,
      ...rows(bundle, "transport_points").map((point) => str(point.details.site_id)),
    ].filter((value): value is string => !!value))
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  const items = rowsAll.map((site) => ({
    id: site.id, title: site.name, subtitle: `${label(site.kind)} · ${site.city}, ${site.country}`, count: counts.get(site.id) ?? 0, href: `/sites/${site.id}`,
  })).sort((a, b) => b.count - a.count || a.title.localeCompare(b.title))
  return { kind, kindLabel: "Places", items }
}

export { strings }
