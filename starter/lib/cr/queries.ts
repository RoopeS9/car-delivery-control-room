// Reads and writes on our `cr_` tables, shared by the agent, the control room
// and the simulator. Keep business rules (gates, execution) out of here: the
// agent's gate lives in lib/agent. These functions only store and fetch.

import { randomUUID } from "node:crypto"
import { and, asc, desc, eq, gt, gte, inArray, or, sql } from "drizzle-orm"
import { orders } from "@/lib/schema"
import { simNow } from "./clock"
import { crDb } from "./db"
import { crAgentRuns, crAutonomy, crCases, crEvents, crProposals, crTelemetry } from "./schema"
import {
  ACTION_TYPES, LOCKED_ACTIONS, OPEN_CASE_STATUSES,
  type ActionType, type AutonomyLevel, type CaseStatus, type ProposalStatus, type TelemetrySource,
} from "./types"

export type CaseRow = typeof crCases.$inferSelect
export type NewCase = typeof crCases.$inferInsert
export type EventRow = typeof crEvents.$inferSelect
export type NewEvent = typeof crEvents.$inferInsert
export type ProposalRow = typeof crProposals.$inferSelect
export type NewProposal = typeof crProposals.$inferInsert
export type TelemetryRow = typeof crTelemetry.$inferSelect
export type NewTelemetry = typeof crTelemetry.$inferInsert
export type AutonomyRow = typeof crAutonomy.$inferSelect
export type AgentRunRow = typeof crAgentRuns.$inferSelect
export type NewAgentRun = typeof crAgentRuns.$inferInsert

/** A short, readable id such as `case-3f9a1c2b7d10`. */
export function newId(prefix: "case" | "evt" | "prop" | "tel" | "run"): string {
  return `${prefix}-${randomUUID().replace(/-/g, "").slice(0, 12)}`
}

// ---------------------------------------------------------------- orders

/** Accepts an order reference (`CD-420584`) or id (`ord-00584`). Returns both, or null. */
export async function resolveOrder(refOrId: string): Promise<{ id: string; reference: string } | null> {
  const key = refOrId.trim()
  const [row] = await crDb().select({ id: orders.id, reference: orders.reference }).from(orders)
    .where(or(eq(orders.id, key), eq(orders.reference, key.toUpperCase()))).limit(1)
  return row ?? null
}

// ---------------------------------------------------------------- cases

export async function createCase(input: Omit<NewCase, "id" | "openedAt" | "updatedAt"> & { id?: string }): Promise<CaseRow> {
  const now = simNow()
  const [row] = await crDb().insert(crCases).values({ ...input, id: input.id ?? newId("case"), openedAt: now, updatedAt: now }).returning()
  return row
}

export async function updateCase(id: string, patch: Partial<Omit<NewCase, "id" | "openedAt">>): Promise<CaseRow | null> {
  const now = simNow()
  const resolved = patch.status === "RESOLVED" || patch.status === "HANDLED_BY_AGENT"
  const [row] = await crDb().update(crCases)
    .set({ ...patch, updatedAt: now, ...(resolved && patch.resolvedAt === undefined ? { resolvedAt: now } : {}) })
    .where(eq(crCases.id, id)).returning()
  return row ?? null
}

export async function getCase(id: string): Promise<CaseRow | null> {
  const [row] = await crDb().select().from(crCases).where(eq(crCases.id, id)).limit(1)
  return row ?? null
}

export async function listCases(filter: { statuses?: CaseStatus[]; orderId?: string } = {}): Promise<CaseRow[]> {
  const where = and(
    filter.statuses?.length ? inArray(crCases.status, filter.statuses) : undefined,
    filter.orderId ? eq(crCases.orderId, filter.orderId) : undefined,
  )
  return crDb().select().from(crCases).where(where).orderBy(desc(crCases.updatedAt))
}

