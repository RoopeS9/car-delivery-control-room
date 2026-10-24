// Shapes of the chart dossier, shared by the presenter and the browser.

import type { Tone } from "./types"

export type Strength =
  | "verified" | "recorded" | "booked" | "quote" | "claim" | "signal" | "simulated" | "planned" | "agent" | "decision" | "unverified" | "missed"
  | "reference" | "request" | "commitment" | "observation" | "rejected" | "proposal"

export const STRENGTH_LABEL: Record<Strength, string> = {
  verified: "Verified", recorded: "Recorded", booked: "Booked", quote: "Quote", claim: "Claim", signal: "Signal",
  simulated: "Simulated", planned: "Planned", agent: "Agent check", decision: "Decision", unverified: "Unverified", missed: "Missed",
  reference: "Reference", request: "Request", commitment: "Commitment", observation: "Observation", rejected: "Rejected", proposal: "Proposal",
}

export type DossierItem = {
  id: string
  at: string | null
  title: string
  detail: string | null
  kind: "step" | "deadline" | "ferry" | "travel" | "quote" | "call" | "agent" | "message" | "signal" | "event" | "telemetry" | "decision" | "note"
  strength: Strength
  /** Who or what the line comes from: "Leo Quellford, driver app", "Gate reader, West Baltic terminal". */
  source: string
  tone: Tone
  /** The record behind the line, so the dossier service can name its evidence strength. */
  ref?: { collection: string; id: string }
  /** Calls only: the recorded turns, folded by default. */
  turns?: { speaker: string; text: string; at: string }[]
  /** Robo-calls: what the call established, each citing its turn. */
  slots?: { label: string; value: string; quote: string; turn: number }[]
  missing?: string[]
  escalated?: string | null
  href?: string
}

export type StripPoint = { label: string; place: string; state: "done" | "now" | "planned" | "unverified" | "missed"; note: string | null }

/** Something worth watching, derived: a deadline at risk, two facts that disagree, a silent gap, a review under way. */
export type WatchItem = { id: string; text: string; tone: Tone; at: string | null; why: string; sources: string[] }

export type DossierView = {
  orderId: string
  reference: string
  vehicle: string
  make: string | null
  customer: string
  driver: string | null
  from: string
  to: string
  laneLabel: string
  /** The order's local zone; every time in the view is read in it. */
  zone: string | null
  simNow: string
  /** One sentence of state, derived. */
  headline: string
  tone: Tone
  /** The one thing that needs a person, or null for "Nothing needs you". */
  need: { title: string; ask: string | null; since: string | null; sinceLabel: string | null; href: string; chain?: string[] } | null
  /** The car's dongle reports a lamp or trouble codes (simulated); null when there is no fault. */
  fault: { lamp: string | null; codes: { code: string; title: string | null; severity: string | null; tone: Tone }[]; freezeSpeed: string | null; atPickup: string; when: string | null } | null
  strip: StripPoint[]
  /** Where "Open the full order" lands: the conversation that matters. */
  conversationHref: string
  /** At most three. */
  watching: WatchItem[]
  /** The last three things a person did or said, newest first. */
  recent: { id: string; at: string; text: string }[]
  /** Full history: planned steps and deadlines ahead, then what happened, without bookkeeping events. */
  ahead: DossierItem[]
  behind: DossierItem[]
  /** Every record on the order, by class, for the curious. */
  records: { label: string; items: { label: string; at: string | null; when: string | null; strength: string }[] }[]
  recordsFromService: boolean
}
