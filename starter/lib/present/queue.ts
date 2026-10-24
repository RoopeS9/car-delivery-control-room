// "Needs you": one queue for every order that needs a person (PLAN.md 4.7).
// One row per order. Our road and driver cases carry the agent's work; other
// orders show the starter's recorded reasons, labelled "From the records" so
// they never pretend an agent analysed them.

import type { CaseRow, ProposalRow } from "@/lib/cr/queries"
import { OPEN_CASE_STATUSES } from "@/lib/cr/types"
import { changedTiming, deriveAttention } from "./attention"
import type { Bundle } from "./bundle"
import { CASE_KIND_LABELS, caseStatusLabel, ownerName, plainText, statusIs, urgencyLabel, urgencyRank, urgencyTone } from "./cases"
import { label } from "./labels"
import { fmtClock, isBefore, relativeTo } from "./time"
import type { AttentionItem, AttentionKind, QueueRow, QueueView, Tone } from "./types"

/** Where a recorded reason comes from, in words. */
const SOURCE: Record<AttentionKind, string> = {
  alert: "Alert", owned_alert: "Alert, acknowledged", work: "Work item", incident: "Incident", waiting: "Conversation",
  conversation: "Conversation", proposal: "Earlier agent proposal", claim: "Address claim", custody: "Custody record",
  check: "Check on the records", inbox: "Support inbox", decision: "Road agent", case: "Road agent",
}

/** Records rows rank beside agent rows: a danger reason weighs like an urgent case. */
const TONE_RANK: Record<Tone, number> = { danger: 1, warn: 2, accent: 3, neutral: 4, ok: 5 }

function age(at: string | null, now: string, verb: string): string {
  const rel = relativeTo(at, now)
  if (!rel) return ""
  return rel.text === "now" ? `${verb} just now` : `${verb} ${rel.text}`
}

function nextCheck(at: string | null, now: string): { label: string | null; overdue: boolean } {
  if (!at) return { label: null, overdue: false }
  const rel = relativeTo(at, now)
  const overdue = isBefore(at, now)
  return { label: overdue ? `check was due ${fmtClock(at)}${rel ? ` (${rel.text})` : ""}` : `next check ${fmtClock(at)}${rel ? ` (${rel.text})` : ""}`, overdue }
}

function base(bundle: Bundle) {
  const primary = bundle.items.find((item) => item.role === "PRIMARY") ?? bundle.items[0] ?? null
  const from = bundle.places.get(bundle.order.pickupAddressId)
  const to = bundle.places.get(bundle.order.deliveryAddressId)
  return {
    orderId: bundle.order.id, reference: bundle.order.reference,
    vehicle: primary ? `${primary.vehicle.make} ${primary.vehicle.model}` : "Vehicle not linked",
    vehicleMake: primary?.vehicle.make ?? null,
    route: `${from?.city ?? "Unknown"} → ${to?.city ?? "Unknown"}`,
    customer: bundle.customer.name,
  }
}

type Placed = { section: "decide" | "routine" | "agentWorking" | "waiting" | "handled"; row: QueueRow }

