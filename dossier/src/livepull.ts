// The live pull: what the app (the world the demo moves) has recorded about an order since the snapshot, typed into
// the dossier's live input. One HTTP call to the app; when it does not answer, the dossier is built without live
// data and says so (pulledFrom null), it never fails.
import { DtcCode, GpsFix, ObdReading, AppCase, AppEvent, PhoneState, emptyLive, type Live, type TelemetrySample } from "./live"
import type { Dataset } from "./build"

export const APP_URL = process.env.APP_URL ?? "http://127.0.0.1:8797"

type Row = { id: string; at: string; vehicleId: string | null; data: Record<string, unknown> }
type Payload = {
  now: string
  order: { id: string; reference: string }
  car: { phone: "LIVE" | "STALE" | "NONE"; phoneNote: string | null; driverId: string; lastGpsAt: string | null; codes: string[]; mil: string } | null
  telemetry: { gps: Row[]; obd: Row[] }
  events: { id: string; caseId: string | null; at: string; actorType: string; actorId: string | null; kind: string; channel: string; body: string }[]
  cases: { id: string; kind: string; status: string; urgency: string; title: string; summary: string; openedAt: string; updatedAt: string; waitingFor: string | null; nextCheckAt: string | null }[]
  /** Messages written in the app's helpdesk since the snapshot (the dataset's own messages are already in the dossier). */
  messages?: { id: string; conversationId: string; at: string; authorType: string; authorId: string | null; channel: string; body: string; internal: boolean }[]
}

/** A helpdesk message as an app event: who wrote it and over which line, in the dossier's vocabulary. */
export function mapMessage(m: NonNullable<Payload["messages"]>[number], orderId: string): AppEvent | null {
  const actor = m.authorType === "site_contact" || m.authorType === "handoff_contact" ? "site" : m.authorType
  const channel = m.internal || m.channel === "internal_note" ? "internal"
    : m.channel === "email" || m.channel === "customer_email" ? "customer_email"
    : m.channel === "site_chat" || m.channel === "site_call" ? "site_chat"
    : m.channel === "support_chat" ? "operator_chat" : "driver_chat"
  const r = AppEvent.safeParse({ kind: "APP_EVENT", id: m.id, orderId, caseId: null, at: m.at, actor, actorId: m.authorId, eventKind: m.internal ? "note" : "message", channel, text: `(helpdesk, ${m.channel}, thread ${m.conversationId}) ${m.body}`.slice(0, 1000) })
  return r.success ? r.data : null
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)
/** Record ids must look like ids; the app's do ("evt-…", "tel-…", "case-…"), anything else is skipped rather than guessed. */
const idOk = (v: string) => /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(v)

export function mapGps(row: Row, orderId: string, assignmentId: string): TelemetrySample | null {
  const lat = num(row.data.lat), lng = num(row.data.lng)
  if (lat == null || lng == null || !idOk(row.id)) return null
  const heading = num(row.data.heading)
  const r = GpsFix.safeParse({
    kind: "GPS", id: row.id, orderId, assignmentId, at: row.at, receivedAt: row.at, lat, lng,
    accuracyM: Math.max(0, num(row.data.accuracy_m) ?? 0), speedKmh: num(row.data.speed_kmh) == null ? null : Math.max(0, num(row.data.speed_kmh)!),
    headingDeg: heading == null ? null : ((heading % 360) + 360) % 360, source: "DRIVER_PHONE", simulated: true,
  })
  return r.success ? r.data : null
}