/** The newest case on an order that is still in front of a person, if any. */
export async function openCaseForOrder(orderId: string): Promise<CaseRow | null> {
  const [row] = await crDb().select().from(crCases)
    .where(and(eq(crCases.orderId, orderId), inArray(crCases.status, [...OPEN_CASE_STATUSES])))
    .orderBy(desc(crCases.updatedAt)).limit(1)
  return row ?? null
}

export type CaseWithProposals = CaseRow & { pendingProposals: ProposalRow[] }

/**
 * Every case still in front of a person, newest first, each with its PENDING
 * proposals. One round trip each, for the queue and the board's attention.
 * Pass `orderId` for a single order.
 */
export async function openCasesWithProposals(orderId?: string): Promise<CaseWithProposals[]> {
  const cases = await crDb().select().from(crCases)
    .where(and(inArray(crCases.status, [...OPEN_CASE_STATUSES]), orderId ? eq(crCases.orderId, orderId) : undefined))
    .orderBy(desc(crCases.updatedAt))
  if (cases.length === 0) return []
  const pending = await crDb().select().from(crProposals)
    .where(and(eq(crProposals.status, "PENDING"), inArray(crProposals.caseId, cases.map((row) => row.id))))
    .orderBy(asc(crProposals.createdAt))
  return cases.map((row) => ({ ...row, pendingProposals: pending.filter((proposal) => proposal.caseId === row.id) }))
}

/** All cases on one order (any status), newest first, each with all of its proposals. */
export async function casesForOrder(orderId: string): Promise<(CaseRow & { proposals: ProposalRow[] })[]> {
  const cases = await crDb().select().from(crCases).where(eq(crCases.orderId, orderId)).orderBy(desc(crCases.updatedAt))
  if (cases.length === 0) return []
  const proposals = await crDb().select().from(crProposals).where(eq(crProposals.orderId, orderId)).orderBy(asc(crProposals.createdAt))
  return cases.map((row) => ({ ...row, proposals: proposals.filter((proposal) => proposal.caseId === row.id) }))
}

// ---------------------------------------------------------------- events

export async function appendEvent(input: Omit<NewEvent, "id" | "at"> & { at?: Date }): Promise<EventRow> {
  const [row] = await crDb().insert(crEvents).values({ ...input, id: newId("evt"), at: input.at ?? simNow() }).returning()
  if (input.caseId) {
    await crDb().update(crCases).set({ updatedAt: row.at }).where(eq(crCases.id, input.caseId))
  }
  return row
}

export async function listEvents(filter: { caseId?: string; orderId?: string; since?: Date; channels?: string[] }): Promise<EventRow[]> {
  const where = and(
    filter.caseId ? eq(crEvents.caseId, filter.caseId) : undefined,
    filter.orderId ? eq(crEvents.orderId, filter.orderId) : undefined,
    filter.since ? gte(crEvents.at, filter.since) : undefined,
    filter.channels?.length ? inArray(crEvents.channel, filter.channels as EventRow["channel"][]) : undefined,
  )
  return crDb().select().from(crEvents).where(where).orderBy(asc(crEvents.at))
}

/** Messages addressed to one recipient (a driver's or a site's feed), oldest first. */
export async function eventsForRecipient(recipientType: string, recipientId: string, since?: Date): Promise<EventRow[]> {
  return crDb().select().from(crEvents)
    .where(and(eq(crEvents.recipientType, recipientType as EventRow["actorType"]), eq(crEvents.recipientId, recipientId), since ? gt(crEvents.at, since) : undefined))
    .orderBy(asc(crEvents.at))
}

/** Attach uploaded photos to the case and message they belong to. */
export async function attachEvents(ids: string[], caseId: string): Promise<void> {
  if (ids.length === 0) return
  await crDb().update(crEvents).set({ caseId }).where(inArray(crEvents.id, ids))
}

export async function getEvent(id: string): Promise<EventRow | null> {
  const [row] = await crDb().select().from(crEvents).where(eq(crEvents.id, id)).limit(1)
  return row ?? null
}

// ---------------------------------------------------------------- proposals

