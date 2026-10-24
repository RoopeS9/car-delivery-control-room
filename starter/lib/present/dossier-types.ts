// Shapes of the chart dossier, shared by the presenter and the browser.

import type { Tone } from "./types"

export type Strength =
  | "verified" | "recorded" | "booked" | "quote" | "claim" | "signal" | "simulated" | "planned" | "agent" | "decision" | "unverified" | "missed"

export const STRENGTH_LABEL: Record<Strength, string> = {
  verified: "Verified", recorded: "Recorded", booked: "Booked", quote: "Quote", claim: "Claim", signal: "Signal",
  simulated: "Simulated", planned: "Planned", agent: "Agent check", decision: "Decision", unverified: "Unverified", missed: "Missed",
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
  /** Calls only: the recorded turns, folded by default. */
  turns?: { speaker: string; text: string; at: string }[]
  href?: string
}

export type StripPoint = { label: string; place: string; state: "done" | "now" | "planned" | "unverified" | "missed"; note: string | null }

export type DossierView = {
  orderId: string
  reference: string
  vehicle: string
  make: string | null
  plate: string | null
  year: number | null
  customer: string
  customerNote: string | null
  driver: string | null
  from: string
  to: string
  laneLabel: string
  headline: string
  intro: string
  tone: Tone
  simNow: string
  position: { label: string; ageLabel: string | null; stale: boolean; speedKmh: number | null } | null
  eta: { at: string; text: string; strength: Strength; source: string } | null
  promise: { at: string; text: string; source: string; late: boolean } | null
  decision: { title: string; ask: string | null; sinceLabel: string | null; href: string } | null
  strip: StripPoint[]
  ahead: DossierItem[]
  behind: DossierItem[]
}

