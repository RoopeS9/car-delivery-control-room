// Build a dossier for one order from the validated dataset. Membership rules are explicit; nothing is guessed from text.
import { readFileSync, readdirSync } from "node:fs"
import { RECORDS, type CollectionName } from "./records.generated"
import { COLLECTION_CLASS, type Phase } from "./classes"
import { DATASET_CLASSES, Dossier, type DossierItem, type Membership } from "./dossier"
import { atOf, strengthOf, type RecordOf } from "./strength"
import type { CallRecord, OperatorAction, TelemetrySample } from "./live"

export type Dataset = {
  snapshotAt: string
  rows: { [C in CollectionName]: RecordOf<C>[] }
  /** id -> collections holding a record with that id (ids are unique per collection, not always across them) */
  where: Map<string, CollectionName[]>
}

/** Internal field access on a validated record. Records are already parsed; this only reads link fields by name. */
const field = (r: object, k: string): unknown => (r as Record<string, unknown>)[k]
const str = (v: unknown): string | null => (typeof v === "string" ? v : null)
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [])

export function loadDataset(dir: URL): Dataset {
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", dir), "utf8")) as { snapshot_at: string }
  const rows = {} as Dataset["rows"]
  const where = new Map<string, CollectionName[]>()
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort()) {
    const c = file.slice(0, -6) as CollectionName
    if (!(c in RECORDS)) throw new Error(`no schema for collection ${c}`)
    const parsed = readFileSync(new URL(file, dir), "utf8").split("\n").filter(Boolean)
      .map((line, i) => {
        const r = RECORDS[c].safeParse(JSON.parse(line))
        if (!r.success) throw new Error(`${c} row ${i}: ${r.error.issues[0]?.message} at ${r.error.issues[0]?.path.join(".")}`)
        return r.data
      })
    ;(rows as Record<string, unknown[]>)[c] = parsed
    for (const r of parsed) {
      const id = str(field(r, "id")); if (!id) continue
      const list = where.get(id) ?? []; if (list.includes(c)) throw new Error(`duplicate id ${id} in ${c}`)
      where.set(id, [...list, c])
    }
  }
  return { snapshotAt: manifest.snapshot_at, rows, where }
}

// Fields that hold labels or group keys rather than a record id (checked by the dangling-ref report).
const NOT_RECORD_REFS = new Set(["upload_batch_id", "itinerary_group_id", "thread_id", "option_id", "voice_prompt"])

export function derivePhase(ds: Dataset, orderId: string, asOf: string): { phase: Phase; basis: string } {
  const o = ds.rows.orders.find((r) => r.id === orderId)!
  if (o.cancelled_at) return { phase: "CANCELLED", basis: `cancelled at ${o.cancelled_at}` }
  const t = Date.parse(asOf), day = 24 * 3600e3
  const windows = ds.rows.time_windows.filter((w) => w.order_id === orderId && w.is_selected)
  const slot = windows.find((w) => w.purpose === "SELECTED_PICKUP_SLOT")
  const promise = windows.find((w) => w.purpose === "CUSTOMER_DELIVERY_PROMISE")
  if (o.status === "NEW") {
    if (o.readiness_status !== "CONFIRMED") return { phase: "INTAKE", basis: `order NEW, readiness ${o.readiness_status}` }
    const live = ds.rows.market_offers.some((m) => m.status === "PUBLISHED" && (m.order_id === orderId || strs(field(m, "order_ids")).includes(orderId)))
    return live ? { phase: "MARKET", basis: "readiness CONFIRMED and an offer is published" } : { phase: "READINESS", basis: "readiness CONFIRMED, no published offer" }
  }
  if (o.status === "WAITING_FOR_PICKUP") {
    if (slot && Date.parse(slot.start_at) - t <= day) return { phase: "PICKUP_DUE", basis: `selected pickup slot starts ${slot.start_at}` }
    return { phase: "BOOKED", basis: slot ? `driver booked, pickup slot ${slot.start_at}` : "driver booked, no selected pickup slot" }
  }
  if (o.status === "IN_TRANSIT") {
    if (promise && Date.parse(promise.start_at) - t <= day) return { phase: "DELIVERY_DUE", basis: `delivery promise starts ${promise.start_at}` }
    return { phase: "MOVING", basis: promise ? `in transit, promise ${promise.start_at}` : "in transit, no selected promise" }
  }
  const stillMoving = ds.rows.work_assignments.some((a) => a.order_id === orderId && a.status === "IN_PROGRESS")
  return stillMoving ? { phase: "MOVING", basis: "primary car delivered, another item (trade-in) still in progress" } : { phase: "AFTER", basis: "delivered" }
}

