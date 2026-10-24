// Runs the real Road Desk agent on the routine driver questions in
// lib/sim/routine.ts and keeps the results, so the queue's "Handled by the
// agent" section holds genuine work, with traces under traces/.
//
// Run from starter/ with the app's database up: npm run sim:seed-routine
// Needs OPENROUTER_API_KEY: in stub mode every case would go to a person,
// which would be a fake "handled" list. Rerunning replaces the earlier seed.

import "dotenv/config"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
const traceDir = path.join("traces", `routine-${stamp}`)
process.env.AGENT_TRACE_DIR = traceDir

async function main() {
  const { hasLlm, agentModel } = await import("@/lib/agent/client")
  if (!hasLlm()) throw new Error("Set OPENROUTER_API_KEY in starter/.env first. Without a model the agent hands every case to a person.")
  const { resetSimClock } = await import("@/lib/cr/clock")
  const { closeCrDb } = await import("@/lib/cr/db")
  const q = await import("@/lib/cr/queries")
  const triggers = await import("@/lib/agent/triggers")
  const { fleetCar } = await import("./fleet")
  const { ROUTINE_QUESTIONS, clearRoutine } = await import("./routine")

  await clearRoutine()
  resetSimClock()
  const log: string[] = [`# Routine driver questions, ${stamp}`, "", `Model: ${agentModel()}.`, ""]
  let handled = 0
  for (const question of ROUTINE_QUESTIONS) {
    const car = await fleetCar(question.reference)
    if (!car) { log.push(`## ${question.reference}: no car on the road, skipped`, ""); continue }
    log.push(`## ${question.reference} · ${car.vehicleTitle} · ${car.driverName}`, "", `Expected answer from: ${question.answerFrom}.`, "", `Driver: ${question.text}`)
    const prepared = await triggers.prepareDriverMessage({ orderRef: question.reference, driverId: car.driverId, text: question.text, mode: "chat" })
    const { caseId, result } = await triggers.handleDriverMessage(prepared)
    log.push(`Agent: ${result.reply ?? "(no reply)"}`)
    if (result.followUps.length) await triggers.runFollowUps(result.followUps)
    const row = await q.getCase(caseId)
    if (row?.status === "HANDLED_BY_AGENT" || row?.status === "RESOLVED") handled += 1
    log.push("", `Case ${caseId}: ${row?.status ?? "missing"}${row?.summary ? `. ${row.summary}` : ""}`, "")
    console.log(`${question.reference}: ${row?.status}`)
  }
  log.push(`${handled} of ${ROUTINE_QUESTIONS.length} closed by the agent alone. The rest are in the queue for a person, as they should be.`)
  mkdirSync(traceDir, { recursive: true })
  writeFileSync(path.join(traceDir, "timeline.md"), `${log.join("\n")}\n`)
  console.log(`${handled} of ${ROUTINE_QUESTIONS.length} handled by the agent. Saved to ${traceDir}/`)
  await closeCrDb()
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
