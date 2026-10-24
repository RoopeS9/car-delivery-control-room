// Site chat (demo surface): a pickup or delivery desk writes to Bahn about
// one order. No login: pick the contact, then chat. When the place belongs to
// the paying customer, Bahn's answer waits for a person before it is sent.

import type { Metadata } from "next"
import Link from "next/link"
import { simNowIso } from "@/lib/cr/clock"
import { listContacts, loadContact, loadSiteThread, type SiteContact } from "./data"
import { SiteChat } from "./site-chat"
import styles from "./site.module.css"

export const dynamic = "force-dynamic"
export const metadata: Metadata = { title: "Site chat · Road Desk" }

type Search = Promise<{ [key: string]: string | string[] | undefined }>

/** Contacts in the demo scenarios, listed first. */
const DEMO_CONTACTS = ["ep-xf3ba5412ec8d619e"]

export default async function SitePage({ searchParams }: { searchParams: Search }) {
  const params = await searchParams
  const contactId = typeof params.contact === "string" ? params.contact : null
  if (!contactId) return <Picker />
  const contact = await loadContact(contactId)
  if (!contact) {
    return <main className={styles.page}><div className={styles.state}><h1>Contact not found</h1><p><Link href="/site">Pick a place</Link></p></div></main>
  }
  const thread = await loadSiteThread(contact)
  return <main className={styles.page}>
    <SiteChat key={contact.id} contact={contact} initialThread={thread} serverNow={simNowIso()} />
  </main>
}

async function Picker() {
  const contacts = await listContacts()
  const demo = contacts.filter((contact) => DEMO_CONTACTS.includes(contact.id))
  const pickup = contacts.filter((contact) => !demo.includes(contact) && contact.boundary === "PICKUP")
  const delivery = contacts.filter((contact) => !demo.includes(contact) && contact.boundary === "DELIVERY")
  return <main className={styles.page}>
    <header className={styles.pickerHead}>
      <p className={styles.kicker}>Bahn site chat · demo</p>
      <h1>Which desk is writing?</h1>
      <p className={styles.note}>No login in this prototype. Pick a pickup or delivery contact to write to Bahn about one order.</p>
    </header>
    {[{ title: "In the demo scenarios", list: demo }, { title: "Pickup desks", list: pickup }, { title: "Delivery desks", list: delivery }]
      .map((group) => group.list.length > 0 && <section key={group.title} className={styles.group}>
        <h2>{group.title} <span>{group.list.length}</span></h2>
        <ul>{group.list.map((contact) => <li key={contact.id}><ContactRow contact={contact} /></li>)}</ul>
      </section>)}
  </main>
}

function ContactRow({ contact }: { contact: SiteContact }) {
  return <Link href={`/site?contact=${contact.id}`} className={styles.row}>
    <span className={styles.rowMain}>
      <b>{contact.placeName}</b>
      <small>{contact.contactName ? `${contact.contactName}, ${contact.contactRole ?? "contact"}` : "No named contact on record"} · {contact.city}</small>
    </span>
    <span className={styles.rowSide}>
      <span className="mono">{contact.reference}</span>
      <small>{contact.boundary === "PICKUP" ? "Pickup" : "Delivery"}{contact.ownedByCustomer ? " · customer's own place" : ""}</small>
    </span>
  </Link>
}
