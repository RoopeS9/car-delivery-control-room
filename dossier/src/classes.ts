// Information classes of a delivery dossier: what each holds, when it usually arrives, what it helps decide,
// and whether any of it may be excerpted into a voice call card. Every dataset collection maps to exactly one class.
import { z } from "zod"
import type { CollectionName } from "./records.generated"

/** Where an order is in its life. Derived from records, never stored by hand (see build.ts derivePhase). */
export const Phase = z.enum(["INTAKE", "READINESS", "MARKET", "BOOKED", "PICKUP_DUE", "MOVING", "DELIVERY_DUE", "AFTER", "CANCELLED"])
export type Phase = z.infer<typeof Phase>

/** Decisions and chores the dossier exists to support. */
export const Decision = z.enum([
  "INPUT_COMPLETE",        // is the order fully specified (vehicle identity, addresses, contacts)
  "READY_TO_OFFER",        // are pickup facts strong enough to publish work to drivers
  "DISPATCH",              // offer price, visibility, who is booked, backup driver
  "PICKUP_GO",             // send the driver: car present, keys, releaser, papers, slot
  "TRAVEL_FEASIBLE",       // positioning travel and ferry: booked vs quoted, cutoffs, rest
  "PROMISE_RISK",          // will the delivery promise hold; who must approve a change
  "ON_ROAD_RECOVERY",      // warning light, breakdown, accident, safe stop
  "HANDOVER_COMPLETE",     // keys, signed handover, receiver authority, proofs
  "MONEY_REVIEW",          // expenses, payout on cancellation, invoice questions
  "CUSTOMER_UPDATE",       // what can be told to the customer as fact (always a human or approved draft)
  "CALL_DUE",              // which robo-call check is due now, to whom, to extract what
])
export type Decision = z.infer<typeof Decision>

export const ClassId = z.enum([
  "ORDER_CORE", "ENDPOINTS", "WINDOWS", "ROUTE", "MARKET", "ASSIGNMENT", "TRAVEL", "MOVEMENT",
  "CUSTODY", "EVIDENCE", "MONEY", "SIGNALS", "CONVERSATIONS", "AGENT_WORK", "HISTORY", "DIRECTORY",
  // Live classes: produced by our pipeline, not by the dataset (schemas in live.ts).
  "CALLS", "TELEMETRY", "OPERATOR",
])
export type ClassId = z.infer<typeof ClassId>
export type DatasetClassId = Exclude<ClassId, "CALLS" | "TELEMETRY" | "OPERATOR">

/** Every collection belongs to exactly one class. `satisfies` makes a missing or extra collection a compile error. */
export const COLLECTION_CLASS = {
  orders: "ORDER_CORE", order_items: "ORDER_CORE", vehicles: "ORDER_CORE", customers: "ORDER_CORE",
  addresses: "ENDPOINTS", sites: "ENDPOINTS", order_endpoint_details: "ENDPOINTS", endpoint_claims: "ENDPOINTS",
  time_windows: "WINDOWS",
  transport_plans: "ROUTE", transport_points: "ROUTE", transport_segments: "ROUTE",
  market_offers: "MARKET", market_offer_exposures: "MARKET", market_offer_reach_checks: "MARKET",
  market_offer_demand_signals: "MARKET", market_offer_demand_windows: "MARKET",
  work_assignments: "ASSIGNMENT", assignment_steps: "ASSIGNMENT", drivers: "ASSIGNMENT",
  travel_options: "TRAVEL", travel_reservations: "TRAVEL", travel_confirmations: "TRAVEL",
  ferry_terminals: "TRAVEL", terminal_road_estimates: "TRAVEL", ferry_terminal_events: "TRAVEL",
  tracking_observations: "MOVEMENT", custody_reports: "MOVEMENT",
  custody_assets: "CUSTODY", custody_asset_events: "CUSTODY",
  proofs: "EVIDENCE", documents: "EVIDENCE", site_visits: "EVIDENCE",
  expenses: "MONEY",
  alerts: "SIGNALS", incidents: "SIGNALS", work_items: "SIGNALS",
  conversations: "CONVERSATIONS", messages: "CONVERSATIONS", support_inbox_threads: "CONVERSATIONS",
  support_inbox_messages: "CONVERSATIONS", order_notes: "CONVERSATIONS",
  agent_proposals: "AGENT_WORK", internal_notifications: "AGENT_WORK",
  operational_events: "HISTORY",
  operators: "DIRECTORY", agents: "DIRECTORY",
} as const satisfies Record<CollectionName, DatasetClassId>

/** May facts from this class appear in a voice call card, and for whom. Customers are never called. */
export const VoiceUse = z.enum(["NEVER", "DRIVER_ONLY", "SITE_AND_DRIVER"])
export type VoiceUse = z.infer<typeof VoiceUse>

