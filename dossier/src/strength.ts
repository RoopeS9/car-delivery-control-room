// How much a record can be relied on, and its primary time. One typed rule per collection: adding a
// collection to the dataset without a rule here is a compile error.
//
// The ladder encodes the packet's own distinctions (README "Read the world", SCHEMA.md):
// a quote is not a booking, a booking is not a gate scan, a SYSTEM or OPS window is not customer approval,
// a message is an attributed claim, an alert is a signal, a proposal is not a change.
import { z } from "zod"
import type { RECORDS, CollectionName } from "./records.generated"

export const Strength = z.enum([
  "REFERENCE",   // profile or master data: a site's standard rules, a driver profile, a terminal
  "REQUEST",     // what someone asked for: customer availability or a requested slot
  "PLAN",        // what we intend: a plan, a selected slot by Ops, a scheduled step, an open requirement, a published offer
  "QUOTE",       // a travel option observed at a time; may be gone now
  "BOOKING",     // a reservation or an accepted assignment; not proof anything physically happened
  "COMMITMENT",  // a promise the customer agreed to
  "CLAIM",       // an attributed statement: a message, a driver report, a submitted proof, a phone answer
  "OBSERVATION", // a device or system observation: app progress, a pickup attempt, a demand signal
  "VERIFIED",    // checked by an authority for this order: approved proof, verified document, gate check-in scan, site-confirmed detail
  "REJECTED",    // checked and refuted: rejected proof, rejected gate scan, refuted claim
  "DECISION",    // a recorded decision by an operator, customer or system rule
  "SIGNAL",      // a reason to look, not a diagnosis: alert, incident, work item, room post
  "PROPOSAL",    // an agent suggestion; never a change by itself
  "RECORD",      // an append-only history entry
])
export type Strength = z.infer<typeof Strength>

export type RecordOf<C extends CollectionName> = z.infer<(typeof RECORDS)[C]>
type Rule<C extends CollectionName> = { strength: (r: RecordOf<C>) => Strength; at: (r: RecordOf<C>) => string | null }
type Rules = { [C in CollectionName]: Rule<C> }

const fixed = <C extends CollectionName>(s: Strength, at: (r: RecordOf<C>) => string | null): Rule<C> => ({ strength: () => s, at })