export function buildDossier(ds: Dataset, orderId: string, live: { calls: CallRecord[]; telemetry: TelemetrySample[]; operatorActions: OperatorAction[] } = { calls: [], telemetry: [], operatorActions: [] }, asOf = ds.snapshotAt): Dossier {
  const order = ds.rows.orders.find((r) => r.id === orderId)
  if (!order) throw new Error(`no order ${orderId}`)
  const picked = new Map<string, { c: CollectionName; r: object; m: Membership }>()
  const add = (c: CollectionName, r: object, m: Membership) => {
    const id = str(field(r, "id"))!; const key = `${c}:${id}`
    const prev = picked.get(key)
    if (!prev || rank(m) < rank(prev.m)) picked.set(key, { c, r, m })
  }
  const rank = (m: Membership) => (m === "DIRECT" ? 0 : m === "JOINED" ? 1 : 2)
  const byId = <C extends CollectionName>(c: C, ids: Iterable<string | null>, m: Membership) => {
    const want = new Set([...ids].filter((x): x is string => !!x))
    for (const r of ds.rows[c] as object[]) if (want.has(str(field(r, "id"))!)) add(c, r, m)
  }
  const ofPicked = (c: CollectionName) => [...picked.values()].filter((p) => p.c === c).map((p) => p.r)
  const ids = (c: CollectionName, k: string) => ofPicked(c).flatMap((r) => [str(field(r, k)), ...strs(field(r, k))]).filter((x): x is string => !!x)

  // 1. DIRECT: records that name the order.
  add("orders", order, "DIRECT")
  for (const c of Object.keys(ds.rows) as CollectionName[]) {
    for (const r of ds.rows[c] as object[]) if (field(r, "order_id") === orderId) add(c, r, "DIRECT")
  }
  // 2. JOINED through secondary order lists.
  for (const m of ds.rows.market_offers) if (strs(field(m, "order_ids")).includes(orderId)) add("market_offers", m, "JOINED")
  for (const c of ["conversations", "work_items"] as const) for (const r of ds.rows[c] as object[]) if (strs(field(r, "related_order_ids")).includes(orderId)) add(c, r, "JOINED")
  for (const t of ds.rows.support_inbox_threads) {
    if (t.linked_order_ids.includes(orderId)) add("support_inbox_threads", t, "JOINED")
    else if (t.candidate_order_ids.includes(orderId)) add("support_inbox_threads", t, "CANDIDATE")
  }
  // 3. JOINED through links, in dependency order.
  byId("customers", [order.customer_id], "JOINED")
  byId("vehicles", ids("order_items", "vehicle_id"), "JOINED")
  const planIds = new Set(ids("transport_plans", "id"))
  for (const p of ds.rows.transport_points) if (planIds.has(p.plan_id)) add("transport_points", p, "JOINED")
  for (const s of ds.rows.transport_segments) if (planIds.has(s.plan_id)) add("transport_segments", s, "JOINED")
  byId("sites", [order.pickup_site_id, order.delivery_site_id, ...ids("transport_points", "site_id"), ...ids("order_endpoint_details", "site_id"),
    ...ids("site_visits", "site_id"), ...ids("custody_assets", "site_id")], "JOINED")
  byId("addresses", [order.pickup_address_id, order.delivery_address_id, ...ids("transport_points", "address_id"),
    ...ids("order_endpoint_details", "address_id"), ...ids("sites", "address_id")], "JOINED")
  byId("drivers", [...ids("work_assignments", "driver_id"), ...ids("expenses", "driver_id"), ...ids("custody_reports", "driver_id"),
    ...ids("market_offer_exposures", "driver_id"), ...ids("travel_confirmations", "reporter_driver_id")], "JOINED")
  byId("ferry_terminals", [...ids("travel_reservations", "origin_terminal_id"), ...ids("travel_reservations", "destination_terminal_id"),
    ...ids("ferry_terminal_events", "terminal_id")], "JOINED")
  byId("terminal_road_estimates", ids("travel_reservations", "terminal_road_estimate_id"), "JOINED")
  const threadIds = new Set(ids("support_inbox_threads", "id"))
  for (const m of ds.rows.support_inbox_messages) {
    const t = ds.rows.support_inbox_threads.find((x) => x.id === m.thread_id)
    if (threadIds.has(m.thread_id)) add("support_inbox_messages", m, t && t.linked_order_ids.includes(orderId) ? "JOINED" : "CANDIDATE")
  }
  // 4. DIRECTORY: any operator or agent named by a picked record.
  const mentioned = new Set<string>()
  const scan = (v: unknown) => {
    if (typeof v === "string") mentioned.add(v)
    else if (Array.isArray(v)) v.forEach(scan)
    else if (v && typeof v === "object") Object.values(v).forEach(scan)
  }
  for (const p of picked.values()) scan(p.r)
  byId("operators", [...mentioned], "JOINED")
  byId("agents", [...mentioned], "JOINED")

  // Integrity: link fields that point at nothing in the dataset.
  const danglingRefs: { fromCollection: string; fromId: string; field: string; id: string }[] = []
  const check = (c: CollectionName, id: string, path: string, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) { for (const [k, x] of Object.entries(v)) check(c, id, path ? `${path}.${k}` : k, x); return }
    if (Array.isArray(v)) { v.forEach((x) => check(c, id, `${path}[]`, x)); return }
    const leaf = path.split(".").pop()!.replace("[]", "")
    const isRef = leaf.endsWith("_id") || leaf.endsWith("_ids") || (leaf === "id" && path.includes("refs"))
    if (isRef && typeof v === "string" && !NOT_RECORD_REFS.has(leaf) && !ds.where.has(v)) danglingRefs.push({ fromCollection: c, fromId: id, field: path, id: v })
  }
  for (const p of picked.values()) check(p.c, str(field(p.r, "id"))!, "", p.r)

  // Assemble classes, newest first inside each class (undated reference items last).
  const classes = Object.fromEntries(DATASET_CLASSES.map((k) => [k, [] as DossierItem[]])) as Record<(typeof DATASET_CLASSES)[number], DossierItem[]>
  for (const p of picked.values()) {
    const rec = p.r as RecordOf<typeof p.c>
    classes[COLLECTION_CLASS[p.c]].push({
      collection: p.c, id: str(field(p.r, "id"))!, at: atOf(p.c, rec as never), strength: strengthOf(p.c, rec as never), membership: p.m, record: rec,
    } as DossierItem)
  }
  for (const k of DATASET_CLASSES) classes[k].sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "") || a.id.localeCompare(b.id))

  return Dossier.parse({
    schemaVersion: 1,
    order: { id: order.id, reference: order.reference, customerId: order.customer_id },
    asOf, builtAt: new Date().toISOString(),
    phase: derivePhase(ds, orderId, asOf),
    classes, live, integrity: { danglingRefs },
  })
}
