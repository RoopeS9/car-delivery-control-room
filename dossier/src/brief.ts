// Build a CallBrief from a dossier. Rule-based for now: the shape a reasoning model would fill later.
// Everything the caller may say is phrased for speech, with references spelled digit by digit and conclusions
// precomputed, because the voice models recall facts well and reason badly (MEASURE.md, pplex-lab).
import type { Dossier, DossierItem } from "./dossier"
import { CallBrief, Callee, type CallPurpose } from "./live"
import type { RecordOf } from "./strength"
import type { CollectionName } from "./records.generated"

type Item<C extends CollectionName> = Extract<DossierItem, { collection: C }>
export function items<C extends CollectionName>(d: Dossier, c: C): Item<C>[] {
  return (Object.values(d.classes).flat() as DossierItem[]).filter((i): i is Item<C> => i.collection === c)
}
const rec = <C extends CollectionName>(d: Dossier, c: C): RecordOf<C>[] => items(d, c).map((i) => i.record as RecordOf<C>)

/** "CD-420584" -> "C D four two zero five eight four", so the voice model cannot read it as a number. */
export function spellRef(ref: string): string {
  const digit = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]
  return ref.replace("-", " ").split("").map((ch) => (/\d/.test(ch) ? digit[Number(ch)] : ch === " " ? "" : ch)).filter(Boolean).join(" ")
}
/** "2026-10-21T15:30:00Z" in a zone -> "fifteen thirty" style is left to the model; we give "15:30" and the words. */
export function sayTime(iso: string, zone: string): string {
  const t = new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: zone, hour12: false })
  const [h, m] = t.split(":").map(Number) as [number, number]
  const words = ["twelve", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven"]
  const half = m === 0 ? "" : m === 30 ? " thirty" : ` ${m}`
  return `${t}, that is ${words[h % 12]}${half} in the ${h < 12 ? "morning" : h < 17 ? "afternoon" : "evening"}`
}
export function sayDate(iso: string, zone: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: zone })
}

function mk(d: Dossier, purpose: CallPurpose, callee: Callee, parts: Omit<CallBrief, "id" | "orderId" | "purpose" | "callee" | "createdAt" | "createdBy" | "language">): CallBrief {
  return CallBrief.parse({ id: `brief-${purpose.toLowerCase().replace(/_/g, "-")}-${d.order.id.slice(4)}`, orderId: d.order.id, purpose, callee, createdAt: d.builtAt, createdBy: "RULE", language: "en", ...parts })
}
const basisOf = (xs: DossierItem[]) => xs.map((i) => ({ collection: i.collection, id: i.id }))

function vehicleLine(d: Dossier): string {
  const v = rec(d, "vehicles")[0]
  return v ? `${v.make} ${v.model}${v.registration ? `, registration ${v.registration.split("").join(" ")}` : ""}` : "the car on this order"
}
function driverName(d: Dossier): { id: string; name: string } | null {
  const a = rec(d, "work_assignments").find((x) => x.status === "IN_PROGRESS" || x.status === "ASSIGNED")
  const drv = a ? rec(d, "drivers").find((x) => x.id === a.driver_id) : undefined
  return a && drv ? { id: drv.id, name: drv.display_name } : null
}