export async function createProposal(input: Omit<NewProposal, "id" | "createdAt" | "status"> & { status?: ProposalStatus }): Promise<ProposalRow> {
  const [row] = await crDb().insert(crProposals)
    .values({ ...input, id: newId("prop"), createdAt: simNow(), status: input.status ?? "PENDING" }).returning()
  return row
}

export async function getProposal(id: string): Promise<ProposalRow | null> {
  const [row] = await crDb().select().from(crProposals).where(eq(crProposals.id, id)).limit(1)
  return row ?? null
}

export async function listProposals(filter: { caseId?: string; orderId?: string; statuses?: ProposalStatus[] } = {}): Promise<ProposalRow[]> {
  const where = and(
    filter.caseId ? eq(crProposals.caseId, filter.caseId) : undefined,
    filter.orderId ? eq(crProposals.orderId, filter.orderId) : undefined,
    filter.statuses?.length ? inArray(crProposals.status, filter.statuses) : undefined,
  )
  return crDb().select().from(crProposals).where(where).orderBy(asc(crProposals.createdAt))
}

/**
 * Update a proposal only if it is still in `fromStatuses`. Returns null when
 * someone else decided it first, so two clicks cannot both execute it.
 */
export async function transitionProposal(
  id: string, fromStatuses: ProposalStatus[], patch: Partial<Omit<NewProposal, "id" | "createdAt">>,
): Promise<ProposalRow | null> {
  const [row] = await crDb().update(crProposals).set(patch)
    .where(and(eq(crProposals.id, id), inArray(crProposals.status, fromStatuses))).returning()
  return row ?? null
}

/** Who brings new facts to a case. Our own agent's and operators' events do not count. */
const OUTSIDE_ACTORS = ["driver", "site", "customer", "obd", "phone"] as const

/**
 * Pending proposals drafted before something new came in from outside (a
 * driver or site message, a photo, new telemetry): the card may be out of
 * date ("Facts changed since this was drafted", PLAN.md 4.2b). Returns the
 * proposal ids, each with the time of the newest such event.
 */
export async function proposalsWithChangedFacts(caseId: string): Promise<{ proposalId: string; changedAt: Date }[]> {
  const pending = await listProposals({ caseId, statuses: ["PENDING"] })
  if (pending.length === 0) return []
  const [latest] = await crDb().select({ at: crEvents.at }).from(crEvents)
    .where(and(eq(crEvents.caseId, caseId), inArray(crEvents.actorType, [...OUTSIDE_ACTORS])))
    .orderBy(desc(crEvents.at)).limit(1)
  if (!latest) return []
  return pending.filter((proposal) => latest.at > proposal.createdAt).map((proposal) => ({ proposalId: proposal.id, changedAt: latest.at }))
}

// ---------------------------------------------------------------- telemetry

export async function insertTelemetry(rows: (Omit<NewTelemetry, "id" | "at"> & { at?: Date })[]): Promise<TelemetryRow[]> {
  if (rows.length === 0) return []
  const now = simNow()
  return crDb().insert(crTelemetry).values(rows.map((row) => ({ ...row, id: newId("tel"), at: row.at ?? now }))).returning()
}

export async function latestTelemetry(orderId: string, source: TelemetrySource): Promise<TelemetryRow | null> {
  const [row] = await crDb().select().from(crTelemetry)
    .where(and(eq(crTelemetry.orderId, orderId), eq(crTelemetry.source, source)))
    .orderBy(desc(crTelemetry.at)).limit(1)
  return row ?? null
}

export async function telemetrySince(orderId: string, since: Date, source?: TelemetrySource): Promise<TelemetryRow[]> {
  return crDb().select().from(crTelemetry)
    .where(and(eq(crTelemetry.orderId, orderId), gte(crTelemetry.at, since), source ? eq(crTelemetry.source, source) : undefined))
    .orderBy(asc(crTelemetry.at))
}