function caseRow(bundle: Bundle, kase: CaseRow, pending: ProposalRow | null, records: AttentionItem[], others: number, now: string): Placed {
  const closed = kase.status === "HANDLED_BY_AGENT" || kase.status === "RESOLVED"
  const check = nextCheck(kase.nextCheckAt ? kase.nextCheckAt.toISOString() : null, now)
  const unknownOutcome = bundle.cr.proposals.find((proposal) => proposal.caseId === kase.id && statusIs(proposal, "UNKNOWN_OUTCOME"))
  const overdue = !closed && !pending && kase.status === "WAITING_EXTERNAL" && check.overdue
  const decide = !!pending || !!unknownOutcome || kase.status === "NEEDS_DECISION" || overdue
  const owner = ownerName(bundle, kase.owner)
  const since = (pending ? pending.createdAt : closed ? kase.resolvedAt ?? kase.updatedAt : kase.updatedAt).toISOString()
  const waitingOn = plainText(bundle, kase.waitingOn)
  const ask = unknownOutcome ? `Outcome unknown: ${unknownOutcome.title}. Check before anything is retried.`
    : pending ? pending.title
    : overdue ? plainText(bundle, kase.nextAction) ?? "Follow up now"
    : kase.status === "NEEDS_DECISION" ? plainText(bundle, kase.nextAction) ?? "The agent handed this over"
    : closed ? kase.summary || null
    : plainText(bundle, kase.nextAction)
  // Records the case took over are part of this row, not extra work (PLAN 4.1, linked records).
  const linked = new Set(kase.linkedRecords.map((ref) => ref.id))
  const unlinked = records.filter((item) => !linked.has(item.recordId))
  const extra = [
    CASE_KIND_LABELS[kase.kind] ?? label(kase.kind),
    linked.size ? `takes over ${linked.size} record${linked.size > 1 ? "s" : ""}` : null,
    others ? `${others} more open case${others > 1 ? "s" : ""}` : null,
    unlinked.length ? `${unlinked.length} other item${unlinked.length > 1 ? "s" : ""} in the records` : null,
  ].filter(Boolean).join(" · ")
  const tone: Tone = decide ? (overdue ? "warn" : unknownOutcome ? "danger" : urgencyTone(kase.urgency)) : kase.status === "AGENT_WORKING" ? "accent" : closed ? "ok" : "neutral"
  const row: QueueRow = {
    ...base(bundle), origin: "agent", caseId: kase.id, headline: kase.title, ask,
    tone, rank: urgencyRank(kase.urgency) - (unknownOutcome ? 1 : 0),
    urgencyLabel: urgencyLabel(kase.urgency),
    statusLabel: unknownOutcome ? "Outcome unknown" : pending ? "Decision waiting" : overdue ? "Overdue" : plainText(bundle, caseStatusLabel(kase)),
    who: decide ? "Waiting for you" : owner ?? (closed ? "Road agent" : "Owner not recorded"),
    whoKind: decide ? "person" : owner === "Road agent" ? "agent" : owner ? "person" : "nobody",
    since, sinceLabel: pending ? age(since, now, "waiting").replace(/ ago$/, "") : closed ? age(since, now, "closed") : age(since, now, "updated"),
    reasons: [], waitingOn, nextCheckAt: kase.nextCheckAt ? kase.nextCheckAt.toISOString() : null, nextCheckLabel: check.label, overdue,
    more: extra,
  }
  return { section: closed ? "handled" : decide ? "decide" : kase.status === "AGENT_WORKING" ? "agentWorking" : "waiting", row }
}

function recordsRow(bundle: Bundle, items: AttentionItem[], now: string): Placed {
  const top = items[0]
  const waitingOnly = items.every((item) => item.kind === "waiting")
  const check = waitingOnly ? nextCheck(top.at, now) : { label: null, overdue: false }
  const toneRank = Math.min(...items.map((item) => TONE_RANK[item.tone]))
  const tone = items.reduce<Tone>((best, item) => TONE_RANK[item.tone] < TONE_RANK[best] ? item.tone : best, "ok")
  const owner = items.find((item) => item.owner)?.owner ?? null
  const waitingOn = waitingOnly ? top.title.replace(/^Waiting on /, "") : null
  const row: QueueRow = {
    ...base(bundle), origin: "records", caseId: null,
    headline: top.title, ask: top.detail,
    tone: check.overdue ? "warn" : tone, rank: check.overdue ? 2 : toneRank,
    urgencyLabel: null, statusLabel: check.overdue ? "Overdue" : waitingOnly ? top.title : "From the records",
    who: owner ?? "Owner not recorded", whoKind: owner ? "person" : "nobody",
    since: top.at, sinceLabel: top.at && top.atLabel ? `${top.atLabel} ${relativeTo(top.at, now)?.text ?? ""}`.trim() : "",
    reasons: items.slice(0, 3).map((item) => ({ text: item.title, detail: item.detail, source: SOURCE[item.kind] ?? label(item.kind), href: `/orders/${bundle.order.id}#${item.section}` })),
    waitingOn, nextCheckAt: waitingOnly ? top.at : null, nextCheckLabel: check.label, overdue: check.overdue,
    more: items.length > 3 ? `${items.length - 3} more in the records` : null,
  }
  const section = check.overdue ? "decide" : waitingOnly ? "waiting" : TONE_RANK[tone] <= TONE_RANK.accent ? "decide" : "routine"
  return { section, row }
}

