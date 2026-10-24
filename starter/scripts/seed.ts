import "dotenv/config"
import { createReadStream } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import * as schema from "../lib/schema"

type SourceRow = Record<string, unknown> & { id: string; order_id?: string }

// The packet ships its records in ../dataset/data. Set DATASET_DIR to seed another folder with the same files.
const dataset = process.env.DATASET_DIR ?? join(process.cwd(), "..", "dataset", "data")
const url = process.env.DATABASE_URL
if (!url) throw new Error("Set DATABASE_URL before seeding. See .env.example.")

const client = postgres(url, { max: 1 })
const db = drizzle(client, { schema })

async function readCollection(collection: string): Promise<SourceRow[]> {
  const stream = createReadStream(join(dataset, `${collection}.jsonl`), "utf8")
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  const rows: SourceRow[] = []
  for await (const line of lines) if (line.trim()) rows.push(JSON.parse(line) as SourceRow)
  return rows
}

function value(row: SourceRow, key: string): string {
  const result = row[key]
  if (typeof result !== "string") throw new Error(`${row.id}.${key} must be a string`)
  return result
}

function optionalValue(row: SourceRow, key: string): string | null {
  if (row[key] == null) return null
  return value(row, key)
}

function date(row: SourceRow, key: string): Date {
  const parsed = new Date(value(row, key))
  if (Number.isNaN(parsed.getTime())) throw new Error(`${row.id}.${key} is not a date`)
  return parsed
}

async function insertBatches<T extends Record<string, unknown>>(
  rows: T[],
  insert: (batch: T[]) => Promise<unknown>,
): Promise<void> {
  for (let start = 0; start < rows.length; start += 300) await insert(rows.slice(start, start + 300))
}

