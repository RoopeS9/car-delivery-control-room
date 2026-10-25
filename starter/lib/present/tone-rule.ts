// One rule for red across Road Desk: red means a decision is waiting for a
// person (an agent's card or hand-over, or an operator item: a work item, an
// incident, a support thread, an agent proposal waiting on review or
// execution). An open alert, a conversation, a claim or a check is a signal
// worth watching: amber.

import type { AttentionItem, Tone } from "./types"

const PERSON_KINDS = new Set<AttentionItem["kind"]>(["decision", "work", "incident", "inbox", "proposal"])

export function needsPersonItem(item: AttentionItem): boolean {
  return PERSON_KINDS.has(item.kind)
}

/** The tone an order's headline takes from its open items: red for a need, amber for something to watch. */
export function attentionTone(items: AttentionItem[], fallback: Tone): Tone {
  if (items.some(needsPersonItem)) return "danger"
  if (items.some((item) => item.kind !== "case")) return fallback === "danger" ? "warn" : fallback === "ok" ? "warn" : fallback
  return fallback === "danger" ? "warn" : fallback
}

/** Road Desk's own cases and cards, which a case panel on the order page already shows in full. */
export function isRoadDeskItem(item: AttentionItem): boolean {
  return item.kind === "decision" || item.kind === "case"
}
