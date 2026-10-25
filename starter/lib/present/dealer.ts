// The Dealer role: you play the desk at a pickup site. The sites that have
// collections coming, and for one site the booked collections as the desk sees
// them: which car, when, who collects it, and whether Bahn's agent may call.

import { deriveKeyDates } from "./attention"
import { type Bundle, rows, str } from "./bundle"
import { laneLabel } from "./labels"

export type DealerSite = { id: string; name: string; city: string; kind: string; count: number; customerSite: boolean }

export type DealerCollection = {
  orderId: string
  reference: string
  vehicle: string
  plate: string | null
  stage: string
  /** "Thu 10:00 to 12:00" in the site's zone, or null. */
  slot: string | null
  slotAt: string | null
  driver: string | null
  /** The paying customer owns this desk: the agent never calls it; a person does. */
  customerSite: boolean
  /** The driver reported collecting the car in the driver app (simulated). */
  collected: boolean
}

export type DealerView = {
  sites: DealerSite[]
  site: (DealerSite & { address: string | null; hours: string | null; access: string | null; zone: string | null }) | null
  collections: DealerCollection[]
}

const UPCOMING = new Set(["intake", "ready", "market", "booked"])

function weekdayClock(iso: string, zone: string | null): string {
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: zone ?? "UTC" }).format(new Date(iso)).replace(",", "")
}
function clock(iso: string, zone: string | null): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: zone ?? "UTC" }).format(new Date(iso))
}

function hoursText(value: unknown): string | null {
  if (!value || typeof value !== "object") return null
  const hours = value as Record<string, string | null>
  const parts = [hours.mon_fri ? `Mon–Fri ${hours.mon_fri}` : null, hours.sat ? `Sat ${hours.sat}` : "Sat closed", hours.sun ? `Sun ${hours.sun}` : "Sun closed"]
  return parts.filter(Boolean).join(" · ")
}

/** When the driver reported collecting the car in the driver app (simulated); such a collection stays on the desk's list for half a day. */
function collectedInApp(bundle: Bundle): string | null {
  const at = bundle.events.find((row) => row.command === "vehicle.picked_up" && row.details.road_desk === true)?.recordedAt ?? null
  return at && Date.parse(bundle.cr.now) - Date.parse(at) < 12 * 3600_000 ? at : null
}

export function buildDealerView(bundles: Bundle[], siteId: string | null): DealerView {
  const upcoming = bundles.filter((bundle) => bundle.order.pickupSiteId && (UPCOMING.has(bundle.order.lane) || collectedInApp(bundle)))
  const counts = new Map<string, number>()
  for (const bundle of upcoming) counts.set(bundle.order.pickupSiteId!, (counts.get(bundle.order.pickupSiteId!) ?? 0) + 1)
  const siteMap = bundles[0]?.sites ?? new Map()
  // A site owned by the paying customer of every collection there: the agent never calls it.
  const ownedByCustomer = (id: string) => {
    const owner = str(siteMap.get(id)?.details.customer_id)
    return !!owner && upcoming.filter((bundle) => bundle.order.pickupSiteId === id).every((bundle) => bundle.customer.id === owner)
  }
  const sites: DealerSite[] = [...counts].map(([id, count]) => {
    const site = siteMap.get(id)
    return { id, name: site?.name ?? id, city: site?.city ?? "", kind: site?.kind ?? "", count, customerSite: ownedByCustomer(id) }
  }).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  const chosen = siteId ? sites.find((site) => site.id === siteId) ?? null : sites[0] ?? null
  if (!chosen) return { sites, site: null, collections: [] }
  const row = siteMap.get(chosen.id)
  const details = row?.details ?? {}
  const zone = str(details.timezone)
  const collections = upcoming.filter((bundle) => bundle.order.pickupSiteId === chosen.id).map((bundle) => {
    const primary = bundle.items.find((item) => item.role === "PRIMARY") ?? bundle.items[0] ?? null
    const slot = deriveKeyDates(bundle).keyDates.find((date) => date.key === "pickup_slot" || date.key === "requested_pickup")
    const assignment = rows(bundle, "work_assignments").find((item) => ["ASSIGNED", "ACCEPTED", "IN_PROGRESS"].includes(str(item.details.status) ?? ""))
    return {
      orderId: bundle.order.id, reference: bundle.order.reference,
      vehicle: primary ? `${primary.vehicle.make} ${primary.vehicle.model}` : "Car not linked", plate: primary?.vehicle.registration ?? null,
      stage: collectedInApp(bundle) ? `Collected ${clock(collectedInApp(bundle)!, zone)} (driver app, simulated)` : laneLabel(bundle.order.lane),
      slot: slot ? `${slot.key === "requested_pickup" ? "requested " : ""}${weekdayClock(slot.start, slot.zone ?? zone)}${slot.end ? ` to ${clock(slot.end, slot.zone ?? zone)}` : ""}` : null,
      slotAt: slot?.start ?? null,
      driver: assignment ? bundle.dir.driverName(assignment.details.driver_id) : null,
      customerSite: str(details.customer_id) === bundle.customer.id,
      collected: Boolean(collectedInApp(bundle)),
    }
  }).sort((a, b) => String(a.slotAt ?? "~").localeCompare(String(b.slotAt ?? "~")))
  return {
    sites,
    site: { ...chosen, address: [str(details.address_line1), row?.city].filter(Boolean).join(", ") || null, hours: hoursText(details.opening_hours), access: str(details.pickup_access_note) ?? str(details.access_note), zone },
    collections,
  }
}
