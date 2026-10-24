// The "How the agent works" page: the rulebook it follows, how much it may do
// alone per kind of action, and what it did recently. Read only.

import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { desc, eq, inArray } from "drizzle-orm"
import { simNowIso } from "@/lib/cr/clock"
import { crDb } from "@/lib/cr/db"
import { listAutonomy, listRuns } from "@/lib/cr/queries"
import { crEvents } from "@/lib/cr/schema"
import { orders } from "@/lib/schema"
import { ACTION_LABELS, CHANNEL_LABELS, plainTokens } from "./cases"
import { oneLine } from "./text"
import { label } from "./labels"
import type { ActivityView, AgentPageView, AutonomyView, InlineRun, PlaybookBlock, PlaybookView } from "./types"

const RULEBOOK_DIR = process.env.RULEBOOK_DIR ?? join(process.cwd(), "rulebook")

const MEANINGS: Record<string, string> = {
  CONTACT_CUSTOMER: "Write to or call the customer, the dealer who pays us.",
  CONTACT_SITE_AS_CUSTOMER: "Contact a pickup or delivery site that belongs to the customer.",
  UPDATE_ETA: "Give a new estimated arrival time.",
  CHANGE_PROMISE: "Change the delivery date or window agreed with the customer.",
  BOOK_RECOVERY: "Book a tow or a workshop.",
  BOOK_TRAVEL: "Book a ferry, train, flight or hotel. A quote is not a booking.",
  APPROVE_EXPENSE: "Approve a driver's expense claim. Approved is not paid.",
  REASSIGN_DRIVER: "Give the job to another driver.",
  CLEAR_TO_CONTINUE: "Tell a driver they may keep driving after a warning.",
  OPERATOR_DECISION: "Ask a person to choose when there is no single action to propose.",
}

const LEVELS: Record<string, string> = { ASK_FIRST: "Asks first", DO_AND_TELL: "Does it, then tells", AUTO: "Does it alone" }

/** `request_photo` → "request photo", `STOP_NOW` → "stop now". */
function plainTerm(code: string): string {
  return /^[A-Z0-9_]+$/.test(code) ? label(code).toLowerCase() : code.replace(/_/g, " ")
}

function inline(text: string): InlineRun[] {
  const runs: InlineRun[] = []
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g
  let last = 0
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) runs.push({ text: text.slice(last, match.index) })
    const token = match[0]
    if (token.startsWith("**")) runs.push({ text: token.slice(2, -2), bold: true })
    else if (token.startsWith("`")) runs.push({ text: plainTerm(token.slice(1, -1)), term: true })
    else runs.push({ text: token.slice(1, -1), italic: true })
    last = match.index + token.length
  }
  if (last < text.length) runs.push({ text: text.slice(last) })
  return runs
}

/** Headings, paragraphs and lists: all the rulebook uses. */
export function parsePlaybook(slug: string, markdown: string): PlaybookView {
  const lines = markdown.replace(/\r/g, "").split("\n")
  const blocks: PlaybookBlock[] = []
  let title = slug
  let paragraph: string[] = []
  let list: { type: "ol" | "ul"; items: string[] } | null = null
  const flush = () => {
    if (paragraph.length) blocks.push({ type: "p", runs: inline(paragraph.join(" ")) })
    paragraph = []
    if (list) blocks.push({ type: list.type, items: list.items.map(inline) })
    list = null
  }
  for (const raw of lines) {
    const line = raw.trimEnd()
    const item = /^(\d+\.|[-*])\s+(.*)$/.exec(line)
    if (line.startsWith("# ")) { flush(); title = line.slice(2).trim() }
    else if (line.startsWith("## ")) { flush(); blocks.push({ type: "h2", text: line.slice(3).trim() }) }
    else if (item) {
      const type = item[1].endsWith(".") ? "ol" : "ul"
      if (paragraph.length || (list && list.type !== type)) flush()
      list ??= { type, items: [] }
      list.items.push(item[2])
    } else if (!line.trim()) {
      if (!list) flush()
    } else if (list && /^\s+/.test(raw)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`
    } else {
      if (list) flush()
      paragraph.push(line.trim())
    }
  }
  flush()
  const first = blocks[0]
  const intro = first?.type === "p" ? first.runs.map((run) => run.text).join("") : null
  return { slug, title, intro, blocks: intro ? blocks.slice(1) : blocks }
}

async function loadPlaybooks(): Promise<PlaybookView[]> {
  try {
    const files = (await readdir(RULEBOOK_DIR)).filter((file) => file.endsWith(".md")).sort()
    return Promise.all(files.map(async (file) => parsePlaybook(file.replace(/\.md$/, ""), await readFile(join(RULEBOOK_DIR, file), "utf8"))))
  } catch {
    return []
  }
}

async function loadActivity(): Promise<ActivityView[]> {
  const rows = await crDb().select().from(crEvents).where(eq(crEvents.actorType, "agent")).orderBy(desc(crEvents.at)).limit(40)
  const ids = [...new Set(rows.map((row) => row.orderId))]
  const refs = ids.length ? await crDb().select({ id: orders.id, reference: orders.reference }).from(orders).where(inArray(orders.id, ids)) : []
  const byId = new Map(refs.map((row) => [row.id, row.reference]))
  return rows.map((row) => ({
    id: row.id, at: row.at.toISOString(), orderId: row.orderId, reference: byId.get(row.orderId) ?? row.orderId,
    text: oneLine(plainTokens(row.body)), kind: row.channel === "safety" ? "safety" : row.kind,
    channelLabel: row.channel === "internal" || row.channel === "safety" ? null : CHANNEL_LABELS[row.channel] ?? label(row.channel),
  }))
}

export async function buildAgentPage(): Promise<AgentPageView> {
  const now = simNowIso()
  const playbooks = await loadPlaybooks()
  let autonomy: AutonomyView[] = []
  let activity: ActivityView[] = []
  let runs: AgentPageView["runs"] = { count: 0, toolCalls: 0, costUsd: null, lastAt: null }
  try {
    const [levels, events, recent] = await Promise.all([listAutonomy(), loadActivity(), listRuns({ limit: 500 })])
    // An escalation is a question for a person by nature; it has no level to grow into.
    autonomy = levels.filter((row) => row.actionType !== "OPERATOR_DECISION").map((row) => ({
      actionType: row.actionType, label: ACTION_LABELS[row.actionType] ?? label(row.actionType), meaning: MEANINGS[row.actionType] ?? "",
      level: row.level, levelLabel: LEVELS[row.level] ?? label(row.level), locked: row.locked,
      updatedBy: row.updatedBy, updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
    }))
    activity = events
    const costs = recent.map((run) => (run.usage as { cost?: unknown } | null)?.cost).filter((cost): cost is number => typeof cost === "number")
    runs = {
      count: recent.length, toolCalls: recent.reduce((sum, run) => sum + run.toolCalls.length, 0),
      costUsd: costs.length ? costs.reduce((sum, cost) => sum + cost, 0) : null,
      lastAt: recent[0]?.startedAt.toISOString() ?? null,
    }
  } catch (error) {
    console.warn("Agent tables could not be read.", error instanceof Error ? error.message : error)
  }
  return { simNow: now, playbooks, autonomy, activity, runs }
}
