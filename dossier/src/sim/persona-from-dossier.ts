// A counterpart for any order and purpose, built from the dossier: the desk or driver answers with what their side of
// the records says, so a simulated call lines up with the dossier, plus a twist that makes the call worth having.
// The four hand-written personas in personas.ts stay as fixtures; this makes the same shape for every other order.
import { z } from "zod"
import type { Dossier } from "../dossier"
import { items, sayTime } from "../brief"
import type { CallPurpose, SlotName, SlotValue } from "../live"
import type { Answer, Persona } from "./personas"

/** How the other party behaves. cooperative answers from the records; the others make the call earn its keep. */
export const Twist = z.enum(["cooperative", "confused", "rushed", "wrong_fact"])
export type Twist = z.infer<typeof Twist>

const MOOD: Record<Twist, Persona["mood"]> = { cooperative: "COOPERATIVE", confused: "CONFUSED", rushed: "RUSHED", wrong_fact: "COOPERATIVE" }
const say = (slot: SlotName, text: string, value: SlotValue["value"] | null): Answer => ({ text, value: value == null ? null : ({ slot, value } as SlotValue) })
const unknown = (text: string): Answer => ({ text, value: null })

function localClock(iso: string, zone: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: zone, hour12: false })
}

/** A pickup desk answering about this order's collection. */
function deskPersona(d: Dossier, twist: Twist): Persona {
  const order = items(d, "orders")[0]!.record
  const site = items(d, "sites").map((i) => i.record).find((s) => s.id === order.pickup_site_id)
  const detail = items(d, "order_endpoint_details").map((i) => i.record).find((x) => x.boundary === "PICKUP")
  const slot = items(d, "time_windows").map((i) => i.record).find((w) => w.purpose === "SELECTED_PICKUP_SLOT" && w.is_selected)
  const veh = items(d, "vehicles")[0]?.record
  const car = veh ? `${veh.make} ${veh.model}` : "the car"
  const zone = site?.timezone ?? "Europe/Helsinki"
  const opens = site?.opening_hours.mon_fri?.split("-")[0] ?? "08:00"
  const slotLocal = slot ? localClock(slot.start_at, zone) : null
  const openDuringSlot = slotLocal ? slotLocal >= opens : true
  const releaser = detail?.contact_name ?? "whoever is on the desk"
  const name = site?.name ?? detail?.contact_name ?? "the pickup desk"
  const answers: Persona["answers"] = {}
  if (twist === "confused") {
    answers.VEHICLE_PRESENT = unknown(`I would have to check, I cannot see the lot from here. Which car was it again?`)
    answers.KEYS_AT_SITE = unknown("I am not sure who has the keys for that one, it is not in my drawer.")
    answers.RELEASE_CONTACT_NAME = unknown("Someone from sales, probably. They are not in yet.")
    answers.RELEASE_DOCUMENT_PRESENT = unknown("There might be papers with the car, I do not know.")
    answers.OPEN_DURING_SLOT = say("OPEN_DURING_SLOT", `We open at ${opens}.`, openDuringSlot)
    answers.ACCESS_INSTRUCTION = say("ACCESS_INSTRUCTION", site?.pickup_access_note ? `Come to ${site.handover_mode.replace(/_/g, " ")}. ${site.pickup_access_note}` : "Come to reception, I suppose.", site?.pickup_access_note ?? "Reception")
  } else if (twist === "wrong_fact") {
    answers.VEHICLE_PRESENT = say("VEHICLE_PRESENT", `No, that ${car} went to our other branch yesterday, it is not here.`, false)
    answers.KEYS_AT_SITE = say("KEYS_AT_SITE", "The keys went with it.", false)
    answers.RELEASE_CONTACT_NAME = say("RELEASE_CONTACT_NAME", `${releaser} would release it, if it were here.`, releaser)
    answers.RELEASE_DOCUMENT_PRESENT = say("RELEASE_DOCUMENT_PRESENT", "We have the release paper on file, yes.", true)
    answers.OPEN_DURING_SLOT = say("OPEN_DURING_SLOT", `We are open from ${opens}.`, openDuringSlot)
    answers.ACCESS_INSTRUCTION = say("ACCESS_INSTRUCTION", site?.pickup_access_note ?? "Main entrance, then reception.", site?.pickup_access_note ?? "Main entrance, then reception")
  } else {
    const rushed = twist === "rushed"
    answers.VEHICLE_PRESENT = say("VEHICLE_PRESENT", rushed ? `Yes yes, the ${car} is here.` : `Yes, the ${car} is on the lot, ready to go.`, true)
    answers.KEYS_AT_SITE = say("KEYS_AT_SITE", rushed ? "Keys are at the desk." : "The keys are in the key safe at the desk.", true)
    answers.RELEASE_CONTACT_NAME = say("RELEASE_CONTACT_NAME", rushed ? `${releaser}.` : `${releaser} will hand it over.`, releaser)
    answers.RELEASE_DOCUMENT_PRESENT = site?.requires_signed_release
      ? say("RELEASE_DOCUMENT_PRESENT", rushed ? "The signed release is with the keys." : "Yes, we have the signed release document with the keys.", true)
      : say("RELEASE_DOCUMENT_PRESENT", "We do not use a release paper here; the driver signs our handover sheet.", false)
    answers.OPEN_DURING_SLOT = say("OPEN_DURING_SLOT", openDuringSlot ? `We open at ${opens}, so that is fine.` : `We only open at ${opens}, nobody is here before that.`, openDuringSlot)
    answers.ACCESS_INSTRUCTION = say("ACCESS_INSTRUCTION", site?.pickup_access_note ?? "Main entrance, then reception.", site?.pickup_access_note ?? "Main entrance, then reception")
  }
  return {
    id: `desk-${order.reference.toLowerCase()}-${twist}`, orderRef: order.reference, role: "PICKUP_SITE_DESK", mood: MOOD[twist],
    greeting: twist === "rushed" ? `${name}, yes, quickly please.` : twist === "confused" ? "Hello? Reception." : `${name}, good morning.`,
    answers,
    ...(twist === "rushed" ? { volunteers: ["I have customers waiting, is that all?"] } : {}),
  }
}