/** Call the pickup desk before the driver travels: is the car there, who releases it, which paper, which door. */
export function pickupReadinessBrief(d: Dossier): CallBrief {
  const order = rec(d, "orders")[0]!
  const detail = items(d, "order_endpoint_details").find((i) => i.record.boundary === "PICKUP")
  if (!detail) throw new Error("no pickup endpoint detail")
  const site = rec(d, "sites").find((s) => s.id === order.pickup_site_id) ?? null
  const addr = rec(d, "addresses").find((a) => a.id === order.pickup_address_id)
  const slot = items(d, "time_windows").find((i) => i.record.purpose === "SELECTED_PICKUP_SLOT" && i.record.is_selected)
  const drv = driverName(d)
  const zone = addr?.timezone ?? "Europe/Helsinki"
  const siteCustomerIsPayer = site?.customer_id === d.order.customerId
  if (siteCustomerIsPayer) throw new Error("pickup site belongs to the paying customer: a person calls, not the agent")
  const callee: Callee = { kind: "PICKUP_SITE_DESK", siteId: site?.id ?? null, endpointDetailId: detail.id, name: site?.name ?? addr?.name ?? "the pickup desk" }
  const mayState = [
    `This is about order ${spellRef(order.reference)}, a ${vehicleLine(d)}.`,
    drv ? `Our driver ${drv.name} is booked to collect it.` : "A driver is being booked to collect it.",
    slot ? `The collection slot is ${sayDate(slot.record.start_at, zone)} from ${sayTime(slot.record.start_at, zone)}.` : "No collection slot is selected yet.",
    detail.record.contact_name ? `Our record names ${detail.record.contact_name} as the contact.` : "Our record has no named contact at the desk yet.",
  ]
  if (detail.record.access_instruction) mayState.push(`Our note says: ${detail.record.access_instruction}`)
  return mk(d, "PICKUP_READINESS", callee, {
    opening: `Hello, this is Mira from Bahn car delivery, calling about a collection we have booked with you.`,
    mayState, ask: ["VEHICLE_PRESENT", "KEYS_AT_SITE", "RELEASE_CONTACT_NAME", "RELEASE_DOCUMENT_PRESENT", "OPEN_DURING_SLOT", "ACCESS_INSTRUCTION"],
    mustNot: ["CUSTOMER_DETAILS", "PRICES", "OTHER_ORDERS", "PROMISE_CHANGES"],
    closing: `Thank you. I will pass this to our operator, and the driver will have your instructions before arriving.`,
    maxDurationS: 150, basis: basisOf([detail, ...(slot ? [slot] : []), ...items(d, "sites"), ...items(d, "work_assignments")]),
  })
}

/** The day before: does the driver have travel, where do they start, are they fit, when will they reach pickup. */
export function driverStartCheckBrief(d: Dossier): CallBrief {
  const order = rec(d, "orders")[0]!
  const drv = driverName(d); if (!drv) throw new Error("no booked driver")
  const slot = items(d, "time_windows").find((i) => i.record.purpose === "SELECTED_PICKUP_SLOT" && i.record.is_selected)
  const addr = rec(d, "addresses").find((a) => a.id === order.pickup_address_id)
  const zone = addr?.timezone ?? "Europe/Helsinki"
  const booked = items(d, "travel_reservations").filter((i) => i.record.status === "BOOKED")
  const quotes = items(d, "travel_options")
  const mayState = [
    `This is about your job ${spellRef(order.reference)}, the ${vehicleLine(d)} from ${addr?.city ?? "the pickup city"}.`,
    slot ? `Collection is ${sayDate(slot.record.start_at, zone)} from ${sayTime(slot.record.start_at, zone)}.` : "No collection slot is selected yet.",
    booked.length ? `We have booked your travel: ${booked.map((b) => b.record.route_label).join("; ")}.` : quotes.length ? "Your travel is quoted but not booked yet; a quote is not a ticket." : "No travel is booked or quoted for you on our side.",
  ]
  return mk(d, "DRIVER_START_CHECK", { kind: "DRIVER", driverId: drv.id, name: drv.name }, {
    opening: `Hi ${drv.name.split(" ")[0]}, this is Mira from Bahn Road Desk, a quick check before tomorrow's collection.`,
    mayState, ask: ["DRIVER_FIT_TO_DRIVE", "DRIVER_START_LOCATION", "DRIVER_TRAVEL_BOOKED", "ETA", "ISSUE_REPORTED"],
    mustNot: ["CUSTOMER_DETAILS", "PRICES", "PROMISE_CHANGES", "CLEARANCE_TO_DRIVE"],
    closing: `Thanks. If anything changes, call us or write in the app. An operator confirms any change to the plan.`,
    maxDurationS: 120, basis: basisOf([...items(d, "work_assignments"), ...booked, ...quotes, ...(slot ? [slot] : [])]),
  })
}

