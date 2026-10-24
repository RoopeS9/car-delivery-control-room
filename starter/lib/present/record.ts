// The order record, read out section by section. Every value here points back to
// a record in the API response; the view adds labels, names and grouping.

import { chosenWindows, deriveAttention, deriveKeyDates, latestTracking, strongestTone, windowSource, windowViews } from "./attention"
import {
  type Bundle, type RelatedRow, activePoints, bool, journeyPlan, list, num, obj, recordedAt, refCount, rows, str, strings,
} from "./bundle"
import { describeEvent } from "./events"
import { humanize, label, labelIn, laneLabel } from "./labels"
import { dayKey, fmtDateTime, fmtDay, fmtDayHeading, fmtMoney, fmtRange, fmtWeekday, isBefore, relativeTo } from "./time"
import type {
  AccessView, Actor, AlertView, AssignmentView, AttentionItem, ClaimView, ContactView, CustodyView, DocumentView, ExpenseView, Fact,
  HistoryDay, IncidentView, JourneyGroup, JourneyLeg, JourneyStep, JourneyView, MessageView, NotificationView, OfferView,
  KeyDate, OptionView, Place, ProofView, ProposalView, RecordHeader, RecordView, ReservationView, SiteView, Story, ThreadView, Tile, Tone,
  TrackingView, WorkItemView,
} from "./types"

const PRIMARY_FIRST = (a: { role: string }, b: { role: string }) => (a.role === "PRIMARY" ? -1 : b.role === "PRIMARY" ? 1 : 0)

function toneOf(map: Record<string, Tone>, status: string | null, fallback: Tone = "neutral"): Tone {
  return status ? map[status] ?? fallback : fallback
}

const ASSIGNMENT_TONE: Record<string, Tone> = { IN_PROGRESS: "accent", ASSIGNED: "neutral", COMPLETED: "ok", CANCELLED: "neutral" }
const SEGMENT_TONE: Record<string, Tone> = { IN_PROGRESS: "accent", COMPLETED: "ok", CANCELLED: "neutral" }
const PROOF_TONE: Record<string, Tone> = { APPROVED: "ok", SUBMITTED: "neutral", REQUIRED: "warn", REJECTED: "danger", WAIVED: "neutral" }
const DOCUMENT_TONE: Record<string, Tone> = { VERIFIED: "ok", SIGNED: "ok", PREPARED: "neutral", REQUESTED: "warn", MISSING: "danger" }
const OFFER_TONE: Record<string, Tone> = { PUBLISHED: "accent", ACCEPTED: "ok", WITHDRAWN: "neutral", EXPIRED: "neutral" }
const RESERVATION_TONE: Record<string, Tone> = { BOOKED: "neutral", MISSED_CHECK_IN: "danger", CANCELLED: "neutral" }
const OPTION_TONE: Record<string, Tone> = { AVAILABLE_QUOTE: "neutral", SOLD_OUT: "danger" }
const PROPOSAL_TONE: Record<string, Tone> = { PENDING_REVIEW: "accent", APPROVED_AWAITING_EXECUTION: "accent", EXECUTED: "ok", REJECTED: "neutral", FAILED: "danger" }
const EXPENSE_TONE: Record<string, Tone> = { SUBMITTED: "neutral", APPROVED: "ok", REJECTED: "danger", SUPERSEDED: "neutral" }
const WORK_TONE: Record<string, Tone> = { OPEN: "neutral", NEEDS_EXTERNAL_INPUT: "neutral", IN_PROGRESS: "accent", DONE: "ok" }
const STEP_TONE: Record<string, Tone> = { COMPLETED: "ok", PLANNED: "neutral", UNVERIFIED: "warn", CANCELLED: "neutral" }

function summarise(value: unknown, skip: string[] = []): string | null {
  const row = obj(value)
  if (!row) return null
  const parts = Object.entries(row)
    .filter(([key, item]) => !skip.includes(key) && !/(_id|_ids|_refs)$/.test(key) && (typeof item === "string" || typeof item === "number" || typeof item === "boolean"))
    .map(([key, item]) => `${humanize(key).toLowerCase()}: ${typeof item === "string" ? (/\d{4}-\d{2}-\d{2}T/.test(item) ? fmtDateTime(item) : labelIn(item)) : String(item)}`)
  return parts.length ? parts.join(" · ") : null
}

function placeView(bundle: Bundle, addressId: string | null | undefined): Place {
  const row = addressId ? bundle.places.get(addressId) : undefined
  if (!row) return { name: "Address not linked", addressLine: null, city: "", country: "", kind: null, kindLabel: "", zone: null, siteId: null }
  const kind = str(row.details.kind)
  return {
    name: row.name, addressLine: str(row.details.address_line1), city: row.city, country: row.country,
    kind, kindLabel: label(kind), zone: str(row.details.timezone), siteId: row.managedSiteId,
  }
}

function hoursText(value: unknown): string | null {
  const hours = obj(value)
  if (!hours) return null
  const parts = [
    str(hours.mon_fri) ? `Mon–Fri ${str(hours.mon_fri)}` : null,
    str(hours.sat) ? `Sat ${str(hours.sat)}` : "Sat closed",
    str(hours.sun) ? `Sun ${str(hours.sun)}` : "Sun closed",
  ].filter((part): part is string => !!part)
  return parts.length ? parts.join(" · ") : null
}

function siteView(bundle: Bundle, siteId: string | null | undefined, boundary: string | null): SiteView | null {
  const row = siteId ? bundle.sites.get(siteId) : undefined
  if (!row) return null
  const pickup = boundary !== "DELIVERY"
  return {
    id: row.id, name: row.name, kindLabel: label(row.kind),
    handoverMode: str(row.details.handover_mode) ? humanize(str(row.details.handover_mode)) : null,
    hours: hoursText(row.details.opening_hours),
    advanceNoticeMinutes: num(row.details.advance_notice_minutes),
    accessNote: (pickup ? str(row.details.pickup_access_note) : str(row.details.delivery_access_note)) ?? str(row.details.access_note),
    releaseRule: pickup ? str(row.details.release_document_rule) : null,
    requiresSignedRelease: pickup ? bool(row.details.requires_signed_release) : null,
    contactEmail: pickup ? str(row.details.pickup_contact_email) : null,
  }
}

function contactView(detail: RelatedRow, pending: boolean): ContactView {
  const status = str(detail.details.contact_status) ?? "UNKNOWN"
  const source = str(detail.details.last_confirmed_source)
  return {
    name: str(detail.details.contact_name), handle: str(detail.details.contact_handle), role: str(detail.details.contact_role),
    status, statusLabel: label(status),
    tone: status === "CONFIRMED" ? "ok" : pending ? "warn" : "neutral",
    confirmedAt: str(detail.details.last_confirmed_at), source, sourceLabel: source ? labelIn(source) : null,
  }
}

function accessView(detail: RelatedRow, pending: boolean): AccessView {
  const status = str(detail.details.access_status) ?? "UNKNOWN"
  const statedBy = str(detail.details.stated_by)
  const source = str(detail.details.last_confirmed_source)
  return {
    status, statusLabel: label(status),
    tone: status === "CONFIRMED" ? "ok" : pending ? "warn" : "neutral",
    instruction: str(detail.details.access_instruction),
    statedBy, statedByLabel: statedBy ? labelIn(statedBy) : null,
    confirmedAt: str(detail.details.last_confirmed_at), source, sourceLabel: source ? labelIn(source) : null,
  }
}

