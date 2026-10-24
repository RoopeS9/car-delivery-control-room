// The operator's helpdesk on the server: writing to a conversation on an order, opening one, answering and linking an
// inbox thread, and asking the dossier service for drafts. Every write is the operator's own ("ops-support", the
// Support desk role); the agent never writes here. New rows keep the dataset's record shape so every reader
// (the order page, the inbox, the dossier's live pull) sees them like any other message.
import { and, eq, like } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import { simNowIso } from "@/lib/cr/clock"
import { db } from "@/lib/db"
import { conversations, messages, orders, relatedRecords } from "@/lib/schema"
import type { InboxThreadView, ThreadView } from "./types"

export const OPERATOR_ID = "ops-support"
const APP_PREFIX = "app-"

export class HelpdeskError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

const id = (prefix: string) => `${prefix}-${APP_PREFIX}${randomUUID().replace(/-/g, "").slice(0, 12)}`
const clean = (value: unknown, max = 4000): string => {
  const text = typeof value === "string" ? value.replace(/\r\n/g, "\n").trim() : ""
  if (!text) throw new HelpdeskError(400, "Write something first.")
  if (text.length > max) throw new HelpdeskError(400, `Keep it under ${max} characters.`)
  return text
}

export const CONVERSATION_CATEGORIES = ["pickup_and_release", "schedule_and_eta", "delivery_and_receiver", "documents_and_proof", "driver_travel", "driver_availability", "ferry_and_route", "vehicle_condition", "vehicle_custody", "order_information", "order_change", "costs_and_payments"] as const
export const CONVERSATION_CHANNELS = ["support_chat", "email", "driver_chat", "whatsapp", "site_chat"] as const
export const COUNTERPARTY_TYPES = ["customer", "driver", "site_contact", "handoff_contact"] as const
type CounterpartyType = (typeof COUNTERPARTY_TYPES)[number]

/** Messages the helpdesk wrote on this order since the snapshot, for the dossier's live pull. */
export async function appMessagesFor(orderId: string) {
  const rows = await db.select().from(messages).where(and(eq(messages.orderId, orderId), like(messages.id, `msg-${APP_PREFIX}%`)))
  return rows.map((row) => ({
    id: row.id, conversationId: row.conversationId, at: row.authoredAt.toISOString(), authorType: row.authorType,
    authorId: typeof row.details.author_id === "string" ? row.details.author_id : null,
    channel: typeof row.details.channel === "string" ? row.details.channel : "support_chat", body: row.body,
    internal: row.details.visibility === "INTERNAL",
  }))
}

/** The operator writes on a conversation: a reply to its counterparty, or an internal note nobody outside sees. */
export async function postThreadMessage(conversationId: string, input: { body?: unknown; internal?: unknown; language?: unknown }) {
  const body = clean(input.body)
  const internal = input.internal === true
  const [thread] = await db.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1)
  if (!thread) throw new HelpdeskError(404, "No such conversation.")
  const at = simNowIso()
  const details = {
    author_id: OPERATOR_ID, author_type: "operator", authored_at: at, body,
    channel: internal ? "internal_note" : thread.channel, conversation_id: conversationId, id: id("msg"),
    language: typeof input.language === "string" && input.language ? input.language : null, order_id: thread.orderId,
    recipient_id: internal ? OPERATOR_ID : typeof thread.details.counterparty_id === "string" ? thread.details.counterparty_id : null,
    recipient_type: internal ? "operator" : typeof thread.details.counterparty_type === "string" ? thread.details.counterparty_type : null,
    visibility: internal ? "INTERNAL" : "PUBLIC",
  }
  await db.transaction(async (tx) => {
    await tx.insert(messages).values({ id: details.id, orderId: thread.orderId, conversationId, authorType: "operator", body, authoredAt: new Date(at), details })
    // A reply reopens a closed thread and moves it up; a note only moves it up.
    await tx.update(conversations).set({ updatedAt: new Date(at), status: internal ? thread.status : "OPEN", details: { ...thread.details, status: internal ? thread.status : "OPEN", updated_at: at } }).where(eq(conversations.id, conversationId))
  })
  return details
}

/** Close or reopen a conversation. */
export async function setThreadStatus(conversationId: string, status: unknown) {
  if (status !== "OPEN" && status !== "CLOSED") throw new HelpdeskError(400, "Status must be OPEN or CLOSED.")
  const [thread] = await db.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1)
  if (!thread) throw new HelpdeskError(404, "No such conversation.")
  const at = simNowIso()
  await db.update(conversations).set({ status, updatedAt: new Date(at), details: { ...thread.details, status, updated_at: at, ...(status === "CLOSED" ? { waiting_on: null } : {}) } }).where(eq(conversations.id, conversationId))
  return { id: conversationId, status }
}

