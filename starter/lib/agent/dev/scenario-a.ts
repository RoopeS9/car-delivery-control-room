// Scenario A end to end with the real model (PLAN.md 3 and M1): the car
// reports a misfire, the agent contacts the driver first, a rule-based driver
// answers, the agent hands over, an operator says "I'll handle it" and logs
// the dealer's answer, and the agent continues. Saves every run and a
// readable timeline under traces/.
//
// Run from starter/: npm run agent:scenario-a   (needs OPENROUTER_API_KEY)

import "dotenv/config"
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import path from "node:path"

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
const traceDir = path.join("traces", `scenario-a-${stamp}`)
process.env.AGENT_TRACE_DIR = traceDir

const ORDER = "CD-420584"
const DRIVER = "drv-042"

async function main() {
  const { hasLlm, agentModel } = await import("../client")
  if (!hasLlm()) throw new Error("Set OPENROUTER_API_KEY in starter/.env first.")
  const { resetSimClock, simNow } = await import("@/lib/cr/clock")
  const { closeCrDb } = await import("@/lib/cr/db")
  const q = await import("@/lib/cr/queries")
  const triggers = await import("../triggers")
  const { orderTimeline, renderLines } = await import("../timeline")
  const { effectiveOrder } = await import("@/lib/cr/effective")

  await q.resetCrData()
  resetSimClock("2026-10-21T09:02:00Z")
  const order = (await q.resolveOrder(ORDER))!
  const minutesAgo = (minutes: number) => new Date(simNow().getTime() - minutes * 60000)

  // Simulated phone GPS along the A1 north of Münster, then stopped at a (fictional) service area.
  await q.insertTelemetry([
    { orderId: order.id, source: "PHONE_GPS", at: minutesAgo(9), data: { lat: 51.86, lng: 7.62, speed_kmh: 128, heading: 20, place_label: "A1 northbound" } },
    { orderId: order.id, source: "PHONE_GPS", at: minutesAgo(4), data: { lat: 51.93, lng: 7.66, speed_kmh: 74, heading: 20, place_label: "A1 northbound" } },
    { orderId: order.id, source: "PHONE_GPS", at: minutesAgo(1), data: { lat: 51.951, lng: 7.672, speed_kmh: 0, heading: 20, place_label: "Rastanlage Lindenhöhe (fictional), A1 northbound" } },
  ])
  // OBD: normal, then a misfire with a freeze frame, then parked.
  await q.insertTelemetry([
    { orderId: order.id, source: "OBD", at: minutesAgo(8), data: { speed_kmh: 126, rpm: 2400, engine_load_pct: 38, throttle_pct: 22, coolant_c: 91, battery_v: 14.2, misfire_count: 0, mil: "OFF", dtcs: [] } },
    { orderId: order.id, source: "OBD", at: minutesAgo(5), data: { speed_kmh: 98, rpm: 2900, engine_load_pct: 61, throttle_pct: 55, coolant_c: 93, battery_v: 14.1, misfire_count: 41, mil: "FLASHING", dtcs: ["P0300", "P0302"], freeze_frame: { code: "P0300", at: minutesAgo(5).toISOString(), values: { rpm: 2850, engine_load_pct: 63, speed_kmh: 101, coolant_c: 93, fuel_trim_short_pct: 9.4 } } } },
    { orderId: order.id, source: "OBD", at: minutesAgo(1), data: { speed_kmh: 0, rpm: 0, battery_v: 12.4, misfire_count: 57, mil: "FLASHING", dtcs: ["P0300", "P0302"] } },
  ])

  const log: string[] = [`# Scenario A trace, ${stamp}`, "", `Model: ${agentModel()}. Order ${ORDER}, driver ${DRIVER}. Simulated clock starts 09:02 UTC.`, ""]
  const say = (line: string) => { console.log(line); log.push(line) }

  say("## 1. The car reports a fault; the agent contacts the driver first")
  const first = await triggers.handleTelemetryFault({ orderRef: ORDER, codes: ["P0300", "P0302"], mil: "FLASHING", note: "reduced power message" })
  const caseId = first.caseId
  say(`Agent → driver: ${first.result.reply}`)
  await triggers.runFollowUps(first.result.followUps)

  // A rule-based driver: answers what the agent asked, once each.
  const answered = new Set<string>()
  const photo = readFileSync(path.join("lib", "agent", "dev", "fixtures", "dashboard-engine-warning.png"))
  async function driverAnswer(agentText: string): Promise<{ text: string; photoIds: string[] }> {
    const parts: string[] = []
    const photoIds: string[] = []
    const ask = (key: string, pattern: RegExp, answer: string) => {
      if (!answered.has(key) && pattern.test(agentText)) { parts.push(answer); answered.add(key) }
    }
    ask("safe", /safe|okay|are you ok/i, "Yes, I'm safe. I slowed down and pulled off the motorway.")
    ask("where", /where|location|service area|pin/i, "I'm at the Lindenhöhe service area on the A1 northbound, parked away from the traffic, engine off.")
    ask("feel", /shak|feel|power|smell|smoke|noise|sound|drive/i, "It started shaking when I accelerated and lost power. No smoke and no burning smell.")
    if (!answered.has("photo") && /photo|picture|image/i.test(agentText)) {
      photoIds.push(await triggers.storePhoto({ orderRef: ORDER, mediaType: "image/png", bytes: photo, subject: "dashboard", caption: "Dashboard after stopping. The engine light was flashing.", uploadedBy: DRIVER }))
      parts.push("Here is the dashboard. The engine light was flashing while I was driving.")
      answered.add("photo")
    }
    // Once, the question the drivability screen exists for.
    if (!answered.has("drive_on")) { parts.push("Can I drive on slowly to the next town? It's only 15 km."); answered.add("drive_on") }
    if (parts.length === 0) parts.push("OK. I'll wait here with the car.")
    return { text: parts.join(" "), photoIds }
  }

  say("")
  say("## 2. Driver and agent")
  let lastAgent = first.result.reply
  for (let turn = 0; turn < 6; turn++) {
    const pending = await q.listProposals({ caseId, statuses: ["PENDING"] })
    if (pending.length) break
    const answer = await driverAnswer(lastAgent)
    say(`Driver: ${answer.text}${answer.photoIds.length ? " [photo]" : ""}`)
    const prepared = await triggers.prepareDriverMessage({ orderRef: ORDER, driverId: DRIVER, text: answer.text, mode: "chat", photoIds: answer.photoIds })
    const { result } = await triggers.handleDriverMessage(prepared)
    say(`Agent → driver: ${result.reply}`)
    lastAgent = result.reply
    if (result.followUps.length) {
      say("(the agent hands over; preparing the decision card)")
      await triggers.runFollowUps(result.followUps)
    }
  }

  const cards = await q.listProposals({ caseId, statuses: ["PENDING"] })
  say("")
  say("## 3. The decision card")
  for (const card of cards) {
    say(`**${card.title}** (${card.actionType})`)
    say(card.rationale)
    if (card.handover) {
      say(`What happened: ${card.handover.what_happened}`)
      for (const fact of card.handover.facts) say(`- ${fact.text} [${fact.sources.map((source) => source.label).join("; ")}]`)
      say(`Unknown: ${card.handover.unknowns.join("; ") || "nothing listed"}`)
    }
    for (const option of card.options) say(`Option: ${option.label}${option.recommended ? " (recommended)" : ""}`)
    if (card.draftMessage) say(`Draft to ${card.draftMessage.to_name} (${card.draftMessage.channel}): ${card.draftMessage.body}`)
  }

  const contact = cards.find((card) => card.actionType === "CONTACT_CUSTOMER") ?? cards.find((card) => card.actionType !== "OPERATOR_DECISION") ?? cards[0]
  if (contact) {
    say("")
    say("## 4. Operator: \"I'll handle it\", calls the dealer, logs the answer")
    // The dealer chooses their own roadside help, so the operator picks that option if the card offers it.
    const option = contact.options.find((entry) => /own|roadside|assistance/i.test(entry.label)) ?? contact.options.find((entry) => entry.recommended) ?? contact.options[0]
    const handled = await triggers.decide(caseId, contact.id, { decision: "handle", decided_by: "ops-shift", option_id: option?.id ?? null })
    say(`Decision: handle → ${handled.outcome.next_step}`)
    const logged = await triggers.outcome(caseId, { text: "Called the dealer: they send their own roadside help, ETA 12:15 CEST at the service area.", logged_by: "ops-shift", proposal_id: contact.id })
    await triggers.runFollowUps(logged.followUps)
    const after = await q.getCase(caseId)
    say(`Case now: ${after?.status} · waiting on: ${after?.waitingOn ?? "-"} (${after?.waitingFor ?? "-"}) · next: ${after?.nextAction ?? "-"} · next check: ${after?.nextCheckAt?.toISOString().slice(11, 16) ?? "-"} UTC`)
    for (const card of await q.listProposals({ caseId, statuses: ["PENDING"] })) say(`New card: ${card.title} (${card.actionType})`)
  } else {
    say("No decision card was produced.")
  }

  const effective = await effectiveOrder(order.id)
  say("")
  say("## Effective promise")
  const promise = effective.promise
  say(promise
    ? `Delivery window: ${promise.start_utc ?? "-"} to ${promise.end_utc ?? "-"} (${promise.basis}). Pending with the customer: ${promise.pending.length}.`
    : "No delivery window recorded.")
  for (const effect of effective.effects) say(`- ${effect.kind} ${effect.state}, authorised by ${effect.authority.by} (${effect.authority.basis})`)

  say("")
  say("## Order timeline (what the operator sees)")
  say(renderLines(await orderTimeline(order.id, { includeDataset: false, limit: 200 })))
  const runs = await q.listRuns({ caseId, limit: 50 })
  const cost = runs.reduce((sum, run) => sum + Number((run.usage as { cost_usd?: number } | null)?.cost_usd ?? 0), 0)
  say("")
  say(`Runs: ${runs.length}, cost $${cost.toFixed(4)}.`)

  mkdirSync(traceDir, { recursive: true })
  writeFileSync(path.join(traceDir, "timeline.md"), `${log.join("\n")}\n`)
  console.log(`\nSaved to ${traceDir}/`)
  await closeCrDb()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
