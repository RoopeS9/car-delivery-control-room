// Server-side reads for the site chat (demo surface): which pickup and
// delivery contacts can write in, and the thread one contact may see about
// one order. A site sees only its own messages and Bahn's replies to it.

import { and, asc, eq, inArray, or } from "drizzle-orm"
import { crDb } from "@/lib/cr/db"
import { crEvents } from "@/lib/cr/schema"
import { addresses, customers, messages, orderItems, orders, relatedRecords, sites, vehicles } from "@/lib/schema"

type Row = Record<string, unknown>
const str = (value: unknown) => (typeof value === "string" ? value : null)

export type SiteContact = {
  /** The order's endpoint detail id (`ep-…`): what the channel route takes as `siteContactId`. */
  id: string
  orderId: string
  reference: string
  boundary: "PICKUP" | "DELIVERY"
  contactName: string | null
  contactRole: string | null
  placeName: string
  city: string
  siteId: string | null
  addressId: string
  vehicle: string
  /** The place belongs to the paying customer, so Bahn's replies wait for a person. */
  ownedByCustomer: boolean
  customerName: string | null
}

export type SiteThreadMessage = { id: string; at: string; mine: boolean; fromName: string; text: string; origin: "dataset" | null }

/** Contacts on orders that are still to be collected or delivered. */
export async function listContacts(): Promise<SiteContact[]> {
  const db = crDb()
  const live = await db.select().from(orders).where(inArray(orders.status, ["WAITING_FOR_PICKUP", "IN_TRANSIT"]))
  const orderIds = live.map((row) => row.id)
  if (orderIds.length === 0) return []
  const [endpoints, addressRows, siteRows, customerRows, itemRows] = await Promise.all([
    db.select({ id: relatedRecords.id, details: relatedRecords.details }).from(relatedRecords)
      .where(and(eq(relatedRecords.collection, "order_endpoint_details"), inArray(relatedRecords.orderId, orderIds))),
    db.select().from(addresses),
    db.select().from(sites),
    db.select().from(customers),
    db.select({ orderId: orderItems.orderId, role: orderItems.role, make: vehicles.make, model: vehicles.model }).from(orderItems)
      .innerJoin(vehicles, eq(orderItems.vehicleId, vehicles.id)).where(inArray(orderItems.orderId, orderIds)),
  ])
  const contacts: SiteContact[] = []
  for (const endpoint of endpoints) {
    const details = endpoint.details as Row
    const order = live.find((row) => row.id === details.order_id)
    const address = addressRows.find((row) => row.id === details.address_id)
    if (!order || !address) continue
    const boundary = details.boundary === "DELIVERY" ? "DELIVERY" : "PICKUP"
    // A collected car's pickup desk has nothing left to ask about.
    if (order.status === "IN_TRANSIT" && boundary === "PICKUP") continue
    const site = siteRows.find((row) => row.id === (str(details.site_id) ?? address.managedSiteId))
    const car = itemRows.find((row) => row.orderId === order.id && row.role === "PRIMARY") ?? itemRows.find((row) => row.orderId === order.id)
    contacts.push({
      id: endpoint.id, orderId: order.id, reference: order.reference, boundary,
      contactName: str(details.contact_name), contactRole: str(details.contact_role),
      placeName: site?.name ?? address.name, city: address.city, siteId: site?.id ?? null, addressId: address.id,
      vehicle: car ? `${car.make} ${car.model}` : "Car",
      ownedByCustomer: !!site?.customerId && site.customerId === order.customerId,
      customerName: customerRows.find((row) => row.id === order.customerId)?.name ?? null,
    })
  }
  return contacts.sort((a, b) => a.reference.localeCompare(b.reference) || a.boundary.localeCompare(b.boundary))
}

export async function loadContact(id: string): Promise<SiteContact | null> {
  return (await listContacts()).find((contact) => contact.id === id) ?? null
}

/** The ids Bahn may have used to address this contact: endpoint, site, or end and address for a one-off place. */
function contactIds(contact: SiteContact): string[] {
  return [contact.id, contact.siteId, `${contact.boundary.toLowerCase()}:${contact.addressId}`].filter((id): id is string => !!id)
}

export async function loadSiteThread(contact: SiteContact): Promise<SiteThreadMessage[]> {
  const db = crDb()
  const ids = contactIds(contact)
  const [datasetRows, ourRows] = await Promise.all([
    db.select().from(messages).where(eq(messages.orderId, contact.orderId)).orderBy(asc(messages.authoredAt)),
    db.select().from(crEvents).where(and(eq(crEvents.orderId, contact.orderId), or(
      and(eq(crEvents.actorType, "site"), inArray(crEvents.actorId, ids)),
      and(eq(crEvents.recipientType, "site"), inArray(crEvents.recipientId, ids)),
    ))).orderBy(asc(crEvents.at)),
  ])
  const fromDataset = datasetRows.filter((row) => {
    const details = row.details as Row
    if (details.visibility !== "PUBLIC") return false
    const author = str(details.author_id)
    const recipient = str(details.recipient_id)
    return (["site_contact", "handoff_contact"].includes(row.authorType) && !!author && ids.includes(author)) ||
      (["site_contact", "handoff_contact"].includes(String(details.recipient_type)) && !!recipient && ids.includes(recipient))
  }).map((row): SiteThreadMessage => {
    const mine = row.authorType === "site_contact" || row.authorType === "handoff_contact"
    return { id: row.id, at: row.authoredAt.toISOString(), mine, fromName: mine ? "You" : "Bahn operations", text: row.body, origin: "dataset" }
  })
  const fromUs = ourRows.filter((row) => row.kind === "message" || row.kind === "effect").map((row): SiteThreadMessage => {
    const mine = row.actorType === "site"
    return { id: row.id, at: row.at.toISOString(), mine, fromName: mine ? "You" : row.actorType === "agent" ? "Bahn assistant" : "Bahn operations", text: row.body, origin: null }
  })
  return [...fromDataset, ...fromUs].sort((a, b) => a.at.localeCompare(b.at))
}