/** The operator opens a conversation with one of the order's parties and writes its first message. */
export async function openConversation(orderId: string, input: { category?: unknown; channel?: unknown; counterpartyType?: unknown; counterpartyId?: unknown; counterpartyName?: unknown; body?: unknown; language?: unknown }) {
  const [order] = await db.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).limit(1)
  if (!order) throw new HelpdeskError(404, "No such order.")
  const category = (CONVERSATION_CATEGORIES as readonly string[]).includes(String(input.category)) ? String(input.category) : "order_information"
  const channel = (CONVERSATION_CHANNELS as readonly string[]).includes(String(input.channel)) ? String(input.channel) : "support_chat"
  const counterpartyType = (COUNTERPARTY_TYPES as readonly string[]).includes(String(input.counterpartyType)) ? (String(input.counterpartyType) as CounterpartyType) : null
  const counterpartyId = typeof input.counterpartyId === "string" && input.counterpartyId ? input.counterpartyId : null
  if (!counterpartyType || !counterpartyId) throw new HelpdeskError(400, "Choose who this conversation is with.")
  const body = clean(input.body)
  const at = simNowIso()
  const conversationId = id("conv")
  const details: Record<string, unknown> = {
    assignment_id: null, category, channel, counterparty_id: counterpartyId, counterparty_type: counterpartyType, id: conversationId,
    order_id: orderId, started_at: at, status: "OPEN", updated_at: at, waiting_on: "COUNTERPARTY_REPLY",
    ...(typeof input.counterpartyName === "string" && input.counterpartyName ? { counterparty_name_snapshot: input.counterpartyName } : {}),
  }
  await db.insert(conversations).values({ id: conversationId, orderId, category, channel, status: "OPEN", updatedAt: new Date(at), details })
  const message = await postThreadMessage(conversationId, { body, language: input.language })
  return { conversation: details, message }
}

/**
 * A message the case engine sent on an operator's approval is also a message in the order's conversations: it goes
 * into the thread with that party of the matching category (opened if there is none), so the Conversations section
 * and the inbox show it like any other. Phone-call talking points are not messages and are not filed.
 */
export async function recordSentDraft(input: { orderId: string; caseKind: string; by: string; at: string; draft: { to_type: "customer" | "site" | "driver"; to_id: string; to_name: string; channel: string; subject?: string | null; body: string; language?: string | null } }) {
  const { draft } = input
  if (draft.channel === "phone_call") return null
  const category = CASE_CATEGORY[input.caseKind] ?? "order_information"
  const channel = draft.channel === "email" ? "email" : draft.to_type === "driver" ? "driver_chat" : draft.channel === "sms" ? "whatsapp" : draft.to_type === "site" ? "site_chat" : "support_chat"
  const counterpartyType = draft.to_type === "site" ? "site_contact" : draft.to_type
  const open = await db.select().from(conversations).where(and(eq(conversations.orderId, input.orderId), eq(conversations.status, "OPEN")))
  let thread = open.find((row) => row.details.counterparty_id === draft.to_id && row.category === category) ?? open.find((row) => row.details.counterparty_id === draft.to_id) ?? null
  if (!thread) {
    const conversationId = id("conv")
    const details: Record<string, unknown> = {
      assignment_id: null, category, channel, counterparty_id: draft.to_id, counterparty_type: counterpartyType, counterparty_name_snapshot: draft.to_name,
      id: conversationId, order_id: input.orderId, started_at: input.at, status: "OPEN", updated_at: input.at, waiting_on: "COUNTERPARTY_REPLY", opened_by_case: true,
    }
    await db.insert(conversations).values({ id: conversationId, orderId: input.orderId, category, channel, status: "OPEN", updatedAt: new Date(input.at), details })
    ;[thread] = await db.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1)
  }
  if (!thread) return null
  const message = {
    author_id: input.by, author_type: "operator", authored_at: input.at, body: draft.subject ? `${draft.subject}\n\n${draft.body}` : draft.body,
    channel: thread.channel, conversation_id: thread.id, id: id("msg"), language: draft.language ?? null, order_id: input.orderId,
    recipient_id: draft.to_id, recipient_type: counterpartyType, visibility: "PUBLIC", sent_by_case: true,
  }
  await db.insert(messages).values({ id: message.id, orderId: input.orderId, conversationId: thread.id, authorType: "operator", body: message.body, authoredAt: new Date(input.at), details: message })
  await db.update(conversations).set({ updatedAt: new Date(input.at), details: { ...thread.details, updated_at: input.at, waiting_on: "COUNTERPARTY_REPLY" } }).where(eq(conversations.id, thread.id))
  return { conversationId: thread.id, messageId: message.id }
}

