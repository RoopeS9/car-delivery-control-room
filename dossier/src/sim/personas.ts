// Simulated counterparts for the robo-call pipeline: a dealership desk and drivers, each a typed fact sheet
// plus one scripted answer per slot. They only say what their facts support (same rule as Roope's sim driver).
// Facts come from real orders in the dataset so the transcripts line up with the dossier.
import type { SlotName, SlotValue, Situation, Urgency } from "../live"

export type Answer = { text: string; value: SlotValue | null }
export type Persona = {
  id: string
  /** Order whose dossier the brief is built from. */
  orderRef: string
  role: "PICKUP_SITE_DESK" | "DRIVER"
  mood: "COOPERATIVE" | "CONFUSED" | "RUSHED"
  /** How the persona answers the opening when they are the caller (inbound) or the callee (outbound). */
  greeting: string
  /** Inbound only: what the persona says when asked "are you safe, is this urgent", and how triage should read it. */
  inbound?: { opening: string; urgency: Urgency; situation: Situation }
  answers: Partial<Record<SlotName, Answer>>
  /** Lines the persona volunteers after the last question, before the closing. */
  volunteers?: string[]
}

export const PERSONAS: Persona[] = [
  {
    // CD-420442: Orvendin Cars Stockholm, pickup desk, not the paying customer. Slot 22 Oct 08:00. Driver Kasper Darevik.
    id: "desk-orvendin-stockholm", orderRef: "CD-420442", role: "PICKUP_SITE_DESK", mood: "COOPERATIVE",
    greeting: "Orvendin Cars Stockholm, Uma speaking.",
    answers: {
      VEHICLE_PRESENT: { text: "Yes, the car is here on the lot, I can see it on the release list.", value: { slot: "VEHICLE_PRESENT", value: true } },
      KEYS_AT_SITE: { text: "The keys are in our key safe at reception.", value: { slot: "KEYS_AT_SITE", value: true } },
      RELEASE_CONTACT_NAME: { text: "I will release it myself, Uma Aldermere, or my colleague Jonas if I am on a break.", value: { slot: "RELEASE_CONTACT_NAME", value: "Uma Aldermere (or Jonas)" } },
      RELEASE_DOCUMENT_PRESENT: { text: "We have the signed release in the folder with the car.", value: { slot: "RELEASE_DOCUMENT_PRESENT", value: true } },
      OPEN_DURING_SLOT: { text: "We open at eight, so eight o'clock is fine.", value: { slot: "OPEN_DURING_SLOT", value: true } },
      ACCESS_INSTRUCTION: { text: "Tell the driver to come to the main reception, not the workshop gate.", value: { slot: "ACCESS_INSTRUCTION", value: "Main reception, not the workshop gate" } },
    },
  },
  {
    // CD-420516: the alert says reception has no keys, the side gate is not a release desk, stock-control callback pending.
    id: "desk-confused-516", orderRef: "CD-420516", role: "PICKUP_SITE_DESK", mood: "CONFUSED",
    greeting: "Reception, hello?",
    answers: {
      VEHICLE_PRESENT: { text: "Our stock screen lists a warehouse transfer for that car. I cannot see it on the lot from here.", value: { slot: "VEHICLE_PRESENT", value: false } },
      KEYS_AT_SITE: { text: "Reception does not have the keys for this one. I do not know who does.", value: { slot: "KEYS_AT_SITE", value: false } },
      RELEASE_CONTACT_NAME: { text: "Stock control would know. They said they would call you back.", value: null },
      RELEASE_DOCUMENT_PRESENT: { text: "I would have to ask stock control about papers too.", value: null },
      OPEN_DURING_SLOT: { text: "We are open from eight thirty.", value: { slot: "OPEN_DURING_SLOT", value: true } },
      ACCESS_INSTRUCTION: { text: "The side gate is only for cars coming in, it is not a collection desk. Come to reception, but like I said, we do not have the keys.", value: { slot: "ACCESS_INSTRUCTION", value: "Reception, not the side gate; reception has no keys" } },
    },
    volunteers: ["Honestly I think the car might be at the warehouse. Stock control will call you."],
  },
  {
    // CD-420399: accepted driver says required rest after the prior duty makes the Leipzig pickup unreachable.
    id: "driver-399-rest", orderRef: "CD-420399", role: "DRIVER", mood: "RUSHED",
    greeting: "Hello, yes, I am driving, quickly please.",
    answers: {
      DRIVER_FIT_TO_DRIVE: { text: "I am fine, but after this handover in Hamburg I must take my rest.", value: { slot: "DRIVER_FIT_TO_DRIVE", value: true } },
      DRIVER_START_LOCATION: { text: "I will be in Hamburg tonight after I deliver this car.", value: { slot: "DRIVER_START_LOCATION", value: "Hamburg, after tonight's handover" } },
      DRIVER_TRAVEL_BOOKED: { text: "No, nobody has booked me anything to Leipzig.", value: { slot: "DRIVER_TRAVEL_BOOKED", value: false } },
      ETA: { text: "With my rest I cannot leave before twelve tomorrow, so I would be in Leipzig around three in the afternoon at the earliest.", value: { slot: "ETA", value: "2026-10-22T13:00:00Z" } },
      ISSUE_REPORTED: { text: "The Leipzig slot in the morning is not possible for me. Someone should look at that.", value: { slot: "ISSUE_REPORTED", value: "Cannot reach the Leipzig morning pickup after required rest; earliest departure 12:00 local" } },
    },
  },
  {
    // CD-420584: Leo calls in. Fresh flashing engine light, stopped at a service area. Not in the dataset: a live event.
    id: "driver-leo-inbound", orderRef: "CD-420584", role: "DRIVER", mood: "COOPERATIVE",
    greeting: "Hi, this is Leo.",
    inbound: { opening: "I am safe, I have stopped. The engine light is flashing and the car was shaking, I think this is urgent.", urgency: "URGENT", situation: "WARNING_LIGHT" },
    answers: {
      DRIVER_SAFE: { text: "Yes, I am safe, parked at the service area away from the traffic.", value: { slot: "DRIVER_SAFE", value: true } },
      CURRENT_LOCATION: { text: "A service area on the A1 near Osnabrueck, northbound.", value: { slot: "CURRENT_LOCATION", value: "Service area, A1 near Osnabrueck, northbound" } },
      WARNING_LIGHT: { text: "The orange engine light, and it is flashing, not steady.", value: { slot: "WARNING_LIGHT", value: "AMBER_FLASHING" } },
      SYMPTOMS: { text: "It was shaking under acceleration and lost power. No smoke, no smell.", value: { slot: "SYMPTOMS", value: "Shaking under acceleration, loss of power, no smoke or smell" } },
      ENGINE_OFF: { text: "Yes, I switched it off when I stopped.", value: { slot: "ENGINE_OFF", value: true } },
      ISSUE_REPORTED: { text: "I am worried about the ferry check-in this afternoon.", value: { slot: "ISSUE_REPORTED", value: "Ferry check-in at risk" } },
    },
  },
]