export function buildQueue(bundles: Bundle[], snapshotAt: string | null, now: string): QueueView {
  const view: QueueView = { snapshotAt, simNow: now, decide: [], routine: [], agentWorking: [], waiting: [], handled: [], quietCount: 0, total: bundles.length }
  for (const bundle of bundles) {
    const attention = deriveAttention(bundle)
    const records = attention.filter((item) => item.kind !== "decision" && item.kind !== "case")
    const open = bundle.cr.cases.filter((kase) => OPEN_CASE_STATUSES.includes(kase.status))
    const pendingFor = (kase: CaseRow) => bundle.cr.proposals.find((proposal) => proposal.caseId === kase.id && proposal.status === "PENDING") ?? null
    if (open.length) {
      // One row per order: the most pressing open case speaks for it.
      const placed = open.map((kase) => caseRow(bundle, kase, pendingFor(kase), records, open.length - 1, now))
      const order = { decide: 0, agentWorking: 1, waiting: 2, routine: 3, handled: 4 }
      placed.sort((a, b) => order[a.section] - order[b.section] || a.row.rank - b.row.rank)
      let primary = placed[0]
      // A road case does not take over unrelated dispatch, document or support
      // work. Such a decision must not disappear into the Waiting section.
      const linked = new Set(open.flatMap((kase) => kase.linkedRecords.map((ref) => ref.id)))
      const unlinked = records.filter((item) => !linked.has(item.recordId))
      const recorded = unlinked.length ? recordsRow(bundle, unlinked, now) : null
      if (recorded?.section === "decide" && (primary.section !== "decide" || recorded.row.rank < primary.row.rank)) {
        recorded.row.more = `${primary.row.statusLabel}: ${primary.row.headline}${recorded.row.more ? ` · ${recorded.row.more}` : ""}`
        primary = recorded
      }
      view[primary.section].push(primary.row)
    } else if (records.length) {
      const placed = recordsRow(bundle, records, now)
      view[placed.section].push(placed.row)
    } else {
      view.quietCount += 1
    }
    for (const kase of bundle.cr.cases) {
      if (kase.status === "HANDLED_BY_AGENT" || kase.status === "RESOLVED") view.handled.push(caseRow(bundle, kase, null, [], 0, now).row)
    }
  }
  const urgentFirst = (a: QueueRow, b: QueueRow) =>
    a.rank - b.rank || Number(b.origin === "agent") - Number(a.origin === "agent") || String(a.since ?? "~").localeCompare(String(b.since ?? "~"))
  const newestFirst = (a: QueueRow, b: QueueRow) => String(b.since).localeCompare(String(a.since))
  const soonestCheck = (a: QueueRow, b: QueueRow) => String(a.nextCheckAt ?? "~").localeCompare(String(b.nextCheckAt ?? "~"))
  const byId = new Map(bundles.map((bundle) => [bundle.order.id, bundle]))
  for (const row of [...view.decide, ...view.routine, ...view.agentWorking, ...view.waiting, ...view.handled]) {
    const bundle = byId.get(row.orderId)
    const timing = bundle ? changedTiming(bundle) : null
    if (timing) row.more = [row.more, timing].filter(Boolean).join(" · ")
  }
  // Decisions read in the order they were raised, the earliest at the top (the team's call: a queue, not a ranking).
  const earliestFirst = (a: QueueRow, b: QueueRow) => String(a.since ?? "~").localeCompare(String(b.since ?? "~")) || a.rank - b.rank
  view.decide.sort(earliestFirst)
  view.routine.sort(urgentFirst)
  view.agentWorking.sort(newestFirst)
  view.waiting.sort(soonestCheck)
  view.handled.sort(newestFirst)
  return view
}
