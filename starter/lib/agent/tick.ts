// Timers without workers (PLAN.md 4.2). Each poll of the control room calls
// tick(), which compares open cases with the simulated clock:
//
// - Follow-up due (WAITING_EXTERNAL past next_check_at). Waiting on the
//   driver: one reminder, then escalate with the known and missing facts.
//   Waiting on a customer, provider or dispatch: hand it to a person.
//   Waiting on an operator: nothing to do; the queue shows it as overdue.
// - Watchdog: AGENT_WORKING for more than 3 sim minutes with nothing running,
//   or a run that errored: "The agent couldn't finish", as a card.
//
// tick() returns at once; agent turns run in the background under the lock.

import { simNow } from "@/lib/cr/clock"
import { appendEvent, getCase, latestTelemetry, listCases, listEvents, listProposals, updateCase, type CaseRow } from "@/lib/cr/queries"
import { OPEN_CASE_STATUSES, type GpsData, type ObdData, type SourceRef, type TickResponse } from "@/lib/cr/types"
import { llm } from "./client"
import { AGENT_ID, deepEffort, fastEffort } from "./config"
import { loadOrderFacts } from "./context"
import { agentCouldNotFinish, driverSilentCard, replyDeadlineMinutes } from "./followup"
import { utcTime } from "./format"
import { isCaseLocked, runTurn, withCaseLock } from "./loop"
import { fleetCar } from "@/lib/sim/fleet"

const WATCHDOG_MINUTES = 3
const MINUTE = 60000
const OPERATIONS = { type: "operator" as const, id: null, name: "Operations" }
const holder = globalThis as unknown as { __roadDeskTicking?: boolean }

export async function tick(): Promise<TickResponse> {
  const now = simNow()
  const result: TickResponse = { now: now.toISOString(), followed_up: [], escalated: [] }
  if (holder.__roadDeskTicking) return result
  holder.__roadDeskTicking = true
  try {
    for (const row of await listCases({ statuses: [...OPEN_CASE_STATUSES] })) {
      if (isCaseLocked(row.id)) continue
      if (row.status === "AGENT_WORKING") {
        const stale = now.getTime() - row.updatedAt.getTime() > WATCHDOG_MINUTES * MINUTE
        if (stale || row.lastRunStatus === "ERROR") {
          await agentCouldNotFinish(row.id, row.lastRunStatus === "ERROR" ? "its last run failed" : `it was still marked as working after ${WATCHDOG_MINUTES} minutes with nothing running`)
          result.escalated.push(row.id)
        }
        continue
      }
      if (row.status === "WAITING_EXTERNAL" && row.nextCheckAt && row.nextCheckAt.getTime() <= now.getTime()) {
        const action = await followUp(row)
        if (action === "escalated") result.escalated.push(row.id)
        else if (action) result.followed_up.push(row.id)
      }
    }
  } finally {
    holder.__roadDeskTicking = false
  }
  return result
}

async function followUp(row: CaseRow): Promise<"reminded" | "escalated" | null> {
  const since = row.waitingSince ?? row.updatedAt
  if (row.waitingFor === "operator") return null
  if (row.waitingFor === "driver") {
    // Claim it first, so a second poll does not start the same follow-up.
    await updateCase(row.id, { nextCheckAt: new Date(simNow().getTime() + WATCHDOG_MINUTES * MINUTE) })
    if (row.followUps === 0) {
      void withCaseLock(row.id, () => remindDriver(row.id, since)).catch((error) => console.error("Road Desk reminder failed", error))
      return "reminded"
    }
    void withCaseLock(row.id, () => escalateSilentDriver(row.id, since)).catch((error) => console.error("Road Desk escalation failed", error))
    return "escalated"
  }
  const who = row.waitingOn ?? "the other party"
  if (row.followUps === 0) {
    // First lapse: note it and look again later. A seller or a provider answering an email in two hours is not an
    // emergency; the second lapse is.
    await appendEvent({
      caseId: row.id, orderId: row.orderId, actorType: "system", actorId: "road-desk", kind: "note", channel: "internal",
      body: `No answer from ${who} since ${utcTime(since)}. Still waiting; a person is told if there is none by the next check.`,
    })
    await updateCase(row.id, { followUps: 1, nextCheckAt: new Date(simNow().getTime() + 120 * MINUTE) })
    return "reminded"
  }
  await appendEvent({
    caseId: row.id, orderId: row.orderId, actorType: "system", actorId: "road-desk", kind: "note", channel: "internal",
    body: `No answer from ${who} since ${utcTime(since)}. The follow-up time passed; handing this to a person.`,
  })
  await updateCase(row.id, {
    status: "NEEDS_DECISION", owner: null, waitingFor: "operator", waitingOn: "an operator's decision",
    nextAction: `No answer from ${who} since ${utcTime(since)}. Chase them, or tell the agent what to do.`,
    nextCheckAt: new Date(simNow().getTime() + 15 * MINUTE),
  })
  return "escalated"
}

async function driverFacts(caseRow: CaseRow) {
  const facts = await loadOrderFacts(caseRow.orderId)
  const name = caseRow.driverId ? facts?.driverNames.get(caseRow.driverId) ?? null : null
  return { facts, name }
}