function proofViews(bundle: Bundle, pointLabels: Map<string, string>): ProofView[] {
  return rows(bundle, "proofs").map((row) => {
    const status = str(row.details.status) ?? "UNKNOWN"
    const pointId = str(row.details.point_id)
    const migration = list(row.details.migration_history).length
    return {
      id: row.id, kind: str(row.details.kind) ?? "PROOF", kindLabel: label(str(row.details.kind)) || "Proof",
      status, statusLabel: label(status), tone: toneOf(PROOF_TONE, status),
      required: bool(row.details.required) ?? false, fileCount: num(row.details.file_count) ?? 0,
      submittedAt: str(row.details.submitted_at), reviewedAt: str(row.details.reviewed_at),
      pointId, pointLabel: pointId ? pointLabels.get(pointId) ?? null : null,
      note: [str(row.details.rejection_reason), str(row.details.waiver_scope) ? `waiver: ${str(row.details.waiver_scope)}` : null, migration ? "requirement moved from an earlier step" : null].filter(Boolean).join(". ") || null,
    }
  }).sort((a, b) => String(b.submittedAt ?? "").localeCompare(String(a.submittedAt ?? "")))
}

function claimViews(bundle: Bundle, endpointDetailId: string | null): ClaimView[] {
  return rows(bundle, "endpoint_claims")
    .filter((row) => !endpointDetailId || row.details.endpoint_detail_id === endpointDetailId)
    .map((row) => {
      const status = str(row.details.resolution_status) ?? "OPEN"
      const source = str(row.details.source_type)
      return {
        id: row.id, field: label(str(row.details.field)) || "detail", claim: str(row.details.claim) ?? "",
        confidence: str(row.details.confidence) ? labelIn(str(row.details.confidence)) : null,
        status, statusLabel: label(status),
        tone: status === "OPEN" ? "warn" : status === "VERIFIED" ? "ok" : "neutral",
        source: source ? labelIn(source) : null, recordedAt: str(row.details.recorded_at), resolvedAt: str(row.details.resolved_at),
      }
    })
}

function trackingView(row: Record<string, unknown> | undefined): TrackingView | null {
  if (!row) return null
  const quality = str(row.location_quality) ?? "UNKNOWN"
  const source = str(row.source) ?? "unknown"
  return {
    eta: str(row.estimated_delivery_at), remainingKm: num(row.distance_remaining_km), progress: num(row.progress_fraction),
    observedAt: str(row.observed_at), receivedAt: str(row.received_at),
    quality, qualityLabel: labelIn(quality), source, sourceLabel: labelIn(source), note: str(row.context_note),
  }
}

function orderRef(bundle: Bundle, id: string): { id: string; reference: string } {
  return { id, reference: bundle.bundleOrderRefs[id] ?? id }
}

function assignmentView(bundle: Bundle, row: RelatedRow): AssignmentView {
  const { dir } = bundle
  const d = row.details
  const status = str(d.status) ?? "UNKNOWN"
  const positioning = obj(d.positioning)
  const cancellation = bundle.events.find((event) => event.command === "assignment.cancelled" && event.targetId === row.id)
  const cancelChanges = obj(cancellation?.details.changes)
  let positioningText: string | null = null
  if (positioning) {
    const previous = str(positioning.previous_order_id)
    const previousRef = previous ? bundle.bundleOrderRefs[previous] ?? previous : null
    const parts = [
      previousRef ? `Prior duty ${previousRef}${str(positioning.planned_release_city) ? ` releases in ${str(positioning.planned_release_city)}` : ""}` : null,
      str(positioning.earliest_positioning_departure_at) ? `earliest departure ${fmtDateTime(str(positioning.earliest_positioning_departure_at))}` : null,
      str(positioning.assessment) ? `${label(str(positioning.assessment))}${str(positioning.travel_commitment_status) ? ` (${labelIn(str(positioning.travel_commitment_status))})` : ""}` : null,
      str(positioning.driver_report_message_id) ? "the driver's own availability report is linked" : null,
    ].filter(Boolean)
    positioningText = parts.join(" · ") || null
  }
  const steps = rows(bundle, "assignment_steps")
    .filter((step) => step.details.assignment_id === row.id)
    .sort((a, b) => (num(a.details.sequence) ?? 0) - (num(b.details.sequence) ?? 0))
    .map((step) => {
      const stepStatus = str(step.details.status) ?? "PLANNED"
      return {
        id: step.id, sequence: num(step.details.sequence) ?? 0, title: str(step.details.title) ?? label(str(step.details.kind)),
        kind: str(step.details.kind) ?? "STEP", kindLabel: label(str(step.details.kind)), status: stepStatus, statusLabel: label(stepStatus),
        tone: toneOf(STEP_TONE, stepStatus), scheduledStart: str(step.details.scheduled_start_at), scheduledEnd: str(step.details.scheduled_end_at),
        note: str(step.details.note), from: str(step.details.from_city), to: str(step.details.to_city),
      }
    })
  return {
    id: row.id,
    driver: dir.resolve(d.driver_id, "driver"),
    driverHome: dir.driverHome(d.driver_id),
    status, statusLabel: label(status), tone: toneOf(ASSIGNMENT_TONE, status),
    fee: fmtMoney(num(d.fee_cents), str(d.currency) ?? "EUR") || null,
    acceptedAt: str(d.accepted_at), startedAt: str(d.started_at), completedAt: str(d.completed_at), cancelledAt: str(d.cancelled_at),
    cancellation: cancelChanges ? [str(cancelChanges.reason_code) ? labelIn(str(cancelChanges.reason_code)) : null, str(cancelChanges.payout_decision) ? labelIn(str(cancelChanges.payout_decision)) : null].filter(Boolean).join(", ") || null : null,
    positioning: positioningText,
    priorOrder: str(positioning?.previous_order_id) ? orderRef(bundle, str(positioning?.previous_order_id) as string) : null,
    history: summarise(d.driver_history),
    steps,
  }
}