/** A message the customer wrote (a simulated email in this prototype), filed in the order's conversation with them. */
export async function recordInboundCustomer(input: { orderId: string; caseKind: string; customerId: string; customerName: string; at: string; body: string }) {
  const category = CASE_CATEGORY[input.caseKind] ?? "order_information"
  const open = await db.select().from(conversations).where(and(eq(conversations.orderId, input.orderId), eq(conversations.status, "OPEN")))
  let thread = open.find((row) => row.details.counterparty_id === input.customerId && row.category === category) ?? open.find((row) => row.details.counterparty_id === input.customerId) ?? null
  if (!thread) {
    const conversationId = id("conv")
    const details: Record<string, unknown> = {
      assignment_id: null, category, channel: "email", counterparty_id: input.customerId, counterparty_type: "customer", counterparty_name_snapshot: input.customerName,
      id: conversationId, order_id: input.orderId, started_at: input.at, status: "OPEN", updated_at: input.at, waiting_on: null, opened_by_case: true,
    }
    await db.insert(conversations).values({ id: conversationId, orderId: input.orderId, category, channel: "email", status: "OPEN", updatedAt: new Date(input.at), details })
    ;[thread] = await db.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1)
  }
  if (!thread) return null
  const message = {
    author_id: input.customerId, author_type: "customer", authored_at: input.at, body: input.body, channel: thread.channel, conversation_id: thread.id,
    id: id("msg"), language: null, order_id: input.orderId, recipient_id: null, recipient_type: "operator", visibility: "PUBLIC", simulated: true,
  }
  await db.insert(messages).values({ id: message.id, orderId: input.orderId, conversationId: thread.id, authorType: "customer", body: input.body, authoredAt: new Date(input.at), details: message })
  await db.update(conversations).set({ updatedAt: new Date(input.at), details: { ...thread.details, updated_at: input.at, waiting_on: null } }).where(eq(conversations.id, thread.id))
  return { conversationId: thread.id, messageId: message.id }
}

/** The conversation category a case's message belongs to. */
const CASE_CATEGORY: Record<string, string> = {
  VEHICLE_WARNING: "vehicle_condition", BREAKDOWN: "vehicle_condition", ACCIDENT: "vehicle_condition", DELAY: "schedule_and_eta", MISSED_CONNECTION: "ferry_and_route",
  KEYS_ACCESS: "vehicle_custody", EXPENSE: "costs_and_payments", DRIVER_QUESTION: "driver_travel", SITE_QUESTION: "pickup_and_release", OPERATOR_QUESTION: "order_information", HANDOVER: "delivery_and_receiver", CUSTOMER_MESSAGE: "order_information",
}

// ---------------------------------------------------------------- the inbox

async function inboxThread(threadId: string) {
  const [row] = await db.select().from(relatedRecords).where(and(eq(relatedRecords.collection, "support_inbox_threads"), eq(relatedRecords.id, threadId))).limit(1)
  if (!row) throw new HelpdeskError(404, "No such inbox thread.")
  return row
}

/** The operator answers an inbox thread (or files a note on it). */
export async function postInboxMessage(threadId: string, input: { body?: unknown; internal?: unknown; language?: unknown }) {
  const body = clean(input.body)
  const internal = input.internal === true
  const row = await inboxThread(threadId)
  const thread = row.details
  const at = simNowIso()
  const details = {
    author_id: OPERATOR_ID, author_type: "operator", authored_at: at, body,
    channel: internal ? "internal_note" : typeof thread.channel === "string" ? thread.channel : "email", id: id("inboxmsg"),
    language: typeof input.language === "string" && input.language ? input.language : null,
    recipient_id: internal ? OPERATOR_ID : typeof thread.counterparty_id === "string" ? thread.counterparty_id : null,
    recipient_type: internal ? "operator" : typeof thread.counterparty_type === "string" ? thread.counterparty_type : null,
    thread_id: threadId, visibility: internal ? "INTERNAL" : "PUBLIC",
  }
  await db.transaction(async (tx) => {
    await tx.insert(relatedRecords).values({ collection: "support_inbox_messages", id: details.id, orderId: row.orderId, details })
    await tx.update(relatedRecords).set({ details: { ...thread, updated_at: at, status: internal ? thread.status : "OPEN" } })
      .where(and(eq(relatedRecords.collection, "support_inbox_threads"), eq(relatedRecords.id, threadId)))
  })
  return details
}