/** First lapse: one short reminder, then wait again with the same deadline. */
async function remindDriver(caseId: string, since: Date) {
  const row = await getCase(caseId)
  if (!row || row.status !== "WAITING_EXTERNAL" || row.waitingFor !== "driver") return
  const { name } = await driverFacts(row)
  const answered = (await listEvents({ caseId, since })).some((event) => event.actorType === "driver")
  if (answered) return
  if (llm()) {
    await runTurn({
      caseId, audience: "operator", trigger: "follow_up", effort: fastEffort(), counterpart: OPERATIONS, replyChannel: "internal",
      input: `No reply from ${name ?? "the driver"} since ${utcTime(since)}; the reply deadline passed. Send ONE short, calm reminder with message_driver (if their safety may be at risk, use safety_instruction with the fitting template instead). Do not escalate yet and do not propose anything. End with one line for the operators.`,
    })
  } else if (row.driverId) {
    await appendEvent({
      caseId, orderId: row.orderId, actorType: "agent", actorId: AGENT_ID, kind: "message", channel: "driver_chat",
      recipientType: "driver", recipientId: row.driverId, body: "Just checking in: are you safe? Please reply when you can.", data: { reminder: true },
    })
  }
  const after = await getCase(caseId)
  if (after && (after.status === "WAITING_EXTERNAL" || after.status === "AGENT_WORKING")) {
    await updateCase(caseId, {
      status: "WAITING_EXTERNAL", owner: "agent", waitingFor: "driver", waitingOn: "the driver's reply", waitingSince: since, followUps: 1,
      nextAction: "If there is still no answer, the case goes to a person.",
      nextCheckAt: new Date(simNow().getTime() + replyDeadlineMinutes(after) * MINUTE),
    })
  }
}

/**
 * Before the card, the agent tries the driver's phone. In the simulation a driver whose phone the demo has switched
 * off (scenario F) does not pick up, and the attempt is recorded as that; the card then asks a person to try.
 */
async function phoneSilentDriver(row: CaseRow, name: string | null, since: Date): Promise<void> {
  const car = await fleetCar(row.orderId).catch(() => null)
  const who = name ?? "the driver"
  await appendEvent({
    caseId: row.id, orderId: row.orderId, actorType: "agent", actorId: AGENT_ID, kind: "note", channel: "internal",
    body: `Calling ${who} (position check): no answer in the app since ${utcTime(since)}.`,
    data: { autopilot: true, call_purpose: "POSITION_CHECK" },
  })
  await appendEvent({
    caseId: row.id, orderId: row.orderId, actorType: "agent", actorId: AGENT_ID, kind: "voice_turn", channel: "driver_voice",
    body: `Called ${who} to check where the car is: no answer${car?.quietFrom ? ", the phone is off or out of coverage" : ""}.`,
    data: { autopilot: true, call_purpose: "POSITION_CHECK", call_outcome: "NO_ANSWER", simulated: true },
  })
}

/** Second lapse: escalate with what we know (with sources), what is missing, and one next action. */
async function escalateSilentDriver(caseId: string, since: Date) {
  const row = await getCase(caseId)
  if (!row || row.status !== "WAITING_EXTERNAL" || row.waitingFor !== "driver") return
  const { name } = await driverFacts(row)
  await phoneSilentDriver(row, name, since)
  if (llm()) {
    await runTurn({
      caseId, audience: "operator", trigger: "follow_up", effort: deepEffort(), counterpart: OPERATIONS, replyChannel: "internal",
      input: `${name ?? "The driver"} has not answered since ${utcTime(since)}, also not after one reminder, and did not pick up the agent's call (in the case notes). Escalate now with escalate: the known facts with their sources and times (car telemetry, the last driver-app report, the simulated phone position labelled as simulated), the missing facts (the driver's safety, the actual location, whether the car is still moving), and ONE next action for the operator, such as calling the driver on their phone. Do not message the driver again.`,
    })
  }
  if ((await listProposals({ caseId, statuses: ["PENDING"] })).length === 0) {
    const [obd, gps] = await Promise.all([latestTelemetry(row.orderId, "OBD"), latestTelemetry(row.orderId, "PHONE_GPS")])
    const facts: { text: string; sources: SourceRef[] }[] = []
    if (obd) {
      const data = obd.data as ObdData
      facts.push({ text: `Car: check-engine light ${data.mil.toLowerCase()}${data.dtcs?.length ? `, codes ${data.dtcs.join(", ")}` : ""}${typeof data.coolant_c === "number" ? `, coolant ${data.coolant_c} °C` : ""}.`, sources: [{ kind: "cr_telemetry", id: obd.id, label: `OBD dongle, ${utcTime(obd.at)}`, at: obd.at.toISOString() }] })
    }
    if (gps) {
      const data = gps.data as GpsData
      facts.push({ text: `Last phone position${data.place_label ? `: ${data.place_label}` : ""} (simulated GPS).`, sources: [{ kind: "cr_telemetry", id: gps.id, label: `Simulated phone GPS, ${utcTime(gps.at)}`, at: gps.at.toISOString() }] })
    }
    await driverSilentCard(caseId, name, since, facts)
  }
}