export type ClassSpec = {
  title: string
  holds: string
  arrives: { phase: Phase; when: string }[]
  aids: Decision[]
  voice: VoiceUse
}

export const CLASSES: Record<ClassId, ClassSpec> = {
  ORDER_CORE: {
    title: "Order, vehicle and customer", holds: "What was ordered, by whom, for which car (VIN, plate, fuel), trade-in items.",
    arrives: [{ phase: "INTAKE", when: "order created via portal, API or import" }, { phase: "INTAKE", when: "missing identity supplied later" }],
    aids: ["INPUT_COMPLETE", "CUSTOMER_UPDATE", "CALL_DUE"], voice: "SITE_AND_DRIVER",
  },
  ENDPOINTS: {
    title: "Pickup and delivery endpoints", holds: "Addresses, site profiles with hours and rules, order-specific contact and access state, attributed claims about them.",
    arrives: [{ phase: "INTAKE", when: "addresses and site profile on creation" }, { phase: "READINESS", when: "contact and access confirmed, or claims recorded" },
      { phase: "PICKUP_DUE", when: "site replies and driver reports at the gate" }, { phase: "DELIVERY_DUE", when: "receiver named or corrected" }],
    aids: ["INPUT_COMPLETE", "READY_TO_OFFER", "PICKUP_GO", "HANDOVER_COMPLETE", "CALL_DUE"], voice: "SITE_AND_DRIVER",
  },
  WINDOWS: {
    title: "Time windows", holds: "Availability, requested slots, selected pickup slot, delivery promise with deadline, each with who set it.",
    arrives: [{ phase: "INTAKE", when: "availability and requests from the customer" }, { phase: "READINESS", when: "Ops selects a pickup slot" },
      { phase: "MOVING", when: "promise revised (needs the customer)" }],
    aids: ["READY_TO_OFFER", "PICKUP_GO", "PROMISE_RISK", "CALL_DUE"], voice: "SITE_AND_DRIVER",
  },
  ROUTE: {
    title: "Route plan", holds: "Active and replaced plans, ordered points (incl. transfer yards and terminals), segments per item.",
    arrives: [{ phase: "INTAKE", when: "draft plan" }, { phase: "READINESS", when: "plan activated" }, { phase: "BOOKED", when: "plan replaced after a change" }],
    aids: ["DISPATCH", "TRAVEL_FEASIBLE", "PROMISE_RISK"], voice: "DRIVER_ONLY",
  },
  MARKET: {
    title: "Driver market", holds: "Offers and their lines, directed exposures, reach checks, view and pass signals.",
    arrives: [{ phase: "MARKET", when: "offer published, viewed, passed, repriced, withdrawn" }, { phase: "BOOKED", when: "offer accepted" }],
    aids: ["DISPATCH"], voice: "NEVER",
  },
  ASSIGNMENT: {
    title: "Driver assignment", holds: "Who is booked, previous duty and positioning, planned and completed steps, the driver profile.",
    arrives: [{ phase: "BOOKED", when: "offer accepted or directed booking" }, { phase: "PICKUP_DUE", when: "assignment started" },
      { phase: "MOVING", when: "steps completed" }, { phase: "AFTER", when: "assignment completed" }],
    aids: ["DISPATCH", "PICKUP_GO", "TRAVEL_FEASIBLE", "CALL_DUE"], voice: "DRIVER_ONLY",
  },
  TRAVEL: {
    title: "Travel and ferries", holds: "Quotes (never bookings), reservations, driver travel reports, terminals, road estimates, gate scans.",
    arrives: [{ phase: "BOOKED", when: "positioning quoted then booked" }, { phase: "MOVING", when: "ferry check-in, gate scan, rebooking" }],
    aids: ["TRAVEL_FEASIBLE", "PROMISE_RISK", "MONEY_REVIEW", "CALL_DUE"], voice: "DRIVER_ONLY",
  },
  MOVEMENT: {
    title: "Movement", holds: "Coarse app progress and ETA with observed vs received time, driver custody reports overnight.",
    arrives: [{ phase: "MOVING", when: "driver app uploads, possibly late or in batches" }, { phase: "MOVING", when: "driver reports rest stop" }],
    aids: ["PROMISE_RISK", "ON_ROAD_RECOVERY", "CALL_DUE"], voice: "DRIVER_ONLY",
  },
  CUSTODY: {
    title: "Keys and papers custody", holds: "Key sets, plate papers, paper CMR: current holder claim and the chain of reported events.",
    arrives: [{ phase: "BOOKED", when: "custody question raised" }, { phase: "PICKUP_DUE", when: "keys collected or not" }, { phase: "DELIVERY_DUE", when: "keys handed over" }],
    aids: ["PICKUP_GO", "HANDOVER_COMPLETE", "CALL_DUE"], voice: "SITE_AND_DRIVER",
  },
  EVIDENCE: {
    title: "Proofs, documents and site visits", holds: "Required/submitted/approved proofs, CMR and release documents, pickup attempts.",
    arrives: [{ phase: "READINESS", when: "release document requested" }, { phase: "PICKUP_DUE", when: "pickup photos, visit outcome" },
      { phase: "DELIVERY_DUE", when: "delivery photos, signed handover" }, { phase: "AFTER", when: "review outcome" }],
    aids: ["READY_TO_OFFER", "PICKUP_GO", "HANDOVER_COMPLETE", "CALL_DUE"], voice: "SITE_AND_DRIVER",
  },
  MONEY: {
    title: "Costs", holds: "Expense claims and central receipts with review state; amounts in minor units per currency.",
    arrives: [{ phase: "MOVING", when: "driver submits a cost" }, { phase: "AFTER", when: "review and corrections" }],
    aids: ["MONEY_REVIEW"], voice: "DRIVER_ONLY",
  },
  SIGNALS: {
    title: "Signals and owned work", holds: "Alerts (signals, not diagnoses), incidents, the work-item queue with owners and due times.",
    arrives: [{ phase: "READINESS", when: "readiness checks opened" }, { phase: "MOVING", when: "monitoring raises a signal" }, { phase: "AFTER", when: "condition claims" }],
    aids: ["PROMISE_RISK", "ON_ROAD_RECOVERY", "PICKUP_GO", "HANDOVER_COMPLETE", "CALL_DUE"], voice: "NEVER",
  },
  CONVERSATIONS: {
    title: "Conversations", holds: "Threads and messages with sender, recipient, channel, visibility, language; support inbox (linked or candidate); notes.",
    arrives: [{ phase: "INTAKE", when: "support mail before an order link is certain" }, { phase: "READINESS", when: "customer and site exchanges" },
      { phase: "MOVING", when: "driver chat" }, { phase: "AFTER", when: "proof and invoice questions" }],
    aids: ["INPUT_COMPLETE", "PICKUP_GO", "PROMISE_RISK", "HANDOVER_COMPLETE", "CUSTOMER_UPDATE", "CALL_DUE"], voice: "DRIVER_ONLY",
  },
  AGENT_WORK: {
    title: "Agent proposals and room activity", holds: "Proposals with evidence, dependency, review and execution; internal room posts.",
    arrives: [{ phase: "READINESS", when: "agents propose" }, { phase: "MOVING", when: "monitor proposes, operators review" }],
    aids: ["DISPATCH", "TRAVEL_FEASIBLE", "PROMISE_RISK", "ON_ROAD_RECOVERY"], voice: "NEVER",
  },
  HISTORY: {
    title: "Event history", holds: "Append-only lifecycle changes and recorded decisions: who did what to which record, from which state.",
    arrives: [{ phase: "INTAKE", when: "every lifecycle change from creation on" }],
    aids: ["CUSTOMER_UPDATE", "PROMISE_RISK", "HANDOVER_COMPLETE"], voice: "NEVER",
  },
  DIRECTORY: {
    title: "Directory", holds: "Operators and automated agents referenced by the records, for names and desks.",
    arrives: [{ phase: "INTAKE", when: "reference data" }], aids: [], voice: "NEVER",
  },
  CALLS: {
    title: "Robo-calls", holds: "Each call: the brief it was given, transcript turns, extracted slots citing turns, outcome, tone review.",
    arrives: [{ phase: "READINESS", when: "pickup readiness call" }, { phase: "BOOKED", when: "driver start check" },
      { phase: "MOVING", when: "position, ferry and driver support calls" }, { phase: "DELIVERY_DUE", when: "non-customer receiver confirmation" }],
    aids: ["PICKUP_GO", "TRAVEL_FEASIBLE", "PROMISE_RISK", "ON_ROAD_RECOVERY", "CALL_DUE"], voice: "SITE_AND_DRIVER",
  },
  TELEMETRY: {
    title: "Telemetry", holds: "Phone GPS fixes and OBD2 readings (PIDs, warning lamp, trouble codes with freeze frame), each marked simulated or not.",
    arrives: [{ phase: "MOVING", when: "continuous while the car moves" }], aids: ["PROMISE_RISK", "ON_ROAD_RECOVERY", "CALL_DUE"], voice: "DRIVER_ONLY",
  },
  OPERATOR: {
    title: "Operator actions", holds: "Decisions, notes, call requests and overrides by people in operations.",
    arrives: [{ phase: "INTAKE", when: "any time a person acts" }], aids: ["CUSTOMER_UPDATE", "CALL_DUE"], voice: "NEVER",
  },
}
