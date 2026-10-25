// End to end through every role, against a running app with the real model (a few cents on DeepSeek, more on
// Claude). Plays the driver, the pickup desk, the customer and the operator through the same routes the screens
// use, and checks what each of them should see. Resets the demo first and between stories: run it on demo data.
//
//   APP_URL=http://127.0.0.1:3000 npx tsx scripts/e2e-roles.ts [A B C D F G H customer]
//   KEEP=1 … keeps the last story's records instead of resetting after it.
//   TRACE_DIR=<the app's AGENT_TRACE_DIR> … files each story's agent runs and a timeline under TRACE_DIR/<story>/.
//
// Prints one line per check and exits non-zero when one fails. Model wording varies; the checks look at what the
// records must show (a case, a card of the right kind, nothing sent to a customer without a person), not at words.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"

const APP = process.env.APP_URL ?? "http://127.0.0.1:3000"
const OPS = "ops-shift"

type Case = { id: string; order_ref: string; status: string; kind: string; title: string; pending_proposals: number }
type Proposal = { id: string; status: string; actionType: string; title: string; draftMessage: { to_type: string; body: string } | null; options: { id: string }[] }
type CaseEvent = { actorType: string; kind: string; channel: string; recipientType: string | null; body: string }

const results: { story: string; check: string; ok: boolean; detail: string }[] = []
let story = ""
const check = (name: string, ok: boolean, detail = "") => { results.push({ story, check: name, ok, detail }); console.log(`${ok ? "ok  " : "FAIL"} ${story} · ${name}${detail ? ` · ${detail}` : ""}`) }