function buildJourney(bundle: Bundle, assignmentsById: Map<string, AssignmentView>, proofs: ProofView[], pending: boolean): JourneyView {
  const plans = rows(bundle, "transport_plans")
  const { plan, active: planActive } = journeyPlan(bundle)
  const planId = plan?.id ?? null
  const points = activePoints(bundle)
  const segments = rows(bundle, "transport_segments")
    .filter((row) => !planId || row.details.plan_id === planId)
    .sort((a, b) => (num(a.details.sequence) ?? 0) - (num(b.details.sequence) ?? 0))
  const endpointDetails = rows(bundle, "order_endpoint_details")
  const windows = windowViews(bundle)
  const observations = rows(bundle, "tracking_observations").map((row) => row.details)
    .sort((a, b) => String(b.observed_at ?? "").localeCompare(String(a.observed_at ?? "")))
  const assignmentRows = rows(bundle, "work_assignments")
  const stepCache = new Map<string, JourneyStep>()

  const stepFor = (pointId: string): JourneyStep | null => {
    const cached = stepCache.get(pointId)
    if (cached) return cached
    const point = points.find((row) => row.id === pointId)
    if (!point) return null
    const role = (str(point.details.role) ?? "PICKUP") as JourneyStep["role"]
    const boundary = str(point.details.order_boundary)
    const place = placeView(bundle, str(point.details.address_id))
    const site = siteView(bundle, str(point.details.site_id) ?? place.siteId, boundary ?? role)
    const detail = endpointDetails.find((row) => row.details.point_id === pointId)
      ?? endpointDetails.find((row) => !str(row.details.point_id) && row.details.boundary === (boundary ?? role)) ?? null
    const stepWindows = windows.filter((window) => window.pointId === pointId)
      .sort((a, b) => windowRank(a.purpose) - windowRank(b.purpose))
    const stepPending = pending && role !== "DELIVERY"
    const picked = recordedAt(bundle, "vehicle.picked_up", pointId)
    const delivered = recordedAt(bundle, "vehicle.delivered", pointId)
    const occurred = (event: typeof picked) => event ? str(obj(event.details.changes)?.occurred_at) ?? event.recordedAt : null
    let recorded: JourneyStep["recorded"] = null
    const notes: string[] = []
    if (role === "TRANSFER") {
      if (delivered) recorded = { label: "Received at the yard", at: occurred(delivered) ?? delivered.recordedAt, actor: bundle.dir.resolve(delivered.details.actor_id, delivered.details.actor_type).name }
      if (picked) {
        const releaseText = `Released from the yard ${fmtDateTime(occurred(picked))}`
        if (recorded) notes.push(releaseText)
        else recorded = { label: "Released from the yard", at: occurred(picked) ?? picked.recordedAt, actor: bundle.dir.resolve(picked.details.actor_id, picked.details.actor_type).name }
      }
    } else if (role === "PICKUP" && picked) {
      recorded = { label: "Picked up", at: occurred(picked) ?? picked.recordedAt, actor: bundle.dir.resolve(picked.details.actor_id, picked.details.actor_type).name }
    } else if (role === "DELIVERY" && delivered) {
      recorded = { label: "Delivered", at: occurred(delivered) ?? delivered.recordedAt, actor: bundle.dir.resolve(delivered.details.actor_id, delivered.details.actor_type).name }
    }
    if (bool(detail?.details.historical_site_rule)) notes.push("This instruction applied to an earlier handover; the site's standing procedure has changed since.")
    if (detail && str(detail.details.last_confirmed_source) === "MANAGED_SITE_PROFILE") notes.push("Access comes from the standard site profile, not from a call about this car or appointment.")
    const step: JourneyStep = {
      id: pointId, role, roleLabel: role === "PICKUP" ? "Pickup" : role === "DELIVERY" ? "Delivery" : "Transfer yard",
      boundary, place, site, windows: stepWindows,
      contact: detail ? contactView(detail, stepPending && !recorded) : null,
      access: detail ? accessView(detail, stepPending && !recorded) : null,
      recorded, proofs: proofs.filter((proof) => proof.pointId === pointId),
      claims: claimViews(bundle, detail?.id ?? null), notes,
    }
    stepCache.set(pointId, step)
    return step
  }

  const groups: JourneyGroup[] = [...bundle.items].sort(PRIMARY_FIRST).map((item) => {
    let itemSegments = segments.filter((row) => row.details.order_item_id === item.id)
    if (!itemSegments.length && item.role === "PRIMARY") itemSegments = segments.filter((row) => !str(row.details.order_item_id))
    const stepIds: string[] = []
    for (const segment of itemSegments) {
      for (const key of ["from_point_id", "to_point_id"]) {
        const id = str(segment.details[key])
        if (id && !stepIds.includes(id)) stepIds.push(id)
      }
    }
    if (!stepIds.length && item.role === "PRIMARY") for (const point of points) stepIds.push(point.id)
    const steps = stepIds.map(stepFor).filter((step): step is JourneyStep => !!step)
    const legs: JourneyLeg[] = itemSegments.map((segment) => {
      const status = str(segment.details.status) ?? "PLANNED"
      const assignmentRow = assignmentRows
        .filter((row) => strings(row.details.segment_ids).includes(segment.id))
        .sort((a, b) => (a.details.status === "CANCELLED" ? 1 : 0) - (b.details.status === "CANCELLED" ? 1 : 0) || String(b.details.accepted_at ?? "").localeCompare(String(a.details.accepted_at ?? "")))[0]
      return {
        id: segment.id, sequence: num(segment.details.sequence) ?? 0,
        fromStepId: str(segment.details.from_point_id) ?? "", toStepId: str(segment.details.to_point_id) ?? "",
        distanceKm: num(segment.details.distance_km), status, statusLabel: label(status), tone: toneOf(SEGMENT_TONE, status),
        assignment: assignmentRow ? assignmentsById.get(assignmentRow.id) ?? null : null,
        tracking: trackingView(observations.find((row) => row.segment_id === segment.id && row.source === "driver_app")),
        inference: trackingView(observations.find((row) => row.segment_id === segment.id && row.location_quality === "INFERRED")),
      }
    })
    return {
      itemId: item.id, role: item.role, roleLabel: label(item.role), vehicle: `${item.vehicle.make} ${item.vehicle.model}`, steps, legs,
    }
  })

  const planView = plan ? {
    id: plan.id, version: num(plan.details.version), status: str(plan.details.status) ?? "UNKNOWN",
    statusLabel: label(str(plan.details.status)), source: str(plan.details.source), activatedAt: str(plan.details.activated_at), active: planActive,
  } : null
  const otherPlans = plans.filter((row) => row.id !== planId).map((row) => ({
    id: row.id, version: num(row.details.version), status: str(row.details.status) ?? "UNKNOWN",
    statusLabel: label(str(row.details.status)), createdAt: str(row.details.created_at),
  }))
  const distance = groups[0]?.legs.reduce<number | null>((sum, leg) => leg.distanceKm == null ? sum : (sum ?? 0) + leg.distanceKm, null) ?? null
  return { plan: planView, otherPlans, groups, distanceKm: distance }
}

function windowRank(purpose: string): number {
  return ["SELECTED_PICKUP_SLOT", "CUSTOMER_DELIVERY_PROMISE", "SELECTED_DELIVERY_SLOT", "REQUESTED_PICKUP_SLOT", "REQUESTED_DELIVERY_SLOT", "PICKUP_AVAILABILITY"].indexOf(purpose)
}

function messageView(bundle: Bundle, message: Bundle["messages"][number]): MessageView {
  const { dir } = bundle
  const d = message.details
  const channel = str(d.channel) ?? "unknown"
  const author = dir.resolve(d.author_id, message.authorType)
  if (str(d.author_name_snapshot)) author.name = str(d.author_name_snapshot) as string
  return {
    id: message.id, author, recipient: dir.resolve(d.recipient_id, d.recipient_type),
    channel, channelLabel: label(channel), at: message.authoredAt, body: message.body,
    internal: str(d.visibility) === "INTERNAL" || channel === "internal_note",
    language: str(d.language), evidenceCount: refCount(d.evidence_refs),
    otherOrder: message.orderId !== bundle.order.id ? orderRef(bundle, message.orderId) : null,
  }
}

function threadViews(bundle: Bundle): ThreadView[] {
  const { dir } = bundle
  return bundle.conversations.map((thread) => {
    const d = thread.details
    const counterpartyType = str(d.counterparty_type)
    const counterparty = counterpartyType || str(d.counterparty_id) ? dir.resolve(d.counterparty_id, counterpartyType) : null
    if (counterparty && str(d.counterparty_name_snapshot)) counterparty.name = str(d.counterparty_name_snapshot) as string
    const waitingOn = str(d.waiting_on)
    return {
      id: thread.id, category: thread.category, categoryLabel: label(thread.category) || humanize(thread.category),
      channel: thread.channel, channelLabel: label(thread.channel) || humanize(thread.channel),
      status: thread.status, statusLabel: label(thread.status), tone: thread.status === "OPEN" ? "accent" : "neutral",
      counterparty, waitingOn: waitingOn ? labelIn(waitingOn) : null, owner: dir.title(d.owner),
      nextCheckAt: str(d.next_check_at), startedAt: str(d.started_at), updatedAt: thread.updatedAt,
      relatedOrders: strings(d.related_order_ids).map((id) => orderRef(bundle, id)),
      follows: str(d.follows_conversation_id),
      messages: bundle.messages.filter((message) => message.conversationId === thread.id).map((message) => messageView(bundle, message)),
    }
  })
}

