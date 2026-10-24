// Run every simulated persona through the pipeline: dossier -> brief -> call -> validated CallRecord.
// Writes data/out/calls/<persona>.json and prints the transcript, the triage, the extracted slots and what was not extracted.
import { mkdirSync, writeFileSync } from "node:fs"
import { buildDossier, loadDataset } from "../build"
import { CHECKLISTS, type CallPurpose } from "../live"
import { briefFor } from "../brief"
import { PERSONAS } from "../sim/personas"
import { runSimulatedCall } from "../sim/call"

const root = new URL("../../", import.meta.url)
const ds = loadDataset(new URL("data/dataset/", root))
mkdirSync(new URL("data/out/calls/", root), { recursive: true })
const purposeFor = (p: (typeof PERSONAS)[number]): CallPurpose => (p.inbound ? "DRIVER_INBOUND" : p.role === "PICKUP_SITE_DESK" ? "PICKUP_READINESS" : "DRIVER_START_CHECK")

let failures = 0
for (const persona of PERSONAS) {
  const order = ds.rows.orders.find((o) => o.reference === persona.orderRef)!
  const d = buildDossier(ds, order.id)
  try {
    const brief = briefFor(d, purposeFor(persona))
    const call = runSimulatedCall(brief, persona, "2026-10-21T09:05:00Z")
    writeFileSync(new URL(`data/out/calls/${persona.id}.json`, root), JSON.stringify(call, null, 1))
    const dur = Math.round((Date.parse(call.endedAt!) - Date.parse(call.startedAt)) / 1000)
    console.log(`\n=== ${persona.id} · ${persona.orderRef} · ${call.brief.purpose} · ${call.direction} · ${call.outcome} · ${dur}s · brief ${JSON.stringify(brief).length} chars`)
    if (call.triage) console.log(`triage: ${call.triage.urgency} / ${call.triage.situation}  <- turn ${call.triage.turnSeq}`)
    for (const t of call.turns) console.log(`  ${String(t.seq).padStart(2)} ${t.speaker === "CALLER" ? "agent " : "callee"}: ${t.text}`)
    console.log("slots: " + (call.slots.map((s) => `${s.value.slot}=${JSON.stringify(s.value.value)} (t${s.turnSeq})`).join(", ") || "none"))
    const wanted = call.triage ? CHECKLISTS[call.triage.situation] : brief.ask
    const missing = wanted.filter((s) => !call.slots.some((x) => x.value.slot === s))
    if (missing.length) console.log("not extracted: " + missing.join(", ") + (call.retryAfter ? ` -> retry after ${call.retryAfter}` : ""))
    if (call.toolCalls.length) console.log("tool calls: " + call.toolCalls.map((c) => `${c.name}(${c.argument.slice(0, 90)}...)`).join(" | "))
  } catch (e) {
    failures++; console.log(`\n=== ${persona.id}: FAILED ${(e as Error).message}`)
  }
}
console.log(`\n${PERSONAS.length - failures}/${PERSONAS.length} simulated calls produced valid CallRecords`)
process.exit(failures ? 1 : 0)