/**
 * Resolve an inbox thread: link it to one order (by id or reference), declare that no order is needed, or close it.
 * Linking files the thread and its messages under that order, so the order page shows them too.
 */
export async function updateInboxThread(threadId: string, input: { link?: unknown; noOrder?: unknown; status?: unknown }) {
  const row = await inboxThread(threadId)
  const thread = { ...row.details }
  const at = simNowIso()
  let orderId = row.orderId
  if (typeof input.link === "string" && input.link.trim()) {
    const key = input.link.trim()
    const [order] = await db.select({ id: orders.id, reference: orders.reference }).from(orders).where(eq(orders.id, key)).limit(1)
      .then(async (found) => found.length ? found : db.select({ id: orders.id, reference: orders.reference }).from(orders).where(eq(orders.reference, key.toUpperCase())).limit(1))
    if (!order) throw new HelpdeskError(404, `No order ${key}.`)
    orderId = order.id
    Object.assign(thread, { link_state: "CONFIRMED_SINGLE", linked_order_ids: [order.id], resolution: { decided_at: at, decision: "LINK_ONE_ORDER", decided_by: OPERATOR_ID }, waiting_on: null })
  } else if (input.noOrder === true) {
    Object.assign(thread, { link_state: "NO_ORDER_REQUIRED", linked_order_ids: [], resolution: { decided_at: at, decision: "ANSWER_GENERAL_POLICY", decided_by: OPERATOR_ID }, waiting_on: null })
  }
  if (input.status === "OPEN" || input.status === "CLOSED") thread.status = input.status
  thread.updated_at = at
  await db.transaction(async (tx) => {
    await tx.update(relatedRecords).set({ details: thread, orderId }).where(and(eq(relatedRecords.collection, "support_inbox_threads"), eq(relatedRecords.id, threadId)))
    if (orderId !== row.orderId) {
      const msgs = await tx.select({ id: relatedRecords.id, details: relatedRecords.details }).from(relatedRecords).where(eq(relatedRecords.collection, "support_inbox_messages"))
      for (const message of msgs.filter((m) => m.details.thread_id === threadId)) {
        await tx.update(relatedRecords).set({ orderId }).where(and(eq(relatedRecords.collection, "support_inbox_messages"), eq(relatedRecords.id, message.id)))
      }
    }
  })
  return thread
}

// ---------------------------------------------------------------- drafts from the dossier

const SERVICE = process.env.CALL_SERVICE_URL ?? "http://127.0.0.1:8799"

export type Suggestion = { stance: "ANSWER" | "ASK" | "HOLD" | "ESCALATE" | "IDENTIFY"; label: string; body: string; basis: string[]; caution: string | null }
export type SuggestResult = { language: string; summary: string; suggestions: Suggestion[]; internalNote: string | null; model: string; costUsd: number | null; at: string }

type ThreadLike = Pick<ThreadView | InboxThreadView, "category" | "channel" | "counterparty" | "messages">

function flatten(thread: ThreadLike) {
  return {
    category: thread.category, channel: thread.channel,
    counterparty: thread.counterparty ? { kind: thread.counterparty.kind, name: thread.counterparty.name } : null,
    messages: thread.messages.slice(-40).map((message) => ({ who: message.author.name, kind: message.author.kind, at: message.at, body: message.body, internal: message.internal })),
  }
}

/** Drafts for one thread from the dossier service. `reference` is the linked order's, or null when none is linked. */
export async function suggestFor(reference: string | null, thread: ThreadLike, extra: { intent?: string | undefined; candidates?: { reference: string; line: string }[] | undefined } = {}): Promise<SuggestResult> {
  const payload = { thread: { ...flatten(thread), ...(extra.intent ? { intent: extra.intent } : {}), ...(extra.candidates?.length ? { candidates: extra.candidates } : {}) } }
  let response: Response
  try {
    response = await fetch(`${SERVICE}/suggest/${encodeURIComponent(reference ?? "-")}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), cache: "no-store", signal: AbortSignal.timeout(150_000) })
  } catch {
    throw new HelpdeskError(502, "The dossier service is not reachable, so there are no drafts. You can still write your own reply.")
  }
  const text = await response.text()
  if (!response.ok) {
    let reason = text.slice(0, 300)
    try { reason = String((JSON.parse(text) as { error?: string }).error ?? reason) } catch { /* plain text */ }
    throw new HelpdeskError(502, `No drafts: ${reason}`)
  }
  return JSON.parse(text) as SuggestResult
}