function offerViews(bundle: Bundle): OfferView[] {
  const { dir } = bundle
  const exposures = rows(bundle, "market_offer_exposures")
  const reaches = rows(bundle, "market_offer_reach_checks")
  const demandWindows = rows(bundle, "market_offer_demand_windows")
  const demandSignals = rows(bundle, "market_offer_demand_signals")
  return rows(bundle, "market_offers").map((row) => {
    const d = row.details
    const status = str(d.status) ?? "UNKNOWN"
    const reach = reaches.find((item) => item.details.offer_id === row.id)?.details
    const demandWindow = demandWindows.find((item) => item.details.offer_id === row.id)?.details
    const signals = demandSignals.filter((item) => item.details.offer_id === row.id)
    const assessment = bundle.events.find((event) => event.command === "market.offer_assessed" && event.targetId === row.id)
    const assumptions = obj(d.execution_assumptions)
    const withdrawn = bundle.events.find((event) => event.command === "offer.withdrawn" && event.targetId === row.id)
    return {
      id: row.id, type: str(d.type) ?? "REGULAR", typeLabel: label(str(d.type)), visibility: str(d.visibility) ?? "OPEN",
      status, statusLabel: label(status), tone: toneOf(OFFER_TONE, status),
      fee: fmtMoney(num(d.fee_cents), str(d.currency) ?? "EUR") || null,
      publishedAt: str(d.published_at), expiresAt: str(d.expires_at), acceptedAt: str(d.accepted_at), withdrawnAt: withdrawn?.recordedAt ?? null,
      memberOrders: strings(d.order_ids).map((id) => orderRef(bundle, id)),
      pricingNote: str(d.pricing_note),
      assumptions: assumptions ? Object.entries(assumptions).map(([key, value]) => `${humanize(key)}: ${typeof value === "string" ? labelIn(value) : String(value)}`) : [],
      exposures: exposures.filter((item) => item.details.offer_id === row.id).map((item) => ({
        id: item.id, driver: dir.resolve(item.details.driver_id, "driver"), status: str(item.details.status) ?? "SHOWN",
        statusLabel: label(str(item.details.status)), reason: str(item.details.reason) ? labelIn(str(item.details.reason)) : null,
        shownAt: str(item.details.shown_at), notifiedAt: str(item.details.notified_at), viewedAt: str(item.details.viewed_at),
        decidedAt: str(item.details.decided_at), expiresAt: str(item.details.expires_at),
      })),
      reach: reach ? {
        checkedAt: str(reach.checked_at) ?? "", screened: num(reach.screened_driver_count) ?? 0,
        suitable: num(reach.provisionally_pickup_suitable_count) ?? 0, matched: num(reach.audience_matched_count) ?? 0,
        accessible: num(reach.feed_accessible_count) ?? 0, note: str(reach.interpretation_note),
      } : null,
      demand: demandWindow ? {
        views: num(demandWindow.view_count) ?? 0, passes: num(demandWindow.pass_count) ?? 0,
        windowStart: str(demandWindow.window_start_at), windowEnd: str(demandWindow.window_end_at), note: str(demandWindow.coverage_note),
      } : signals.length ? {
        views: signals.filter((item) => item.details.kind === "VIEW").length, passes: signals.filter((item) => item.details.kind === "PASS").length,
        windowStart: null, windowEnd: null, note: "Explicit gig detail views and passes recorded in this packet.",
      } : null,
      assessment: assessment ? `${labelIn(str(obj(assessment.details.changes)?.decision)) || "reviewed"} on ${fmtDateTime(assessment.recordedAt)}` : null,
    }
  }).sort((a, b) => String(b.publishedAt ?? "").localeCompare(String(a.publishedAt ?? "")))
}

function reservationViews(bundle: Bundle, assignmentsById: Map<string, AssignmentView>): ReservationView[] {
  return rows(bundle, "travel_reservations").map((row) => {
    const d = row.details
    const status = str(d.status) ?? "BOOKED"
    const kind = str(d.kind) ?? "TRAVEL"
    const checks: string[] = []
    if (kind === "FERRY") {
      checks.push(`check-in ${labelIn(str(d.check_in_confirmation)) || "unknown"}`)
      checks.push(`boarding ${labelIn(str(d.boarding_confirmation)) || "unknown"}`)
      if (str(d.destination_terminal_arrival_confirmation)) checks.push(`terminal arrival ${labelIn(str(d.destination_terminal_arrival_confirmation))}`)
    }
    for (const milestone of list(d.verified_milestones)) if (typeof milestone === "string") checks.push(`verified: ${labelIn(milestone)}`)
    const amendment = obj(d.carrier_amendments) ?? obj(list(d.carrier_amendments)[0])
    const assignment = assignmentsById.get(str(d.assignment_id) ?? "")
    const route = str(d.route_label) ?? (str(d.origin_terminal) && str(d.destination_terminal) ? `${str(d.origin_terminal)} to ${str(d.destination_terminal)}` : null) ?? (str(d.from_city) && str(d.to_city) ? `${str(d.from_city)} to ${str(d.to_city)}` : null)
    return {
      id: row.id, kind, kindLabel: label(kind), status, statusLabel: label(status), tone: toneOf(RESERVATION_TONE, status),
      route, departureAt: str(d.departure_at), arrivalAt: str(d.expected_arrival_at), checkInCutoffAt: str(d.check_in_cutoff_at),
      bookedAt: str(d.booked_at), reference: str(d.booking_reference), driver: assignment?.driver ?? null, checks,
      amendment: amendment ? [str(amendment.message), str(amendment.vehicle_space_status) ? `vehicle space ${labelIn(str(amendment.vehicle_space_status))}` : null, str(amendment.issued_at) ? `issued ${fmtDateTime(str(amendment.issued_at))}` : null].filter(Boolean).join(" · ") : null,
      replaces: str(d.replaces_reservation_id), replacedBy: str(d.replacement_reservation_id),
      stateNote: [str(d.snapshot_journey_state) ? `Recorded state: ${labelIn(str(d.snapshot_journey_state))}` : null, str(obj(d.journey_state_basis)?.note)].filter(Boolean).join(". ") || null,
    }
  }).sort((a, b) => String(a.departureAt ?? "").localeCompare(String(b.departureAt ?? "")))
}

function optionViews(bundle: Bundle): OptionView[] {
  return rows(bundle, "travel_options").map((row) => {
    const d = row.details
    const status = str(d.status) ?? "AVAILABLE_QUOTE"
    const kind = str(d.kind) ?? "TRAVEL"
    return {
      id: row.id, kind, kindLabel: label(kind), status, statusLabel: label(status), tone: toneOf(OPTION_TONE, status),
      route: str(d.from_city) && str(d.to_city) ? `${str(d.from_city)} to ${str(d.to_city)}` : null, provider: str(d.provider),
      departureAt: str(d.departure_at), arrivalAt: str(d.arrival_at), checkedAt: str(d.checked_at),
      quote: fmtMoney(num(d.quote_cents), str(d.currency) ?? "EUR") || null,
      note: [str(d.capacity_note), num(d.road_time_to_terminal_hours) != null ? `${num(d.road_time_to_terminal_hours)} h road time to the terminal` : null, num(d.connection_count) ? `${num(d.connection_count)} connection(s)` : null].filter(Boolean).join(" · ") || null,
    }
  }).sort((a, b) => String(a.departureAt ?? "").localeCompare(String(b.departureAt ?? "")))
}