async function seed(): Promise<void> {
  const core = new Set([
    "customers", "sites", "addresses", "vehicles", "drivers", "orders", "order_items",
    "conversations", "messages", "alerts", "operational_events",
  ])

  const manifest = JSON.parse(await readFile(join(dataset, "manifest.json"), "utf8")) as {
    snapshot_at: string; release_status: string; tables: Record<string, number>
  }
  const collections = Object.keys(manifest.tables).sort()
  const source = new Map<string, SourceRow[]>()
  for (const collection of collections) {
    const collectionRows = await readCollection(collection)
    if (collectionRows.length !== manifest.tables[collection]) {
      throw new Error(`${collection}: manifest expects ${manifest.tables[collection]} rows, found ${collectionRows.length}`)
    }
    source.set(collection, collectionRows)
  }
  const rows = (name: string): SourceRow[] => source.get(name) ?? []
  const planOrder = new Map(rows("transport_plans").map((plan) => [plan.id, value(plan, "order_id")]))

  // A failed insert rolls back the whole replacement, so the app never serves a partial seed.
  await db.transaction(async (tx) => {
    await tx.execute(sql`TRUNCATE dataset_metadata, customers, sites, addresses, vehicles, drivers, orders, order_items, conversations, messages, alerts, operational_events, related_records`)
    await tx.insert(schema.datasetMetadata).values({
      id: "current", snapshotAt: new Date(manifest.snapshot_at),
      releaseStatus: manifest.release_status, details: manifest,
  })

  await insertBatches(rows("customers").map((r) => ({
    id: r.id, name: value(r, "name"), country: value(r, "country"),
    accountTier: value(r, "account_tier"), importBuyer: r.import_buyer === true,
  })), async (batch) => { await tx.insert(schema.customers).values(batch) })
  await insertBatches(rows("sites").map((r) => ({
    id: r.id, customerId: r.customer_id ? value(r, "customer_id") : null,
    name: value(r, "name"), city: value(r, "city"), country: value(r, "country"),
    kind: value(r, "kind"), details: r,
  })), async (batch) => { await tx.insert(schema.sites).values(batch) })
  await insertBatches(rows("addresses").map((r) => ({
    id: r.id, managedSiteId: r.managed_site_id ? value(r, "managed_site_id") : null,
    orderId: r.order_id ? value(r, "order_id") : null,
    name: value(r, "name"), city: value(r, "city"), country: value(r, "country"), details: r,
  })), async (batch) => { await tx.insert(schema.addresses).values(batch) })
  await insertBatches(rows("vehicles").map((r) => ({
    id: r.id, make: value(r, "make"), model: value(r, "model"),
    modelYear: Number(r.model_year), fuel: value(r, "fuel"), registration: optionalValue(r, "registration"),
    syntheticVin: optionalValue(r, "synthetic_vin"),
  })), async (batch) => { await tx.insert(schema.vehicles).values(batch) })
  await insertBatches(rows("drivers").map((r) => ({
    id: r.id, displayName: value(r, "display_name"), homeCity: value(r, "home_city"),
    homeCountry: value(r, "home_country"), details: r,
  })), async (batch) => { await tx.insert(schema.drivers).values(batch) })
  await insertBatches(rows("orders").map((r) => ({
    id: r.id, reference: value(r, "reference"), customerId: value(r, "customer_id"),
    pickupSiteId: r.pickup_site_id ? value(r, "pickup_site_id") : null,
    deliverySiteId: r.delivery_site_id ? value(r, "delivery_site_id") : null,
    pickupAddressId: value(r, "pickup_address_id"), deliveryAddressId: value(r, "delivery_address_id"),
    displayLane: value(r, "display_lane"), status: value(r, "status"),
    routeKind: value(r, "route_kind"), createdAt: date(r, "created_at"),
    updatedAt: date(r, "updated_at"), details: r,
  })), async (batch) => { await tx.insert(schema.orders).values(batch) })
  await insertBatches(rows("order_items").map((r) => ({
    id: r.id, orderId: value(r, "order_id"), vehicleId: value(r, "vehicle_id"),
    role: value(r, "role"), details: r,
  })), async (batch) => { await tx.insert(schema.orderItems).values(batch) })
  await insertBatches(rows("conversations").map((r) => ({
    id: r.id, orderId: value(r, "order_id"), category: value(r, "category"),
    channel: value(r, "channel"), status: value(r, "status"),
    updatedAt: date(r, "updated_at"), details: r,
  })), async (batch) => { await tx.insert(schema.conversations).values(batch) })
  await insertBatches(rows("messages").map((r) => ({
    id: r.id, orderId: value(r, "order_id"), conversationId: value(r, "conversation_id"),
    authorType: value(r, "author_type"), body: value(r, "body"),
    authoredAt: date(r, "authored_at"), details: r,
  })), async (batch) => { await tx.insert(schema.messages).values(batch) })
  await insertBatches(rows("alerts").map((r) => ({
    id: r.id, orderId: value(r, "order_id"), severity: value(r, "severity"),
    signal: value(r, "signal"), status: value(r, "status"),
    summary: value(r, "summary"), triggeredAt: date(r, "triggered_at"), details: r,
  })), async (batch) => { await tx.insert(schema.alerts).values(batch) })
  await insertBatches(rows("operational_events").map((r) => ({
    id: r.id, orderId: value(r, "order_id"), command: value(r, "command"),
    targetType: value(r, "target_type"), targetId: value(r, "target_id"),
    recordedAt: date(r, "recorded_at"), details: r,
  })), async (batch) => { await tx.insert(schema.operationalEvents).values(batch) })

  for (const [collection, collectionRows] of source) {
    if (core.has(collection)) continue
    await insertBatches(collectionRows.map((r) => ({
      collection, id: r.id,
      orderId: r.order_id ?? (
        collection === "transport_points" || collection === "transport_segments"
          ? planOrder.get(value(r, "plan_id")) ?? missingPlan(r)
          : null
      ),
      details: r,
    })), async (batch) => { await tx.insert(schema.relatedRecords).values(batch) })
  }
  })
  console.log(`Seeded ${rows("orders").length} fictional orders and ${[...source.values()].reduce((sum, part) => sum + part.length, 0)} source records.`)
}

function missingPlan(row: SourceRow): never {
  throw new Error(`${row.id} links to a missing transport plan`)
}

seed().finally(async () => { await client.end() })