/** Latest phone position per order, for the map. */
export async function latestPositions(): Promise<TelemetryRow[]> {
  const result = await crDb().execute(sql`
    SELECT DISTINCT ON (order_id) id, order_id, vehicle_id, at, source, data, simulated
    FROM cr_telemetry WHERE source = 'PHONE_GPS' ORDER BY order_id, at DESC`)
  return (result as unknown as Record<string, unknown>[]).map((row) => ({
    id: String(row.id), orderId: String(row.order_id), vehicleId: row.vehicle_id ? String(row.vehicle_id) : null,
    at: new Date(String(row.at)), source: "PHONE_GPS", data: row.data as Record<string, unknown>, simulated: Boolean(row.simulated),
  }))
}

// ---------------------------------------------------------------- autonomy

/** Every action type with its level. Missing rows read as ASK_FIRST. Customer contact is always locked. */
export async function listAutonomy(): Promise<AutonomyRow[]> {
  const stored = new Map((await crDb().select().from(crAutonomy)).map((row) => [row.actionType, row]))
  return ACTION_TYPES.map((actionType) => {
    const locked = LOCKED_ACTIONS.includes(actionType)
    const row = stored.get(actionType)
    return {
      actionType,
      level: locked ? "ASK_FIRST" : row?.level ?? "ASK_FIRST",
      locked,
      updatedBy: row?.updatedBy ?? null,
      updatedAt: row?.updatedAt ?? null,
    }
  })
}

export async function getAutonomy(actionType: ActionType): Promise<AutonomyLevel> {
  if (LOCKED_ACTIONS.includes(actionType)) return "ASK_FIRST"
  const [row] = await crDb().select().from(crAutonomy).where(eq(crAutonomy.actionType, actionType)).limit(1)
  return row?.level ?? "ASK_FIRST"
}

/** Refuses to raise a locked action type above ASK_FIRST. */
export async function setAutonomy(actionType: ActionType, level: AutonomyLevel, updatedBy: string): Promise<AutonomyRow> {
  const locked = LOCKED_ACTIONS.includes(actionType)
  if (locked && level !== "ASK_FIRST") throw new Error(`${actionType} is locked to ASK_FIRST`)
  const values = { actionType, level, locked, updatedBy, updatedAt: simNow() }
  const [row] = await crDb().insert(crAutonomy).values(values)
    .onConflictDoUpdate({ target: crAutonomy.actionType, set: { level, updatedBy, updatedAt: values.updatedAt } }).returning()
  return row
}

// ---------------------------------------------------------------- agent runs

export async function startRun(input: Omit<NewAgentRun, "id" | "startedAt" | "status">): Promise<AgentRunRow> {
  const [row] = await crDb().insert(crAgentRuns).values({ ...input, id: newId("run"), startedAt: simNow(), status: "RUNNING" }).returning()
  return row
}

export async function finishRun(id: string, patch: Partial<Omit<NewAgentRun, "id" | "startedAt">>): Promise<AgentRunRow | null> {
  const [row] = await crDb().update(crAgentRuns).set({ finishedAt: simNow(), ...patch }).where(eq(crAgentRuns.id, id)).returning()
  return row ?? null
}

export async function listRuns(filter: { caseId?: string; limit?: number } = {}): Promise<AgentRunRow[]> {
  return crDb().select().from(crAgentRuns)
    .where(filter.caseId ? eq(crAgentRuns.caseId, filter.caseId) : undefined)
    .orderBy(desc(crAgentRuns.startedAt)).limit(filter.limit ?? 50)
}

// ---------------------------------------------------------------- reset

/** Remove every `cr_` row except autonomy settings. Used by the demo reset. */
export async function resetCrData(options: { autonomy?: boolean } = {}): Promise<void> {
  const db = crDb()
  await db.transaction(async (tx) => {
    await tx.delete(crProposals)
    await tx.delete(crEvents)
    await tx.delete(crAgentRuns)
    await tx.delete(crTelemetry)
    await tx.delete(crCases)
    if (options.autonomy) await tx.delete(crAutonomy)
  })
}