function alertViews(bundle: Bundle): AlertView[] {
  return bundle.alerts.map((alert) => {
    const severe = alert.severity === "critical" || alert.severity === "high"
    const tone: Tone = alert.status === "OPEN" ? (severe ? "danger" : "warn") : alert.status === "RESOLVED" ? "ok" : "neutral"
    return {
      id: alert.id, signal: alert.signal, signalLabel: label(alert.signal), severity: alert.severity, status: alert.status,
      statusLabel: label(alert.status), tone, summary: alert.summary, triggeredAt: alert.triggeredAt,
      owner: bundle.dir.title(alert.details.owner) ?? bundle.dir.title(alert.details.work_owner),
      acknowledgedAt: str(alert.details.acknowledged_at), acknowledgementReason: str(alert.details.acknowledgement_reason),
      resolvedAt: str(alert.details.resolved_at), resolutionReason: str(alert.details.resolution_reason), nextAction: str(alert.details.next_action),
      evidenceCount: refCount(alert.details.evidence_refs), conversationId: str(alert.details.conversation_id), assignmentId: str(alert.details.assignment_id),
    }
  })
}

function workItemViews(bundle: Bundle): WorkItemView[] {
  return rows(bundle, "work_items").map((row) => {
    const d = row.details
    const status = str(d.status) ?? "OPEN"
    return {
      id: row.id, kind: str(d.kind) ?? "CHECK", kindLabel: label(str(d.kind)), status, statusLabel: label(status),
      tone: str(d.priority) === "high" && status !== "DONE" ? "warn" : toneOf(WORK_TONE, status),
      priority: str(d.priority), owner: bundle.dir.title(d.owner), createdBy: bundle.dir.title(d.created_by),
      summary: str(d.summary) ?? "", nextAction: str(d.next_action), openedAt: str(d.opened_at), dueAt: str(d.due_at),
      closedAt: str(d.closed_at), outcome: str(d.outcome) ? labelIn(str(d.outcome)) : null, sourceCount: refCount(d.source_refs),
    }
  })
}

function incidentViews(bundle: Bundle): IncidentView[] {
  return rows(bundle, "incidents").map((row) => {
    const d = row.details
    const status = str(d.status) ?? "OPEN"
    const resolved = !!str(d.resolved_at)
    const facts: Fact[] = []
    if (str(d.reported_symptom)) facts.push({ label: "Reported symptom", value: str(d.reported_symptom) as string })
    if (str(d.reported_stop_text)) facts.push({ label: "Reported location", value: str(d.reported_stop_text) as string, hint: bool(d.location_verified) === false ? "not verified" : null })
    if (str(d.recovery_decision)) facts.push({ label: "Recovery decision", value: label(str(d.recovery_decision)) })
    if (str(d.warning_photo_status)) facts.push({ label: "Warning photo", value: label(str(d.warning_photo_status)) })
    if (list(d.related_record_ids).length) facts.push({ label: "Related records", value: `${list(d.related_record_ids).length}` })
    return {
      id: row.id, kind: str(d.kind) ?? "INCIDENT", kindLabel: label(str(d.kind)), status, statusLabel: label(status),
      tone: resolved ? "ok" : "danger", owner: bundle.dir.title(d.owner), openedAt: str(d.opened_at), resolvedAt: str(d.resolved_at), facts,
    }
  })
}