/** Prebuilt per active driver, so an inbound call starts with the job already known. Open-ended on purpose. */
export function driverInboundBrief(d: Dossier): CallBrief {
  const order = rec(d, "orders")[0]!
  const drv = driverName(d); if (!drv) throw new Error("no active driver")
  const promise = items(d, "time_windows").find((i) => i.record.purpose === "CUSTOMER_DELIVERY_PROMISE" && i.record.is_selected)
  const ferry = items(d, "travel_reservations").find((i) => i.record.kind === "FERRY" && i.record.status === "BOOKED")
  const dAddr = rec(d, "addresses").find((a) => a.id === order.delivery_address_id)
  const pAddr = rec(d, "addresses").find((a) => a.id === order.pickup_address_id)
  const zone = dAddr?.timezone ?? "Europe/Helsinki"
  const mayState = [
    `${drv.name} is driving the ${vehicleLine(d)}, order ${spellRef(order.reference)}, from ${pAddr?.city ?? "pickup"} to ${dAddr?.city ?? "delivery"}.`,
  ]
  if (ferry?.record.check_in_cutoff_at) mayState.push(`The ferry is booked, reference ${ferry.record.booking_reference.split("").join(" ")}; check-in closes at ${sayTime(ferry.record.check_in_cutoff_at, "Europe/Berlin")}.`)
  if (promise) mayState.push(`Delivery is promised on ${sayDate(promise.record.start_at, zone)} between ${sayTime(promise.record.start_at, zone)} and ${sayTime(promise.record.end_at, zone)}.`)
  mayState.push("If a red or flashing warning light is on: stop safely off the road and switch the engine off.")
  mayState.push("Parking and fuel receipts are claimed in the app under Expenses with a photo.")
  return mk(d, "DRIVER_INBOUND", { kind: "DRIVER", driverId: drv.id, name: drv.name }, {
    opening: `Road Desk here. First: are you safe, and is this urgent?`,
    mayState, ask: ["DRIVER_SAFE", "CURRENT_LOCATION", "ISSUE_REPORTED"],
    mustNot: ["CUSTOMER_DETAILS", "PRICES", "OTHER_ORDERS", "MECHANICAL_ADVICE", "PROMISE_CHANGES", "CLEARANCE_TO_DRIVE"],
    closing: `An operator has this now. Stay with the car and keep your phone on; we will call you back within fifteen minutes.`,
    maxDurationS: 180, basis: basisOf([...items(d, "work_assignments"), ...(ferry ? [ferry] : []), ...(promise ? [promise] : [])]),
  })
}


/** Operator-initiated check on a moving car: where is it, when will it arrive, anything wrong. */
export function positionCheckBrief(d: Dossier): CallBrief {
  const order = rec(d, "orders")[0]!
  const drv = driverName(d); if (!drv) throw new Error("no active driver")
  const promise = items(d, "time_windows").find((i) => i.record.purpose === "CUSTOMER_DELIVERY_PROMISE" && i.record.is_selected)
  const ferry = items(d, "travel_reservations").find((i) => i.record.kind === "FERRY" && i.record.status === "BOOKED")
  const dAddr = rec(d, "addresses").find((a) => a.id === order.delivery_address_id)
  const zone = dAddr?.timezone ?? "Europe/Helsinki"
  const last = items(d, "tracking_observations").sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))[0]
  const mayState = [`This is about your job ${spellRef(order.reference)}, the ${vehicleLine(d)} to ${dAddr?.city ?? "delivery"}.`]
  if (last) mayState.push(`Our last position from your phone was at ${sayTime(last.record.observed_at, zone)}, with about ${last.record.distance_remaining_km} kilometres to go.`)
  if (ferry?.record.check_in_cutoff_at) mayState.push(`Ferry check-in closes at ${sayTime(ferry.record.check_in_cutoff_at, "Europe/Berlin")}.`)
  if (promise) mayState.push(`Delivery is promised on ${sayDate(promise.record.start_at, zone)} between ${sayTime(promise.record.start_at, zone)} and ${sayTime(promise.record.end_at, zone)}.`)
  return mk(d, "POSITION_CHECK", { kind: "DRIVER", driverId: drv.id, name: drv.name }, {
    opening: `Hi ${drv.name.split(" ")[0]}, this is Mira from Bahn Road Desk, a quick check on where you are.`,
    mayState, ask: ["DRIVER_SAFE", "CURRENT_LOCATION", "ETA", "ISSUE_REPORTED"],
    mustNot: ["CUSTOMER_DETAILS", "PRICES", "MECHANICAL_ADVICE", "PROMISE_CHANGES", "CLEARANCE_TO_DRIVE"],
    closing: `Thanks. Drive safely; we will update the plan on our side and an operator confirms any change.`,
    maxDurationS: 90, basis: basisOf([...items(d, "work_assignments"), ...(last ? [last] : []), ...(ferry ? [ferry] : []), ...(promise ? [promise] : [])]),
  })
}

export function briefFor(d: Dossier, purpose: CallPurpose): CallBrief {
  switch (purpose) {
    case "PICKUP_READINESS": return pickupReadinessBrief(d)
    case "DRIVER_START_CHECK": return driverStartCheckBrief(d)
    case "DRIVER_INBOUND": return driverInboundBrief(d)
    case "POSITION_CHECK": return positionCheckBrief(d)
    default: throw new Error(`no brief builder yet for ${purpose}`)
  }
}
