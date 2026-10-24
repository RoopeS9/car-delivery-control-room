// What the interviewer needs to find out, per situation (PLAN.md 4.6 step 3).
// Wording here is shared with the rulebook's driver playbooks. `confirmFrom`
// names context facts the interviewer should confirm instead of asking.

import type { Situation, Urgency } from "../types"

export type SlotDef = {
  key: string
  /** Read-back and operator label. */
  label: string
  /** What to find out, for the prompt. */
  ask: string
  confirmFrom?: string[]
}

export const SLOT_DEFS: Record<string, SlotDef> = {
  safe_place: { key: "safe_place", label: "Safe place", ask: "Are they stopped somewhere safe, off the carriageway (yes or no, and what kind of place)?" },
  location: { key: "location", label: "Location", ask: "Where exactly are they (road, nearest town, service area or junction)?", confirmFrom: ["gps", "tracking"] },
  light: { key: "light", label: "Warning light", ask: "Which warning light, what colour, and is it flashing or steady?", confirmFrom: ["obd"] },
  symptoms: { key: "symptoms", label: "Symptoms", ask: "Any shaking, loss of power, strange noise, smell or smoke?" },
  engine_off: { key: "engine_off", label: "Engine off", ask: "Is the engine switched off now?" },
  photo: { key: "photo", label: "Dashboard photo", ask: "Ask them to send a photo of the dashboard in the app after the call; record whether they agreed." },
  anything_else: { key: "anything_else", label: "Anything else", ask: "Anything else we should know?" },
  hazard: { key: "hazard", label: "Danger", ask: "What is the danger: fire, smoke, an accident, or standing on the carriageway?" },
  injuries: { key: "injuries", label: "Injuries", ask: "Is anyone hurt?" },
  what_happened: { key: "what_happened", label: "What happened", ask: "What happened, in their words?" },
  car_state: { key: "car_state", label: "Car state", ask: "Does the car start or move at all? (Ask only for the fact; never judge whether it is safe to drive.)" },
  other_party: { key: "other_party", label: "Other vehicle", ask: "Was another vehicle or person involved?" },
  police: { key: "police", label: "Police", ask: "Have the police been called or are they there?" },
  damage: { key: "damage", label: "Damage", ask: "What damage can they see on our car?" },
  cause: { key: "cause", label: "Cause of delay", ask: "What is holding them up?" },
  eta_driver: { key: "eta_driver", label: "Driver's own estimate", ask: "How late do they think they will be? (Their estimate, not a promise.)" },
  connection: { key: "connection", label: "Connection at risk", ask: "Is a ferry, train or pickup slot at risk?", confirmFrom: ["travel_ferry", "travel_train"] },
  question: { key: "question", label: "Question", ask: "What is their question, in their words?" },
  site: { key: "site", label: "Which site", ask: "Is this about the pickup or the delivery place?" },
  contact_on_site: { key: "contact_on_site", label: "Person on site", ask: "Have they spoken to anyone on site?" },
  expense_item: { key: "expense_item", label: "Expense", ask: "What did they pay for?" },
  amount: { key: "amount", label: "Amount", ask: "How much, and in which currency?" },
  receipt: { key: "receipt", label: "Receipt", ask: "Do they have a receipt? Ask them to photograph it in the app." },
}

export const SLOT_KEYS = Object.keys(SLOT_DEFS)

type Checklist = { slots: string[] }

export const CHECKLISTS: Record<Situation, Checklist> = {
  WARNING_LIGHT: { slots: ["safe_place", "location", "light", "symptoms", "engine_off", "photo", "anything_else"] },
  BREAKDOWN: { slots: ["safe_place", "location", "what_happened", "car_state", "light", "engine_off", "anything_else"] },
  ACCIDENT: { slots: ["injuries", "safe_place", "location", "other_party", "police", "damage", "photo"] },
  DELAY: { slots: ["location", "cause", "eta_driver", "connection", "anything_else"] },
  KEYS_ACCESS: { slots: ["question", "site", "contact_on_site", "anything_else"] },
  EXPENSE: { slots: ["expense_item", "amount", "receipt", "anything_else"] },
  OTHER_QUESTION: { slots: ["question", "anything_else"] },
}

/** In an emergency, keep the call minimal: safety facts only. */
const EMERGENCY_SLOTS = ["hazard", "injuries", "safe_place", "location"]

export const MAX_QUESTIONS: Record<Urgency, number> = { EMERGENCY: 3, URGENT: 6, ROUTINE: 3 }

export function checklistFor(urgency: Urgency | null, situation: Situation | null): string[] {
  if (urgency === "EMERGENCY") return EMERGENCY_SLOTS
  return CHECKLISTS[situation ?? "OTHER_QUESTION"].slots
}

export function slotLabel(key: string): string {
  return SLOT_DEFS[key]?.label ?? key.replace(/_/g, " ")
}