async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(APP + path, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  const text = await response.text()
  if (!response.ok) throw new Error(`${path} ${response.status}: ${text.slice(0, 300)}`)
  // Channel routes stream server-sent events; the last "done" or "error" frame is the answer.
  if (text.startsWith("event:")) {
    let reply = ""
    for (const block of text.split("\n\n")) {
      const kind = /event: (\w+)/.exec(block)?.[1]
      const data = /data: ([\s\S]*)/.exec(block)?.[1]
      if (kind === "text_delta" && data) reply += (JSON.parse(data) as { text: string }).text
      if (kind === "error" && data) throw new Error(`${path}: ${data}`)
    }
    return { reply } as T
  }
  return JSON.parse(text) as T
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const cases = async () => (await call<{ cases: Case[]; handled_by_agent_today: number }>("/api/cases"))
const caseOf = async (ref: string) => (await cases()).cases.find((row) => row.order_ref === ref) ?? null
const detail = (id: string) => call<{ case: Case; proposals: Proposal[]; events: CaseEvent[] }>(`/api/cases/${id}`)
async function until<T>(what: () => Promise<T | null | undefined | false>, seconds = 180): Promise<T | null> {
  for (let waited = 0; waited < seconds; waited += 4) {
    const value = await what()
    if (value) return value
    await sleep(4000)
  }
  return null
}
const pending = async (ref: string, seconds = 180) => until(async () => {
  const row = await caseOf(ref)
  if (!row || row.pending_proposals === 0) return null
  return (await detail(row.id)).proposals.find((proposal) => proposal.status === "PENDING") ?? null
}, seconds)
const settled = async (ref: string) => until(async () => {
  const row = await caseOf(ref)
  return row && row.status !== "AGENT_WORKING" ? row : null
})
// Reset refuses while agent work is still running (a follow-up after the last decision): try again for a while.
async function reset() {
  for (let attempt = 0; ; attempt++) {
    try { return await call("/api/sim/scenarios/reset", { keepRoutine: true }) } catch (error) {
      if (attempt >= 30 || !String(error).includes("409")) throw error
      await sleep(5000)
    }
  }
}
const driverSays = (orderRef: string, driverId: string, text: string) => call<{ reply: string }>("/api/channels/driver/messages", { orderRef, driverId, text, mode: "chat" })
const noCustomerMessageSent = (events: CaseEvent[]) => !events.some((event) => event.recipientType === "customer" && event.actorType === "agent")

const stories: Record<string, () => Promise<void>> = {
  async A() {
    await call("/api/sim/driver", { enabled: false })
    await call("/api/sim/scenarios/warning-light-584", {})
    await call("/api/sim/clock", { minutes: 2 })
    const first = await settled("CD-420584")
    check("the agent reaches the driver first", Boolean(first && first.status === "WAITING_EXTERNAL"), first?.status ?? "no case")
    const reply = await driverSays("CD-420584", "drv-042", "I'm safe, parked at the service area by the fuel station, engine off. The orange light was blinking and the car shook.")
    check("the driver gets an answer, not the fixed fallback", !/has to confirm before you drive on/.test(reply.reply), reply.reply.slice(0, 80))
    const card = await pending("CD-420584")
    check("operations gets a card to ask the owner about recovery", card?.actionType === "CONTACT_CUSTOMER", card?.title ?? "no card")
    if (!card) return
    const row = (await caseOf("CD-420584"))!
    await call(`/api/cases/${row.id}/proposals/${card.id}/decide`, { decision: "handle", decided_by: OPS, option_id: card.options[0]?.id ?? null })
    await call(`/api/cases/${row.id}/outcome`, { text: "Called the owner: their own roadside help arrives at 11:00 UTC and takes the car to the Bentley workshop nearby.", logged_by: OPS })
    const after = await settled("CD-420584")
    const events = (await detail(row.id)).events
    check("after the logged outcome the agent tells the driver", events.some((event) => event.recipientType === "driver" && /roadside|11:00|13:00/i.test(event.body)), after?.status ?? "")
    check("nothing reached the customer without a person", noCustomerMessageSent(events))
  },
  async B() {
    // The owner's recovery costs today's delivery: a new date goes to the customer, who agrees by email.
    await call("/api/sim/scenarios/catch-up-322", {})
    const first = await settled("CD-420322")
    if (!first) { check("the driver's question settles", false); return }
    await call(`/api/cases/${first.id}/instruct`, { text: "The owner says their roadside partner collects the car from the service area at 12:00 today and takes it to their Hamburg workshop. Today's delivery is lost. Propose to the customer a new delivery window Friday 23 Oct 10:00-14:00 UTC.", by: OPS })
    const card = await pending("CD-420322")
    check("the new date comes as a promise-change card", card?.actionType === "CHANGE_PROMISE", card?.title ?? "no card")
    if (!card) return
    await call(`/api/cases/${first.id}/proposals/${card.id}/decide`, { decision: "approve", decided_by: OPS })
    const proposed = await call<{ view: { promise: { text: string; pending: { reply: unknown }[] } } }>("/api/orders/ord-00322")
    check("an approved proposal is not yet the promise", /21 Oct/.test(proposed.view.promise.text) && proposed.view.promise.pending.length === 1, proposed.view.promise.text)
    await call("/api/channels/customer/messages", { orderRef: "CD-420322", text: "Friday 23 October 12:00-16:00 works for us, we agree to the new delivery date." })
    // The approval's follow-up turn runs first, then the one for the email: allow both.
    const reply = await pending("CD-420322", 360)
    check("the customer's agreement gets a drafted reply", reply?.actionType === "CONTACT_CUSTOMER", reply?.title ?? "no card")
    const shown = await call<{ view: { promise: { pending: { reply: unknown }[] } } }>("/api/orders/ord-00322")
    check("the promise block shows the customer's email", Boolean(shown.view.promise.pending[0]?.reply))
    await call(`/api/cases/${first.id}/customer-answer`, { answer: "agreed", note: "Customer agreed by email.", logged_by: OPS })
    const agreed = await call<{ view: { promise: { text: string } } }>("/api/orders/ord-00322")
    check("the recorded agreement moves the promise", /23 Oct/.test(agreed.view.promise.text), agreed.view.promise.text)
    const after = await settled("CD-420322")
    check("an open reply card keeps the case with operations", after?.status === "NEEDS_DECISION" && after.pending_proposals === 1, `${after?.status} pending=${after?.pending_proposals}`)
  },
  async C() {
    await call("/api/sim/scenarios/driver-keys-145", {})
    const row = await until(async () => {
      const all = await call<{ cases: Case[] }>(`/api/cases?since=${encodeURIComponent(new Date(0).toISOString())}`)
      return all.cases.find((item) => item.order_ref === "CD-420145" && item.status !== "AGENT_WORKING") ?? null
    }, 300)
    await sleep(5000)
    const told = row ? (await detail(row.id)).events.filter((event) => event.recipientType === "driver").map((event) => event.body).join(" ") : ""
    check("the driver is told where the car and keys go", /reception|keys/i.test(told), told.slice(0, 80))
    // The site's instruction is unconfirmed in the records, so asking operations to confirm it is a fair call too.
    check("the agent closes it or brings one card", row?.status === "HANDLED_BY_AGENT" || (row?.status === "NEEDS_DECISION" && row.pending_proposals === 1), row?.status ?? "no case")
  },
  async D() {
    await call("/api/sim/scenarios/site-eta-442", {})
    await sleep(8000)
    const row = await until(async () => {
      const all = await call<{ cases: Case[] }>(`/api/cases?since=${encodeURIComponent(new Date(0).toISOString())}`)
      return all.cases.find((item) => item.order_ref === "CD-420442" && item.status !== "AGENT_WORKING") ?? null
    }, 120)
    await sleep(5000) // the case closes inside the turn; the reply is delivered as the turn ends
    const events = row ? (await detail(row.id)).events : []
    const answer = events.filter((event) => event.recipientType === "site").at(-1)?.body ?? ""
    check("the desk gets an answer about this order", /Kasper/.test(answer), answer.slice(0, 80))
    check("no promise to keep the desk posted", !/let you know|keep you (posted|updated)/i.test(answer))
    check("the answered question does not wait on the desk", row?.status !== "WAITING_EXTERNAL", row?.status ?? "")
  },
  async F() {
    await call("/api/sim/scenarios/driver-silent-537", {})
    await call("/api/sim/clock", { minutes: 2 })
    await settled("CD-420537")
    // Past the reply deadline, then past the reminder's: keep moving the clock while the agent's turns run.
    let card: Proposal | null = null
    for (let jump = 0; jump < 5 && !card; jump++) {
      await call("/api/sim/clock", { minutes: 6 })
      card = await pending("CD-420537", 60)
    }
    check("a silent driver ends with a card for a person", Boolean(card), card?.title ?? "no card")
    check("the card title fits the queue", (card?.title.length ?? 0) <= 110)
  },
  async G() {
    await call("/api/sim/scenarios/sensor-light-439", {})
    const row = await settled("CD-420439")
    const events = row ? (await detail(row.id)).events : []
    const toDriver = events.filter((event) => event.recipientType === "driver").map((event) => event.body).join(" ")
    check("the driver's question is answered", /oxygen|sensor|P0135/i.test(toDriver), toDriver.slice(0, 80))
    check("the driver is not cleared by the agent", !/(you can|you may|fine to) (keep|continue|drive)/i.test(toDriver))
  },
  async H() {
    await call("/api/sim/scenarios/pickup-to-handover-442", {})
    // One condition photo at the collection, as the driver's phone uploads it.
    const form = new FormData()
    form.set("file", new File([readFileSync(new URL("../public/sim/dashboard-misfire.jpg", import.meta.url))], "car.jpg", { type: "image/jpeg" }))
    form.set("orderRef", "CD-420442"); form.set("uploadedBy", "drv-165"); form.set("subject", "condition at pickup")
    const photo = await (await fetch(`${APP}/api/channels/photos`, { method: "POST", body: form })).json() as { photoId: string }
    for (const step of ["ARRIVED_PICKUP", "COLLECTED", "CHECKED_IN", "ARRIVED_DELIVERY"]) {
      await call("/api/channels/driver/milestone", { orderRef: "CD-420442", driverId: "drv-165", milestone: step, keys: 2, photoIds: step === "COLLECTED" ? [photo.photoId] : [] })
    }
    const order = await call<{ order: { status: string }; view: { proofs: { kind: string; status: string }[]; assignments: { steps: { kind: string; status: string }[] }[] } }>("/api/orders/ord-00442")
    check("a collection puts the order in transit", order.order.status === "IN_TRANSIT", order.order.status)
    check("the pickup photo becomes the pickup proof", order.view.proofs.some((proof) => proof.kind === "PICKUP_PHOTOS" && proof.status === "SUBMITTED"))
    check("the pickup step reads completed", order.view.assignments.some((row) => row.steps.some((step) => step.kind === "VEHICLE_PICKUP" && step.status === "COMPLETED")))
    const handed = await call<{ caseId: string | null }>("/api/channels/driver/milestone", { orderRef: "CD-420442", driverId: "drv-165", milestone: "DELIVERED", receiverName: "Mikko Rautio", keys: 2 })
    const card = handed.caseId ? (await detail(handed.caseId)).proposals.find((proposal) => proposal.status === "PENDING") : null
    check("a handover brings the customer's confirmation as a card", card?.actionType === "CONTACT_CUSTOMER" && /Mikko Rautio/.test(card.draftMessage?.body ?? ""))
    const delivered = await call<{ order: { status: string } }>("/api/orders/ord-00442")
    check("the order reads delivered", delivered.order.status === "DELIVERED", delivered.order.status)
  },
  async customer() {
    await call("/api/channels/customer/messages", { orderRef: "CD-420584", text: "Hello, can you tell us where our car is and whether it still arrives on Monday? We have a buyer coming at 14:00." })
    const card = await pending("CD-420584")
    check("a customer's email gets a drafted reply for a person", card?.actionType === "CONTACT_CUSTOMER", card?.title ?? "no card")
    check("the draft speaks of no simulated data", !/simulated/i.test(card?.draftMessage?.body ?? ""))
    const row = await caseOf("CD-420584")
    check("nothing reached the customer without a person", noCustomerMessageSent(row ? (await detail(row.id)).events : []))
  },
}

/**
 * TRACE_DIR (the same folder the app writes runs to, its AGENT_TRACE_DIR): after each story its agent runs move into
 * TRACE_DIR/<story>/ next to a readable timeline.md of the story's cases and checks.
 */
const TRACE_DIR = process.env.TRACE_DIR ?? null

async function saveTrace(name: string) {
  if (!TRACE_DIR || !existsSync(TRACE_DIR)) return
  // Let a follow-up still running finish, so its run is filed with this story and not the next.
  await until(async () => !(await cases()).cases.some((row) => row.status === "AGENT_WORKING"), 150)
  await sleep(15000) // a turn writes its card, then its closing note and its run file

  const dir = path.join(TRACE_DIR, name)
  mkdirSync(dir, { recursive: true })
  for (const file of readdirSync(TRACE_DIR).filter((entry) => entry.endsWith(".json"))) renameSync(path.join(TRACE_DIR, file), path.join(dir, file))
  const all = await call<{ cases: Case[] }>(`/api/cases?since=${encodeURIComponent(new Date(0).toISOString())}`)
  const lines = [`# Story ${name}`, "", ...results.filter((row) => row.story === name).map((row) => `- ${row.ok ? "ok" : "FAIL"}: ${row.check}${row.detail ? ` (${row.detail.replace(/\s+/g, " ").slice(0, 160)})` : ""}`), ""]
  for (const row of all.cases.filter((item) => item.order_ref === CASE_REFS[name])) {
    const { case: kase, proposals, events } = await detail(row.id)
    lines.push(`## ${kase.order_ref} · ${kase.title} [${kase.status}]`, "")
    for (const event of events) lines.push(`- ${event.actorType}/${event.kind}${event.recipientType ? ` → ${event.recipientType}` : ""}: ${event.body.replace(/\s+/g, " ").slice(0, 400)}`)
    for (const card of proposals) lines.push(`- card [${card.status}] ${card.actionType}: ${card.title}`)
    lines.push("")
  }
  writeFileSync(path.join(dir, "timeline.md"), lines.join("\n"))
}

const CASE_REFS: Record<string, string> = { A: "CD-420584", B: "CD-420322", C: "CD-420145", D: "CD-420442", F: "CD-420537", G: "CD-420439", H: "CD-420442", customer: "CD-420584" }

/** Each story's order: its page and the queue must still render once the story has run. */
const ORDERS: Record<string, string> = { A: "ord-00584", B: "ord-00322", C: "ord-00145", D: "ord-00442", F: "ord-00537", G: "ord-00439", H: "ord-00442", customer: "ord-00584" }

async function pagesRender(name: string) {
  for (const path of [`/api/orders/${ORDERS[name]}`, "/queue", `/orders/${ORDERS[name]}`]) {
    const response = await fetch(APP + path, { cache: "no-store" })
    await response.text()
    check(`${path} renders`, response.ok, String(response.status))
  }
}

async function main() {
  const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(stories)
  for (const name of wanted) {
    if (!stories[name]) { console.log(`no story ${name}`); continue }
    story = name
    await reset()
    try { await stories[name]() } catch (error) { check("ran without an error", false, error instanceof Error ? error.message : String(error)) }
    if (ORDERS[name]) await pagesRender(name)
    await saveTrace(name).catch((error) => console.log(`trace for ${name} not saved: ${error}`))
  }
  // KEEP=1 leaves the last story's records in place to read after a failure.
  if (!process.env.KEEP) await reset()
  const failed = results.filter((result) => !result.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length ? 1 : 0)
}

main()