/** The booked driver answering a start check, a position check or a ferry check. */
function driverPersona(d: Dossier, purpose: CallPurpose, twist: Twist): Persona {
  const order = items(d, "orders")[0]!.record
  const assignment = items(d, "work_assignments").map((i) => i.record).find((a) => a.status === "IN_PROGRESS" || a.status === "ASSIGNED")
  const driver = items(d, "drivers").map((i) => i.record).find((x) => x.id === assignment?.driver_id)
  const slot = items(d, "time_windows").map((i) => i.record).find((w) => w.purpose === "SELECTED_PICKUP_SLOT" && w.is_selected)
  const pAddr = items(d, "addresses").map((i) => i.record).find((a) => a.id === order.pickup_address_id)
  const dAddr = items(d, "addresses").map((i) => i.record).find((a) => a.id === order.delivery_address_id)
  const booked = items(d, "travel_reservations").map((i) => i.record).filter((r) => r.status === "BOOKED" && r.kind !== "FERRY")
  const ferry = items(d, "travel_reservations").map((i) => i.record).find((r) => r.kind === "FERRY" && r.status === "BOOKED")
  const tracking = items(d, "tracking_observations").sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))[0]?.record
  const gps = d.live.telemetry.filter((t) => t.kind === "GPS").sort((a, b) => b.at.localeCompare(a.at))[0]
  const zone = pAddr?.timezone ?? "Europe/Helsinki"
  const start = assignment?.positioning?.planned_release_city ?? driver?.home_city ?? "home"
  const first = driver?.display_name.split(" ")[0] ?? "the driver"
  const answers: Persona["answers"] = {}
  const unworkable = assignment?.positioning?.assessment === "DRIVER_REPORTED_UNWORKABLE"
  if (purpose === "DRIVER_START_CHECK") {
    const slotAt = slot ? Date.parse(slot.start_at) : Date.parse(d.asOf) + 86400e3
    const lateEta = new Date(slotAt + 4 * 3600e3).toISOString(), onTimeEta = new Date(slotAt - 30 * 60e3).toISOString()
    answers.DRIVER_FIT_TO_DRIVE = say("DRIVER_FIT_TO_DRIVE", twist === "rushed" ? "Yes, fine, but I am driving right now." : "Yes, I am rested and fit.", true)
    answers.DRIVER_START_LOCATION = say("DRIVER_START_LOCATION", `I start from ${start}.`, start)
    if (twist === "wrong_fact") answers.DRIVER_TRAVEL_BOOKED = say("DRIVER_TRAVEL_BOOKED", "Nobody booked me anything, I was going to ask about that.", false)
    else answers.DRIVER_TRAVEL_BOOKED = booked.length ? say("DRIVER_TRAVEL_BOOKED", `Yes, I have the ${booked.map((b) => b.kind.toLowerCase()).join(" and ")} booked, ${booked[0]!.route_label}.`, true) : say("DRIVER_TRAVEL_BOOKED", "No, I have no travel booked; I will drive there myself.", false)
    if (unworkable || twist === "rushed") answers.ETA = say("ETA", `With my rest I cannot be there before ${sayTime(lateEta, zone).split(",")[0]}, the morning slot is not possible.`, lateEta)
    else answers.ETA = say("ETA", `I will be there by ${sayTime(onTimeEta, zone).split(",")[0]}, before the slot.`, onTimeEta)
    answers.ISSUE_REPORTED = unworkable || twist === "rushed" ? say("ISSUE_REPORTED", "The morning slot does not work for me after this job, somebody needs to look at that.", "Cannot make the morning slot after required rest") : twist === "confused" ? unknown("Which job is this again? I have two this week.") : say("ISSUE_REPORTED", "No, nothing else.", "none")
  } else if (purpose === "FERRY_CHECKIN") {
    const where = gps?.kind === "GPS" ? `on the road, about ${Math.round((tracking?.distance_remaining_km ?? 100))} kilometres from the port` : "on the motorway towards the port"
    answers.FERRY_CHECKED_IN = twist === "wrong_fact" || twist === "rushed" ? say("FERRY_CHECKED_IN", "Not yet, there is a queue at the terminal and I am still in it.", false) : say("FERRY_CHECKED_IN", "Yes, I checked in at the gate a few minutes ago, I am in the lane.", true)
    answers.CURRENT_LOCATION = say("CURRENT_LOCATION", twist === "cooperative" ? "At the terminal, in the boarding lane." : where, twist === "cooperative" ? "Ferry terminal, boarding lane" : where)
    answers.ETA = ferry ? say("ETA", `Arrival should be as on the booking, ${sayTime(ferry.expected_arrival_at, "Europe/Helsinki").split(",")[0]}.`, ferry.expected_arrival_at) : unknown("I do not know the arrival time.")
    answers.ISSUE_REPORTED = twist === "rushed" ? say("ISSUE_REPORTED", "If this queue does not move I miss the cutoff.", "Terminal queue may make the driver miss the check-in cutoff") : say("ISSUE_REPORTED", "No, all good.", "none")
  } else {
    const place = gps?.kind === "GPS" ? `on the road, near the last position I sent` : tracking ? `about ${tracking.distance_remaining_km} kilometres from ${dAddr?.city ?? "delivery"}` : `on the way to ${dAddr?.city ?? "delivery"}`
    answers.DRIVER_SAFE = say("DRIVER_SAFE", "Yes, I am fine, driving.", true)
    answers.CURRENT_LOCATION = say("CURRENT_LOCATION", twist === "confused" ? "Somewhere on the motorway, I did not catch the last sign." : `I am ${place}.`, twist === "confused" ? "Motorway, exact place unknown" : place)
    answers.ETA = tracking ? say("ETA", `I should be there around ${sayTime(tracking.estimated_delivery_at, dAddr?.timezone ?? "Europe/Helsinki").split(",")[0]}.`, tracking.estimated_delivery_at) : unknown("Hard to say, a few hours.")
    answers.ISSUE_REPORTED = twist === "wrong_fact" ? say("ISSUE_REPORTED", "The app keeps closing on my phone, that is why you lost me.", "Driver app crashing; position reports stopped") : twist === "rushed" ? say("ISSUE_REPORTED", "No, I just had the phone in the bag. Can I go?", "Phone was put away; no problem reported") : say("ISSUE_REPORTED", "No problem, the phone must have lost signal.", "Phone lost signal; no problem reported")
  }
  return {
    id: `driver-${order.reference.toLowerCase()}-${purpose.toLowerCase().replace(/_/g, "-")}-${twist}`, orderRef: order.reference, role: "DRIVER", mood: MOOD[twist],
    greeting: twist === "rushed" ? `${first} here, I am driving, make it quick.` : `Hello, ${first} speaking.`,
    answers,
  }
}

/** The other party for a call of this purpose on this order. Throws when the dossier has nobody to play. */
export function personaFor(d: Dossier, purpose: CallPurpose, twist: Twist = "cooperative"): Persona {
  if (purpose === "PICKUP_READINESS") return deskPersona(d, twist)
  if (purpose === "DRIVER_START_CHECK" || purpose === "POSITION_CHECK" || purpose === "FERRY_CHECKIN") {
    if (!items(d, "work_assignments").some((i) => i.record.status === "IN_PROGRESS" || i.record.status === "ASSIGNED")) throw new Error("no booked driver to play")
    return driverPersona(d, purpose, twist)
  }
  throw new Error(`no simulated counterpart for ${purpose}`)
}