function proposalViews(bundle: Bundle): ProposalView[] {
  const { dir } = bundle
  return rows(bundle, "agent_proposals").map((row) => {
    const d = row.details
    const status = str(d.status) ?? "PENDING_REVIEW"
    const review = obj(d.review)
    const execution = obj(d.execution)
    const dependency = obj(d.dependency)
    return {
      id: row.id, status, statusLabel: label(status), tone: toneOf(PROPOSAL_TONE, status),
      command: str(d.command) ?? "", commandLabel: humanize(str(d.command)), summary: str(d.summary) ?? "", rationale: str(d.rationale),
      agent: dir.resolve(d.proposed_by_agent_id, "agent"), createdAt: str(d.created_at) ?? "", alertId: str(d.alert_id),
      evidenceCount: refCount(d.evidence_refs),
      dependency: dependency ? [str(dependency.execution_policy) ? labelIn(str(dependency.execution_policy)) : null, str(dependency.checked_at) ? `state checked ${fmtDateTime(str(dependency.checked_at))}` : null].filter(Boolean).join("; ") || null : null,
      review: review ? {
        decision: str(review.decision) ?? "", decisionLabel: label(str(review.decision)), note: str(review.decision_note),
        reviewer: dir.resolve(review.reviewer_id, "operator"), at: str(review.reviewed_at) ?? "",
      } : null,
      execution: execution ? {
        status: str(execution.status) ?? "", statusLabel: label(str(execution.status)), at: str(execution.attempted_at),
        error: str(execution.error), effects: refCount(execution.effect_event_ids),
      } : null,
      superseded: str(d.superseded_by_proposal_id) ? `superseded ${fmtDateTime(str(d.superseded_at))}` : null,
    }
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

function notificationViews(bundle: Bundle): NotificationView[] {
  return rows(bundle, "internal_notifications").map((row) => {
    const d = row.details
    return {
      id: row.id, activity: str(d.activity) ?? "POSTED", activityLabel: label(str(d.activity)), destination: str(d.destination) ?? "room",
      preview: str(d.preview) ?? "", at: str(d.occurred_at) ?? "", deliveryState: str(d.delivery_state) ?? "", deliveryLabel: labelIn(str(d.delivery_state)),
      actor: bundle.dir.resolve(d.actor_id, null), alertId: str(d.alert_id), proposalId: str(d.proposal_id),
    }
  }).sort((a, b) => a.at.localeCompare(b.at))
}

function expenseViews(bundle: Bundle): ExpenseView[] {
  return rows(bundle, "expenses").map((row) => {
    const d = row.details
    const status = str(d.status) ?? "SUBMITTED"
    const receiptState = str(d.receipt_state)
    const receiptCount = num(d.receipt_count) ?? 0
    return {
      id: row.id, kind: str(d.kind) ?? "COST", kindLabel: label(str(d.kind)), status, statusLabel: label(status), tone: toneOf(EXPENSE_TONE, status),
      amount: fmtMoney(num(d.amount_cents), str(d.currency) ?? "EUR"), payer: str(d.payer) ? label(str(d.payer)) : null,
      claimant: str(d.driver_id) ? bundle.dir.resolve(d.driver_id, "driver") : null,
      receipt: receiptState ? labelIn(receiptState) : receiptCount > 0 ? `${receiptCount} receipt(s) claimed, no sample in packet` : "no receipt",
      submittedAt: str(d.submitted_at), reviewedAt: str(d.reviewed_at), note: str(d.review_note),
    }
  }).sort((a, b) => String(b.submittedAt ?? "").localeCompare(String(a.submittedAt ?? "")))
}

function custodyView(bundle: Bundle): CustodyView {
  const { dir } = bundle
  const events = rows(bundle, "custody_asset_events")
  return {
    assets: rows(bundle, "custody_assets").map((row) => {
      const d = row.details
      const holder = str(d.holder_id) ? dir.resolve(d.holder_id, d.holder_role).name : labelIn(str(d.holder_role)) || "unknown"
      return {
        id: row.id, kind: str(d.kind) ?? "ASSET", kindLabel: label(str(d.kind)), label: str(d.label) ?? label(str(d.kind)),
        holder, basis: labelIn(str(d.holder_basis)) || "unknown", nextAction: str(d.next_action), owner: dir.title(d.followup_owner),
        dueAt: str(d.followup_due_at), relatedOrder: str(d.related_order_id) ? orderRef(bundle, str(d.related_order_id) as string) : null,
        events: events.filter((event) => event.details.asset_id === row.id).map((event) => ({
          id: event.id, at: str(event.details.occurred_at) ?? "", kindLabel: label(str(event.details.kind)), note: str(event.details.note),
          verification: labelIn(str(event.details.verification_status)) || "unknown",
        })).sort((a, b) => a.at.localeCompare(b.at)),
      }
    }),
    reports: rows(bundle, "custody_reports").map((row) => {
      const d = row.details
      return {
        id: row.id, at: str(d.reported_at) ?? "", driver: dir.resolve(d.driver_id, "driver"),
        security: labelIn(str(d.reported_security)) || "not stated", continuity: labelIn(str(d.continuity_evidence_status)) || "unknown",
        location: labelIn(str(d.location_evidence_status)) || "unknown", parking: str(d.exact_parking_location),
      }
    }),
  }
}

function historyDays(bundle: Bundle): HistoryDay[] {
  const events = [...bundle.events].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
  const days = new Map<string, HistoryDay>()
  for (const event of events) {
    const key = dayKey(event.recordedAt)
    let day = days.get(key)
    if (!day) {
      day = { key, label: fmtDayHeading(event.recordedAt), events: [] }
      days.set(key, day)
    }
    day.events.push(describeEvent(event, bundle))
  }
  return [...days.values()]
}

const SHOWN_COLLECTIONS = new Set([
  "transport_plans", "transport_points", "transport_segments", "time_windows", "order_endpoint_details", "endpoint_claims",
  "work_assignments", "assignment_steps", "market_offers", "market_offer_exposures", "market_offer_reach_checks",
  "market_offer_demand_windows", "market_offer_demand_signals", "travel_reservations", "travel_options", "travel_confirmations",
  "ferry_terminal_events", "tracking_observations", "proofs", "documents", "custody_assets", "custody_asset_events",
  "custody_reports", "site_visits", "order_notes", "work_items", "incidents", "expenses", "agent_proposals", "internal_notifications",
])

export function buildRecordView(bundle: Bundle): RecordView {
  const { order, dir, snapshotAt } = bundle
  const primary = bundle.items.find((item) => item.role === "PRIMARY") ?? bundle.items[0] ?? null
  const tradeIn = bundle.items.find((item) => item.role === "TRADE_IN") ?? null
  const attention = deriveAttention(bundle)
  const { keyDates, decisive } = deriveKeyDates(bundle)
  const assignments = rows(bundle, "work_assignments").map((row) => assignmentView(bundle, row))
    .sort((a, b) => (a.status === "CANCELLED" ? 1 : 0) - (b.status === "CANCELLED" ? 1 : 0) || String(a.acceptedAt ?? "").localeCompare(String(b.acceptedAt ?? "")))
  const assignmentsById = new Map(assignments.map((assignment) => [assignment.id, assignment]))
  const points = activePoints(bundle)
  const pointLabels = new Map(points.map((point) => {
    const role = str(point.details.role)
    const place = placeView(bundle, str(point.details.address_id))
    return [point.id, `${role === "PICKUP" ? "Pickup" : role === "DELIVERY" ? "Delivery" : "Transfer yard"}, ${place.city}`]
  }))
  const proofs = proofViews(bundle, pointLabels)
  const pending = order.lane === "booked" || order.lane === "moving"
  const journey = buildJourney(bundle, assignmentsById, proofs, pending)
  const from = placeView(bundle, order.pickupAddressId)
  const to = placeView(bundle, order.deliveryAddressId)
  const via = points.filter((point) => point.details.role === "TRANSFER").map((point) => placeView(bundle, str(point.details.address_id)))
  const windows = chosenWindows(bundle)
  const threads = threadViews(bundle)
  const history = historyDays(bundle)
  const offers = offerViews(bundle)
  const reservations = reservationViews(bundle, assignmentsById)
  const options = optionViews(bundle)
  const alerts = alertViews(bundle)
  const workItems = workItemViews(bundle)
  const incidents = incidentViews(bundle)
  const proposals = proposalViews(bundle)
  const notifications = notificationViews(bundle)
  const expenses = expenseViews(bundle)
  const custody = custodyView(bundle)
  const documents: DocumentView[] = rows(bundle, "documents").map((row) => {
    const d = row.details
    const status = str(d.status) ?? "UNKNOWN"
    return {
      id: row.id, kind: str(d.kind) ?? "DOCUMENT", kindLabel: label(str(d.kind)), status, statusLabel: label(status), tone: toneOf(DOCUMENT_TONE, status),
      medium: str(d.medium) ? labelIn(str(d.medium)) : null, signatureScope: str(d.signature_scope) ? labelIn(str(d.signature_scope)) : null,
      required: bool(d.required) ?? false, fileCount: num(d.file_count) ?? 0, updatedAt: str(d.updated_at),
      note: [bool(d.current_for_handover) === false ? "not the current version for the handover" : null, str(d.supersedes_document_id) ? "corrected template" : null, str(d.template_vin) ? `template VIN ${str(d.template_vin)}` : null].filter(Boolean).join(" · ") || null,
    }
  })
  const siteVisits = rows(bundle, "site_visits").map((row) => ({
    id: row.id, at: str(row.details.arrived_at) ?? "", leftAt: str(row.details.left_at), outcome: label(str(row.details.outcome)),
    verifiedBySite: bool(row.details.verified_by_site) ?? false, site: dir.siteName(row.details.site_id),
  }))
  const notes = rows(bundle, "order_notes").map((row) => ({
    id: row.id, at: str(row.details.authored_at) ?? "", author: dir.resolve(row.details.author_id, row.details.author_type),
    body: str(row.details.body) ?? "", visibility: str(row.details.visibility) ? label(str(row.details.visibility)) : null,
  }))
  const confirmations = rows(bundle, "travel_confirmations").map((row) => ({
    id: row.id, at: str(row.details.reported_at) ?? "", driver: dir.resolve(row.details.reporter_driver_id, "driver"),
    kindLabel: label(str(row.details.kind)), report: str(row.details.report) ?? "",
  }))
  const terminalEvents = rows(bundle, "ferry_terminal_events").map((row) => ({
    id: row.id, at: str(row.details.occurred_at) ?? "", kindLabel: label(str(row.details.kind)),
    terminal: str(row.details.terminal_id) ? humanize(str(row.details.terminal_id)?.replace(/^terminal-/, "")) : null,
    reason: str(row.details.reason), note: str(row.details.evidence_note),
  }))
  const inboxHints = bundle.inboxThreads.map((thread) => ({
    id: thread.id, state: str(thread.details.link_state) ?? "", stateLabel: label(str(thread.details.link_state)),
    category: label(str(thread.details.category)), channel: label(str(thread.details.channel)), owner: dir.title(thread.details.owner),
    waitingOn: str(thread.details.waiting_on) ? labelIn(str(thread.details.waiting_on)) : null, basis: str(thread.details.candidate_basis),
    confirmed: strings(thread.details.linked_order_ids).includes(order.id),
    candidates: strings(thread.details.candidate_order_ids).map((id) => orderRef(bundle, id)),
    linked: strings(thread.details.linked_order_ids).map((id) => orderRef(bundle, id)),
  }))
  const otherRecords = Object.entries(bundle.related)
    .filter(([collection, items]) => items && items.length && !SHOWN_COLLECTIONS.has(collection))
    .map(([collection, items]) => ({ collection, label: humanize(collection), count: items?.length ?? 0 }))

  const facts: Fact[] = []
  if (primary) {
    facts.push({ label: "Plate", value: primary.vehicle.registration ?? "Not supplied", mono: !!primary.vehicle.registration, tone: primary.vehicle.registration ? undefined : "warn" })
    facts.push({ label: "VIN", value: primary.vehicle.vin ?? "Not supplied", mono: !!primary.vehicle.vin, tone: primary.vehicle.vin ? undefined : "warn" })
    facts.push({ label: "Model year", value: primary.vehicle.year ? String(primary.vehicle.year) : "Not supplied" })
    if (primary.vehicle.fuel) facts.push({ label: "Fuel", value: label(primary.vehicle.fuel) })
  }
  facts.push({ label: "Customer", value: bundle.customer.name, hint: bundle.customer.tier ? label(bundle.customer.tier) : null, href: `/customers/${bundle.customer.id}` })
  if (str(order.details.customer_reference)) facts.push({ label: "Customer reference", value: str(order.details.customer_reference) as string, mono: true })
  facts.push({ label: "Route", value: `${label(order.routeKind)}${journey.distanceKm ? ` · ${journey.distanceKm} km planned` : ""}` })
  facts.push({ label: "Status", value: label(order.status), hint: str(order.details.readiness_status) ? `readiness ${labelIn(str(order.details.readiness_status))}` : null })
  facts.push({ label: "Created", value: fmtDateTime(order.createdAt), hint: str(order.details.source) ? `via ${labelIn(str(order.details.source))}` : null })

  const summaryParts = [laneLabel(order.lane)]
  if (decisive) {
    const when = decisive.end ? fmtRange(decisive.start, decisive.end, decisive.zone) : fmtDateTime(decisive.start, decisive.zone)
    summaryParts.push(`${decisive.label.toLowerCase()} ${when}${decisive.note ? ` (${decisive.note})` : ""}`)
  }

  const header: RecordHeader = {
    id: order.id, reference: order.reference, customerReference: str(order.details.customer_reference),
    lane: order.lane, laneLabel: laneLabel(order.lane), status: order.status, statusLabel: label(order.status),
    readiness: str(order.details.readiness_status), readinessLabel: str(order.details.readiness_status) ? label(str(order.details.readiness_status)) : null,
    routeKind: order.routeKind, routeKindLabel: label(order.routeKind), source: str(order.details.source),
    createdAt: order.createdAt, updatedAt: order.updatedAt, cancelledAt: str(order.details.cancelled_at),
    vehicle: primary ? {
      title: `${primary.vehicle.make} ${primary.vehicle.model}`, make: primary.vehicle.make, model: primary.vehicle.model,
      year: primary.vehicle.year, fuel: primary.vehicle.fuel, plate: primary.vehicle.registration, vin: primary.vehicle.vin,
      illustrationSlug: slug(`${primary.vehicle.make}-${primary.vehicle.model}`), logoSlug: slug(primary.vehicle.make),
    } : null,
    tradeIn: tradeIn ? { title: `${tradeIn.vehicle.make} ${tradeIn.vehicle.model}`, plate: tradeIn.vehicle.registration, vin: tradeIn.vehicle.vin } : null,
    customer: { id: bundle.customer.id, name: bundle.customer.name, tier: bundle.customer.tier, tierLabel: bundle.customer.tier ? label(bundle.customer.tier) : null, country: bundle.customer.country },
    from, to, via, keyDates, facts,
    summary: `${summaryParts.join(" · ")}.`,
  }

  const story = buildStory(bundle, keyDates, assignments, offers, journey, attention)
  const tiles = buildTiles(bundle, keyDates, assignments, offers, decisive)

  const sections = [
    { id: "attention", label: "Needs a person", count: attention.length },
    { id: "journey", label: "Journey", count: null },
    { id: "conversations", label: "Conversations", count: threads.length },
    { id: "evidence", label: "Evidence", count: proofs.length + documents.length },
    { id: "decisions", label: "Agent and decisions", count: proposals.length },
    { id: "work", label: "Work", count: workItems.length + incidents.length + alerts.length },
    { id: "market", label: "Market", count: offers.length },
    { id: "travel", label: "Travel", count: reservations.length + options.length },
    { id: "costs", label: "Costs", count: expenses.length },
    { id: "history", label: "History", count: bundle.events.length },
  ]

  void windows
  void snapshotAt
  return {
    snapshotAt, story, tiles, header, attention, journey, alerts, workItems, incidents, threads, proofs, documents, custody, siteVisits, notes,
    proposals, notifications, offers, assignments, reservations, options, confirmations, terminalEvents, expenses,
    history, historyTotal: bundle.events.length, inboxHints, otherRecords, sections,
  }
}

function dayWord(iso: string | null, snapshotAt: string | null, zone: string | null): string {
  if (!iso) return ""
  const today = dayKey(snapshotAt, zone)
  const day = dayKey(iso, zone)
  if (day === today) return "today"
  const tomorrow = snapshotAt ? dayKey(new Date(new Date(snapshotAt).getTime() + 86400000).toISOString(), zone) : ""
  if (day === tomorrow) return "tomorrow"
  const yesterday = snapshotAt ? dayKey(new Date(new Date(snapshotAt).getTime() - 86400000).toISOString(), zone) : ""
  if (day === yesterday) return "yesterday"
  return `on ${fmtWeekday(iso, zone)}`
}

/** The lane's headline, then the open exception when the attention list holds one. */
function buildStory(bundle: Bundle, keyDates: KeyDate[], assignments: AssignmentView[], offers: OfferView[], journey: JourneyView, attention: AttentionItem[]): Story {
  const story = laneStory(bundle, keyDates, assignments, offers, journey)
  const open = attention.find((item) => item.tone === "danger" || item.tone === "warn") ?? null
  if (!open) return story
  // The lane sentence already says a moving car has no position; do not say it twice.
  if (open.kind === "check" && story.detail?.includes("No driver-app position")) return story
  const tone: Tone = strongestTone(attention.map((item) => item.tone)) === "danger" ? "danger" : story.tone
  const exception = `Open: ${open.title}.`
  return { ...story, tone, detail: story.detail ? `${story.detail} ${exception}` : exception }
}

function laneStory(bundle: Bundle, keyDates: KeyDate[], assignments: AssignmentView[], offers: OfferView[], journey: JourneyView): Story {
  const { order, snapshotAt } = bundle
  const from = placeView(bundle, order.pickupAddressId)
  const to = placeView(bundle, order.deliveryAddressId)
  const date = (key: KeyDate["key"]) => keyDates.find((item) => item.key === key) ?? null
  const slot = date("pickup_slot")
  const promise = date("promise")
  const eta = date("eta")
  const delivered = date("delivered")
  const active = assignments.find((item) => item.status === "IN_PROGRESS") ?? assignments.find((item) => item.status === "ASSIGNED") ?? null
  const driver = active?.driver.name ?? null
  const rel = (iso: string | null | undefined) => relativeTo(iso, snapshotAt)?.text ?? null
  const range = (item: KeyDate | null) => item ? fmtRange(item.start, item.end, item.zone) : null
  const intro = `${bundle.customer.name} ordered it on ${fmtDay(order.createdAt)} for ${from.city} to ${to.city}${order.routeKind === "IMPORT" ? ", an import" : ""}.`
  const lane = order.lane
  if (lane === "cancelled") {
    const cancelled = date("cancelled")
    return { intro, headline: `Cancelled ${cancelled ? dayWord(cancelled.start, snapshotAt, null) : ""}.`.replace(" .", "."), tone: "neutral", detail: cancelled ? `Cancelled ${fmtDateTime(cancelled.start)}.` : null }
  }
  if (lane === "delivered" && delivered) {
    const within = promise?.note?.startsWith("delivered within") ? "Within the promised window." : promise?.note?.startsWith("delivered after") ? "After the promised window." : null
    const tradeIn = journey.groups.find((group) => group.role === "TRADE_IN")
    const returning = tradeIn?.legs.some((leg) => leg.status === "IN_PROGRESS" || leg.status === "ASSIGNED")
    return {
      intro, headline: `Delivered ${dayWord(delivered.start, snapshotAt, delivered.zone)} at ${fmtClockIn(delivered.start, delivered.zone)}.`, tone: "ok",
      detail: [within, returning ? "The trade-in is still on its way back." : null].filter(Boolean).join(" ") || null,
    }
  }
  if (lane === "moving") {
    const late = eta?.tone === "danger" || promise?.tone === "danger"
    const headline = driver ? `${driver} is driving it to ${to.city}.` : `It is on the road to ${to.city}.`
    const detail = eta
      ? `ETA ${fmtDateTime(eta.start, eta.zone)} from the driver app${promise ? `, promised by ${fmtClockIn(promise.end ?? promise.start, promise.zone)}` : ""}.${late ? " That is after the promise." : ""}`
      : promise ? `Promised ${range(promise)}. No driver-app position in this packet.` : "No promise or position recorded."
    return { intro, headline: late ? `Running late to ${to.city}.` : headline, tone: late ? "danger" : "accent", detail }
  }
  if (lane === "booked") {
    const slotPassed = slot?.tone === "warn"
    const headline = driver
      ? slotPassed ? `${driver} was due to collect it, nothing is recorded.` : `${driver} collects it ${slot ? dayWord(slot.start, snapshotAt, slot.zone) : "soon"}.`
      : "A driver is booked."
    const detail = [slot ? `Pickup ${range(slot)}${rel(slot.start) ? `, ${rel(slot.start)}` : ""}` : null, promise ? `delivery promised ${range(promise)}` : null].filter(Boolean).join(" · ")
    return { intro, headline, tone: slotPassed ? "danger" : "warn", detail: detail ? `${detail}.` : null }
  }
  if (lane === "market") {
    const offer = offers.find((item) => item.status === "PUBLISHED") ?? null
    const cutoffPassed = !!(offer?.expiresAt && snapshotAt && isBefore(offer.expiresAt, snapshotAt))
    const headline = cutoffPassed ? "Offer cutoff passed, still nobody." : "Looking for a driver."
    const detail = [offer ? `Offer published ${rel(offer.publishedAt) ?? ""}${offer.fee ? ` at ${offer.fee}` : ""}` : "No live offer", slot ? `pickup slot ${range(slot)}${rel(slot.start) ? `, ${rel(slot.start)}` : ""}` : null].filter(Boolean).join(" · ")
    return { intro, headline, tone: cutoffPassed || slot?.tone === "warn" ? "danger" : "warn", detail: `${detail}.` }
  }
  if (lane === "ready") {
    return { intro, headline: "Ready to post. Nobody is driving it.", tone: "warn", detail: slot ? `Pickup slot ${range(slot)}${rel(slot.start) ? `, ${rel(slot.start)}` : ""}.` : null }
  }
  const requested = date("requested_pickup")
  const waiting = bundle.conversations.find((thread) => thread.status === "OPEN" && str(thread.details.waiting_on))
  const detail = waiting
    ? `Waiting on ${labelIn(str(waiting.details.waiting_on))}.${requested ? ` Requested pickup ${range(requested)}.` : ""}`
    : requested ? `Requested pickup ${range(requested)}.` : `Created ${rel(order.createdAt) ?? fmtDay(order.createdAt)}, inputs still being prepared.`
  return { intro, headline: "Still being prepared.", tone: "warn", detail }
}

function fmtClockIn(iso: string, zone: string | null): string {
  const text = fmtDateTime(iso, zone)
  return text.split(" ").slice(2).join(" ")
}

function buildTiles(bundle: Bundle, keyDates: KeyDate[], assignments: AssignmentView[], offers: OfferView[], decisive: KeyDate | null): Tile[] {
  void decisive
  const { snapshotAt } = bundle
  const date = (key: KeyDate["key"]) => keyDates.find((item) => item.key === key) ?? null
  const slot = date("pickup_slot") ?? date("requested_pickup")
  const promise = date("promise")
  const eta = date("eta")
  const delivered = date("delivered")
  const active = assignments.find((item) => item.status === "IN_PROGRESS") ?? assignments.find((item) => item.status === "ASSIGNED") ?? assignments.find((item) => item.status === "COMPLETED") ?? null
  const offer = offers.find((item) => item.status === "ACCEPTED") ?? offers.find((item) => item.status === "PUBLISHED") ?? offers[0] ?? null
  const tiles: Tile[] = []
  tiles.push(slot ? {
    label: slot.key === "requested_pickup" ? "Requested pickup" : "Pickup", value: fmtRange(slot.start, slot.end, slot.zone),
    hint: slot.note, tone: slot.tone,
  } : { label: "Pickup", value: "No slot yet", hint: "availability not selected", tone: "neutral" })
  tiles.push(delivered ? {
    label: "Delivered", value: fmtDateTime(delivered.start, delivered.zone), hint: promise?.note ?? delivered.note, tone: "ok",
  } : promise ? {
    label: promise.label, value: fmtRange(promise.start, promise.end, promise.zone), hint: promise.note, tone: promise.tone,
  } : { label: "Delivery", value: "No promise yet", hint: null, tone: "neutral" })
  tiles.push(active ? {
    label: "Driver", value: active.driver.name, hint: `${active.statusLabel}${active.driverHome ? ` · home base ${active.driverHome}` : ""}`,
    tone: active.status === "IN_PROGRESS" ? "accent" : "neutral", href: active.driver.id ? `/drivers/${active.driver.id}` : null,
  } : { label: "Driver", value: "Nobody yet", hint: offer?.status === "PUBLISHED" ? "offer is on the market" : "not on the market", tone: "warn" })
  if (eta && !delivered) {
    tiles.push({ label: "ETA", value: fmtDateTime(eta.start, eta.zone), hint: eta.note, tone: eta.tone })
  } else {
    tiles.push(offer ? {
      label: "Driver fee", value: offer.fee ?? "No fee", hint: `${offer.statusLabel.toLowerCase()} offer${offer.publishedAt ? `, published ${relativeTo(offer.publishedAt, snapshotAt)?.text ?? ""}` : ""}`,
      tone: offer.status === "PUBLISHED" ? "accent" : "neutral",
    } : { label: "Driver fee", value: "No offer yet", hint: null, tone: "neutral" })
  }
  return tiles
}

export function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
}

export { windowSource, latestTracking }