export function mapObd(row: Row, orderId: string, vehicleId: string): TelemetrySample | null {
  if (!idOk(row.id)) return null
  const d = row.data
  const pid = (k: string) => num(d[k])
  const dtcs = (Array.isArray(d.dtcs) ? d.dtcs : []).filter((c): c is string => typeof c === "string" && DtcCode.safeParse(c).success).map((code) => ({ code, status: "CONFIRMED" as const }))
  const ff = d.freeze_frame as { code?: string; values?: Record<string, unknown> } | null | undefined
  const missing = (["rpm", "coolantC", "shortFuelTrimPct", "longFuelTrimPct", "engineLoadPct", "throttlePct"] as const)
    .filter((k) => pid({ rpm: "rpm", coolantC: "coolant_c", shortFuelTrimPct: "fuel_trim_short_pct", longFuelTrimPct: "fuel_trim_long_pct", engineLoadPct: "engine_load_pct", throttlePct: "throttle_pct" }[k]) == null)
  const r = ObdReading.safeParse({
    kind: "OBD", id: row.id, orderId, vehicleId, at: row.at, receivedAt: row.at,
    pids: { speedKmh: pid("speed_kmh"), rpm: pid("rpm"), engineLoadPct: pid("engine_load_pct"), coolantC: pid("coolant_c"), batteryV: pid("battery_v"), throttlePct: pid("throttle_pct"), shortFuelTrimPct: pid("fuel_trim_short_pct"), longFuelTrimPct: pid("fuel_trim_long_pct") },
    mil: d.mil === "ON" || d.mil === "FLASHING" ? d.mil : "OFF", dtcs,
    freezeFrame: ff?.code && DtcCode.safeParse(ff.code).success ? { dtc: ff.code, speedKmh: num(ff.values?.speed_kmh), rpm: num(ff.values?.rpm), coolantC: num(ff.values?.coolant_c), engineLoadPct: num(ff.values?.engine_load_pct) } : null,
    unsupportedPids: missing, source: "OBD_DONGLE", simulated: true,
  })
  return r.success ? r.data : null
}

/** Types the app's payload. Rows that do not fit are dropped and counted, never coerced. */
export function liveFromPayload(ds: Dataset, orderId: string, p: Payload, stored: Live["calls"]): { live: Live; dropped: number } {
  const assignment = ds.rows.work_assignments.find((a) => a.order_id === orderId && (a.status === "IN_PROGRESS" || a.status === "ASSIGNED")) ?? ds.rows.work_assignments.find((a) => a.order_id === orderId)
  const item = ds.rows.order_items.find((i) => i.order_id === orderId && i.role === "PRIMARY") ?? ds.rows.order_items.find((i) => i.order_id === orderId)
  let dropped = 0
  const keep = <T>(v: T | null): v is T => { if (v == null) dropped++; return v != null }
  const telemetry: TelemetrySample[] = [
    ...p.telemetry.gps.map((row) => mapGps(row, orderId, assignment?.id ?? "asg-none")).filter(keep),
    ...p.telemetry.obd.map((row) => mapObd(row, orderId, item?.vehicle_id ?? "veh-none")).filter(keep),
  ].sort((a, b) => a.at.localeCompare(b.at))
  const events = p.events.map((e) => {
    const r = AppEvent.safeParse({ kind: "APP_EVENT", id: e.id, orderId, caseId: e.caseId && idOk(e.caseId) ? e.caseId : null, at: e.at, actor: e.actorType, actorId: e.actorId, eventKind: e.kind, channel: e.channel, text: e.body.slice(0, 1000) })
    return r.success ? r.data : null
  }).filter(keep)
  for (const m of p.messages ?? []) { const e = mapMessage(m, orderId); if (e) events.push(e); else dropped++ }
  events.sort((a, b) => a.at.localeCompare(b.at))
  const cases = p.cases.map((c) => {
    const r = AppCase.safeParse({ kind: "APP_CASE", id: c.id, orderId, openedAt: c.openedAt, updatedAt: c.updatedAt, caseKind: c.kind, status: c.status, urgency: c.urgency, title: c.title, summary: c.summary, waitingFor: c.waitingFor, nextCheckAt: c.nextCheckAt })
    return r.success ? r.data : null
  }).filter(keep)
  const phone = p.car ? PhoneState.parse({ kind: "PHONE", state: p.car.phone === "LIVE" ? "LIVE" : p.car.phone === "STALE" ? "QUIET" : "OFF", quietFrom: p.car.phone === "STALE" ? p.car.lastGpsAt : null, note: p.car.phoneNote }) : null
  return { live: { ...emptyLive(), calls: stored, telemetry, events, cases, phone, pulledAt: new Date().toISOString(), pulledFrom: APP_URL }, dropped }
}

/** Pulls the app's view of one order. Null when the app is down or does not know the order. */
export async function pullLive(ds: Dataset, orderId: string, reference: string, stored: Live["calls"], base = APP_URL): Promise<{ live: Live; asOf: string; dropped: number } | null> {
  try {
    const res = await fetch(`${base}/api/live/${encodeURIComponent(reference)}`, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return null
    const p = (await res.json()) as Payload
    const { live, dropped } = liveFromPayload(ds, orderId, p, stored)
    return { live, asOf: p.now, dropped }
  } catch { return null }
}