export const RULES: Rules = {
  orders: fixed("RECORD", (r) => r.created_at),
  order_items: fixed("RECORD", () => null),
  vehicles: fixed("REFERENCE", () => null),
  customers: fixed("REFERENCE", () => null),
  addresses: fixed("REFERENCE", () => null),
  sites: fixed("REFERENCE", () => null),
  order_endpoint_details: {
    // A site-profile confirmation is the standard procedure, not a call about this car (SCHEMA.md).
    strength: (r) => r.contact_status === "CONFIRMED" && r.access_status === "CONFIRMED"
      ? (r.last_confirmed_source === "MANAGED_SITE_PROFILE" || r.last_confirmed_source == null ? "REFERENCE" : "VERIFIED")
      : "CLAIM",
    at: (r) => r.last_confirmed_at ?? r.stated_at,
  },
  endpoint_claims: {
    strength: (r) => r.resolution_status === "VERIFIED" ? "VERIFIED" : r.resolution_status === "REJECTED_BY_DIRECT_CHECK" ? "REJECTED" : "CLAIM",
    at: (r) => r.recorded_at,
  },
  time_windows: {
    // A SYSTEM-calculated target or OPS selection is not evidence of customer approval (README).
    strength: (r) => r.purpose === "CUSTOMER_DELIVERY_PROMISE"
      ? (r.source === "CUSTOMER" ? "COMMITMENT" : "PLAN")
      : r.purpose === "REQUESTED_PICKUP_SLOT" || r.purpose === "REQUESTED_DELIVERY_SLOT" || r.purpose === "PICKUP_AVAILABILITY" ? "REQUEST" : "PLAN",
    at: (r) => r.start_at,
  },
  transport_plans: { strength: (r) => (r.status === "COMPLETED" ? "RECORD" : "PLAN"), at: (r) => r.activated_at ?? r.created_at },
  transport_points: fixed("PLAN", () => null),
  transport_segments: fixed("PLAN", () => null),
  market_offers: { strength: (r) => (r.status === "ACCEPTED" ? "BOOKING" : "PLAN"), at: (r) => r.published_at },
  market_offer_exposures: fixed("OBSERVATION", (r) => r.shown_at),
  market_offer_reach_checks: fixed("OBSERVATION", (r) => r.checked_at),
  market_offer_demand_signals: fixed("OBSERVATION", (r) => r.observed_at),
  market_offer_demand_windows: fixed("OBSERVATION", (r) => r.window_start_at),
  work_assignments: {
    strength: (r) => (r.status === "COMPLETED" ? "RECORD" : r.status === "CANCELLED" ? "DECISION" : "BOOKING"),
    at: (r) => r.accepted_at,
  },
  assignment_steps: {
    // A PLANNED step can cite a purchased ticket without proving travel occurred (SCHEMA.md).
    strength: (r) => (r.status === "COMPLETED" && r.evidence_id ? "OBSERVATION" : r.status === "UNVERIFIED" ? "CLAIM" : "PLAN"),
    at: (r) => r.completed_at ?? r.scheduled_start_at,
  },
  drivers: fixed("REFERENCE", () => null),
  travel_options: fixed("QUOTE", (r) => r.checked_at),
  travel_reservations: {
    strength: (r) => (r.check_in_confirmation === "CONFIRMED_BY_GATE_SCAN" ? "VERIFIED"
      : r.check_in_confirmation === "REJECTED_BY_GATE_SCAN" ? "REJECTED" : "BOOKING"),
    at: (r) => r.departure_at,
  },
  travel_confirmations: fixed("CLAIM", (r) => r.reported_at),
  ferry_terminals: fixed("REFERENCE", () => null),
  terminal_road_estimates: fixed("REFERENCE", () => null),
  // Only a gate observation can confirm or reject check-in (README).
  ferry_terminal_events: { strength: (r) => (r.kind === "CHECK_IN_ACCEPTED" ? "VERIFIED" : "REJECTED"), at: (r) => r.occurred_at },
  tracking_observations: fixed("OBSERVATION", (r) => r.observed_at),
  custody_reports: fixed("CLAIM", (r) => r.reported_at),
  custody_assets: fixed("CLAIM", (r) => r.followup_due_at),
  custody_asset_events: fixed("CLAIM", (r) => r.occurred_at),
  proofs: {
    strength: (r) => (r.status === "APPROVED" ? "VERIFIED" : r.status === "REJECTED" ? "REJECTED" : r.status === "SUBMITTED" ? "CLAIM" : "PLAN"),
    at: (r) => r.reviewed_at ?? r.submitted_at ?? r.required_by ?? null,
  },
  documents: {
    strength: (r) => (r.status === "VERIFIED" ? "VERIFIED" : r.status === "SIGNED" ? "CLAIM" : "PLAN"),
    at: (r) => r.updated_at,
  },
  site_visits: fixed("OBSERVATION", (r) => r.arrived_at),
  expenses: {
    strength: (r) => (r.status === "APPROVED" || r.status === "REJECTED" || r.status === "SUPERSEDED" ? "DECISION" : "CLAIM"),
    at: (r) => r.submitted_at,
  },
  alerts: fixed("SIGNAL", (r) => r.triggered_at),
  incidents: fixed("SIGNAL", (r) => r.opened_at),
  work_items: fixed("SIGNAL", (r) => r.opened_at),
  conversations: fixed("RECORD", (r) => r.updated_at),
  messages: fixed("CLAIM", (r) => r.authored_at),
  support_inbox_threads: fixed("CLAIM", (r) => r.updated_at),
  support_inbox_messages: fixed("CLAIM", (r) => r.authored_at),
  order_notes: fixed("CLAIM", (r) => r.authored_at),
  agent_proposals: fixed("PROPOSAL", (r) => r.created_at),
  internal_notifications: fixed("SIGNAL", (r) => r.occurred_at),
  operational_events: fixed("RECORD", (r) => r.recorded_at),
  operators: fixed("REFERENCE", () => null),
  agents: fixed("REFERENCE", () => null),
}

export function strengthOf<C extends CollectionName>(c: C, r: RecordOf<C>): Strength {
  return (RULES[c] as Rule<C>).strength(r)
}
export function atOf<C extends CollectionName>(c: C, r: RecordOf<C>): string | null {
  return (RULES[c] as Rule<C>).at(r)
}
