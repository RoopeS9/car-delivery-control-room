import { boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core"

export const datasetMetadata = pgTable("dataset_metadata", {
  id: text("id").primaryKey(),
  snapshotAt: timestamp("snapshot_at", { withTimezone: true }).notNull(),
  releaseStatus: text("release_status").notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().notNull(),
})

export const customers = pgTable("customers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  country: text("country").notNull(),
  accountTier: text("account_tier").notNull(),
  importBuyer: boolean("import_buyer").notNull(),
})

export const sites = pgTable("sites", {
  id: text("id").primaryKey(),
  customerId: text("customer_id").references(() => customers.id),
  name: text("name").notNull(),
  city: text("city").notNull(),
  country: text("country").notNull(),
  kind: text("kind").notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().notNull(),
})

export const addresses = pgTable("addresses", {
  id: text("id").primaryKey(),
  managedSiteId: text("managed_site_id").references(() => sites.id),
  orderId: text("order_id"),
  name: text("name").notNull(),
  city: text("city").notNull(),
  country: text("country").notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().notNull(),
})

export const vehicles = pgTable("vehicles", {
  id: text("id").primaryKey(),
  make: text("make").notNull(),
  model: text("model").notNull(),
  modelYear: integer("model_year").notNull(),
  fuel: text("fuel").notNull(),
  registration: text("registration"),
  syntheticVin: text("synthetic_vin"),
})

export const drivers = pgTable("drivers", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  homeCity: text("home_city").notNull(),
  homeCountry: text("home_country").notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().notNull(),
})

export const orders = pgTable("orders", {
  id: text("id").primaryKey(),
  reference: text("reference").notNull().unique(),
  customerId: text("customer_id").notNull().references(() => customers.id),
  pickupSiteId: text("pickup_site_id").references(() => sites.id),
  deliverySiteId: text("delivery_site_id").references(() => sites.id),
  pickupAddressId: text("pickup_address_id").notNull().references(() => addresses.id),
  deliveryAddressId: text("delivery_address_id").notNull().references(() => addresses.id),
  displayLane: text("display_lane").notNull(),
  status: text("status").notNull(),
  routeKind: text("route_kind").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().notNull(),
}, (table) => [index("orders_lane_updated_idx").on(table.displayLane, table.updatedAt)])

export const orderItems = pgTable("order_items", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().references(() => orders.id),
  vehicleId: text("vehicle_id").notNull().references(() => vehicles.id),
  role: text("role").notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().notNull(),
}, (table) => [index("order_items_order_idx").on(table.orderId)])

export const conversations = pgTable("conversations", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().references(() => orders.id),
  category: text("category").notNull(),
  channel: text("channel").notNull(),
  status: text("status").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().notNull(),
}, (table) => [index("conversations_order_idx").on(table.orderId)])

export const messages = pgTable("messages", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().references(() => orders.id),
  conversationId: text("conversation_id").notNull().references(() => conversations.id),
  authorType: text("author_type").notNull(),
  body: text("body").notNull(),
  authoredAt: timestamp("authored_at", { withTimezone: true }).notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().notNull(),
}, (table) => [index("messages_conversation_idx").on(table.conversationId, table.authoredAt)])

export const alerts = pgTable("alerts", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().references(() => orders.id),
  severity: text("severity").notNull(),
  signal: text("signal").notNull(),
  status: text("status").notNull(),
  summary: text("summary").notNull(),
  triggeredAt: timestamp("triggered_at", { withTimezone: true }).notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().notNull(),
}, (table) => [index("alerts_order_idx").on(table.orderId)])

export const operationalEvents = pgTable("operational_events", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().references(() => orders.id),
  command: text("command").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().notNull(),
}, (table) => [index("events_order_time_idx").on(table.orderId, table.recordedAt)])

// Less frequently queried types remain accessible without flattening away their source fields.
export const relatedRecords = pgTable("related_records", {
  collection: text("collection").notNull(),
  id: text("id").notNull(),
  orderId: text("order_id").references(() => orders.id),
  details: jsonb("details").$type<Record<string, unknown>>().notNull(),
}, (table) => [
  primaryKey({ columns: [table.collection, table.id] }),
  index("related_records_order_idx").on(table.orderId, table.collection),
])
