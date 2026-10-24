// The "Needs you" queue: only our road and driver cases (PLAN.md 4.7). Other
// orders that need a person stay on the board, behind one quiet count.

import type { CaseRow, ProposalRow } from "@/lib/cr/queries"
import { deriveAttention } from "./attention"
import type { Bundle } from "./bundle"
import { CASE_KIND_LABELS, caseStatusLabel, ownerName, urgencyLabel, urgencyRank, urgencyTone } from "./cases"
import { label } from "./labels"
import { relativeTo } from "./time"
import type { AttentionKind, QueueRow, QueueView } from "./types"

const OTHER_REASONS: Partial<Record<AttentionKind, string>> = {
  alert: "alerts", owned_alert: "alerts", work: "work items", incident: "incidents", waiting: "waiting threads",
  conversation: "open conversations", proposal: "earlier agent proposals", claim: "address claims",
  custody: "keys and papers", check: "pickup checks", inbox: "support inbox",
}

function age(at: string | null, now: string, verb: string): string {
  const rel = relativeTo(at, now)
  if (!rel) return ""
  return rel.text === "now" ? `${verb} just now` : `${verb} ${rel.text}`
}

function row(bundle: Bundle, kase: CaseRow, pending: ProposalRow | null, now: string): QueueRow {
  const primary = bundle.items.find((item) => item.role === "PRIMARY") ?? bundle.items[0] ?? null
  const from = bundle.places.get(bundle.order.pickupAddressId)
  const to = bundle.places.get(bundle.order.deliveryAddressId)
  const owner = ownerName(bundle, kase.owner)
  const closed = kase.status === "HANDLED_BY_AGENT" || kase.status === "RESOLVED"
  const decide = !!pending || kase.status === "NEEDS_DECISION"
  const since = pending ? pending.createdAt.toISOString() : (closed ? kase.resolvedAt ?? kase.updatedAt : kase.updatedAt).toISOString()
  const ask = pending ? pending.title
    : kase.status === "NEEDS_DECISION" ? (kase.nextStep ?? "The agent handed this over")
    : kase.status === "WAITING_EXTERNAL" ? kase.nextStep ?? null
    : closed ? kase.summary || null
    : kase.nextStep ?? null
  const otherOpen = Math.max(0, bundle.cr.proposals.filter((proposal) => proposal.caseId === kase.id && proposal.status === "PENDING").length - 1)
  return {
    orderId: bundle.order.id, reference: bundle.order.reference,
    vehicle: primary ? `${primary.vehicle.make} ${primary.vehicle.model}` : "Vehicle not linked",
    vehicleMake: primary?.vehicle.make ?? null,
    route: `${from?.city ?? "Unknown"} → ${to?.city ?? "Unknown"}`,
    customer: bundle.customer.name,
    caseId: kase.id,
    headline: kase.title,
    ask,
    tone: decide ? urgencyTone(kase.urgency) : kase.status === "AGENT_WORKING" ? "accent" : closed ? "ok" : "neutral",
    urgency: kase.urgency, urgencyLabel: urgencyLabel(kase.urgency),
    statusLabel: pending ? "Decision waiting" : caseStatusLabel(kase),
    who: decide ? "Waiting for you" : owner ?? (closed ? "Road agent" : "No owner recorded"),
    whoKind: decide ? "person" : owner === "Road agent" || kase.owner === "agent" ? "agent" : owner ? "person" : "nobody",
    since,
    sinceLabel: pending ? age(since, now, "waiting").replace(/ ago$/, "") : closed ? age(since, now, "closed") : age(since, now, "updated"),
    more: [CASE_KIND_LABELS[kase.kind] ?? label(kase.kind), otherOpen ? `${otherOpen} more decision${otherOpen > 1 ? "s" : ""}` : null].filter(Boolean).join(" · "),
  }
}

export function buildQueue(bundles: Bundle[], snapshotAt: string | null, now: string): QueueView {
  const decide: QueueRow[] = []
  const agentWorking: QueueRow[] = []
  const waiting: QueueRow[] = []
  const handled: QueueRow[] = []
  const reasons = new Map<string, number>()
  let otherCount = 0

  for (const bundle of bundles) {
    const open = bundle.cr.cases.filter((kase) => kase.status !== "HANDLED_BY_AGENT" && kase.status !== "RESOLVED")
    for (const kase of bundle.cr.cases) {
      const pending = bundle.cr.proposals.find((proposal) => proposal.caseId === kase.id && proposal.status === "PENDING") ?? null
      const entry = row(bundle, kase, pending, now)
      if (pending || kase.status === "NEEDS_DECISION") decide.push(entry)
      else if (kase.status === "AGENT_WORKING") agentWorking.push(entry)
      else if (kase.status === "WAITING_EXTERNAL") waiting.push(entry)
      else handled.push(entry)
    }
    if (open.length) continue
    // Not ours: count it for the quiet line and remember why it needs a person.
    const attention = deriveAttention(bundle)
    if (!attention.length) continue
    otherCount += 1
    for (const kind of new Set(attention.map((item) => OTHER_REASONS[item.kind]).filter((reason): reason is string => !!reason))) {
      reasons.set(kind, (reasons.get(kind) ?? 0) + 1)
    }
  }

  const byUrgencyThenOldest = (a: QueueRow, b: QueueRow) =>
    urgencyRank(a.urgency) - urgencyRank(b.urgency) || String(a.since).localeCompare(String(b.since))
  const newestFirst = (a: QueueRow, b: QueueRow) => String(b.since).localeCompare(String(a.since))

  return {
    snapshotAt, simNow: now,
    decide: decide.sort(byUrgencyThenOldest),
    agentWorking: agentWorking.sort(newestFirst),
    waiting: waiting.sort(newestFirst),
    handled: handled.sort(newestFirst),
    otherCount,
    otherReasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([reason]) => reason),
    total: bundles.length,
  }
}
