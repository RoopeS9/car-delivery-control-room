// npm run run-delivery -- CD-420442 [CD-...] [--twist confused|rushed|wrong_fact] [--live] [--plan]
// Walks each order through its delivery, placing the due robo-calls with model-played counterparts, and prints the
// report. --plan only prints the timeline. Needs OPENROUTER_API_KEY (from .env) unless --plan.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { buildDossier, loadDataset } from "../build"
import { loadEnv } from "./env"
import { CallRecord } from "../live"
import { newRunReport, planTimeline, runDelivery, summarizeRun } from "../run"
import { Twist } from "../sim/persona-from-dossier"
import { derive } from "../derived"

const root = new URL("../../", import.meta.url)
loadEnv(root)
const ds = loadDataset(new URL("data/dataset/", root))
const runsDir = new URL("data/out/runs/", root), callsDir = new URL("data/out/calls/", root)
mkdirSync(runsDir, { recursive: true }); mkdirSync(callsDir, { recursive: true })

const args = process.argv.slice(2)
const refs = args.filter((a) => a.startsWith("CD-"))
const twistArg = args[args.indexOf("--twist") + 1]
const twist: Twist = Twist.safeParse(twistArg).success ? (twistArg as Twist) : "cooperative"
const mode = args.includes("--live") ? "LIVE" as const : "TIMELINE" as const
if (!refs.length) { console.error("usage: npm run run-delivery -- CD-420442 [--twist confused] [--live] [--plan]"); process.exit(2) }

for (const ref of refs) {
  const order = ds.rows.orders.find((o) => o.reference === ref); if (!order) { console.error("no order", ref); continue }
  if (args.includes("--plan")) {
    console.log(`\n=== ${ref} timeline`)
    for (const i of planTimeline(ds, order.id)) {
      const d = buildDossier(ds, order.id, undefined, new Date(i.at).toISOString(), i.overlay)
      console.log(`  ${new Date(i.at).toISOString()}  ${i.label.padEnd(44)} ${d.phase.phase.padEnd(12)} ${derive({ ...d, live: { ...d.live, phone: i.phone ?? null } }).map((x) => x.kind === "DUE_CHECK" ? `${x.purpose}:${x.state}` : x.kind).join(", ") || "-"}`)
    }
    continue
  }
  const report = newRunReport(ref, mode, twist)
  console.log(`\n=== ${ref} · ${mode} · ${twist} · run ${report.id}`)
  await runDelivery(ds, order.id, report, {
    twist, mode,
    store: (call) => writeFileSync(new URL(`${call.id}.json`, callsDir), JSON.stringify(CallRecord.parse(call), null, 1)),
    onStep: (r) => { writeFileSync(new URL(`${r.id}.json`, runsDir), JSON.stringify(r, null, 1)); const s = r.steps[r.steps.length - 1]; if (s) console.log(`  step ${s.index} ${s.label}: ${s.phase}${s.reasoned ? ` · ${s.reasoned.headline}` : ""}${s.calls.length ? ` · ${s.calls.map((c) => `${c.purpose} ${c.outcome}`).join(", ")}` : ""}`) },
  })
  console.log("\n" + summarizeRun(report))
}
