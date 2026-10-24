// npm run soak -- [--sample N | CD-… CD-…] [--twists cooperative,confused,rushed,wrong_fact] [--budget USD] [--judge]
// Runs deliveries one after another and reads each report for garbage (src/soak.ts). Stops at the budget. Writes
// data/out/soak/<stamp>.md and .json as it goes, so a night that dies halfway still leaves its page. --judge reads
// the stored runs instead of running new ones.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { loadDataset } from "../build"
import { CallRecord } from "../live"
import { newRunReport, planTimeline, runDelivery, type RunReport } from "../run"
import { judgeRun, renderSoak, type RunVerdict } from "../soak"
import { Twist } from "../sim/persona-from-dossier"

const root = new URL("../../", import.meta.url)
const envPath = new URL(".env", root)
if (existsSync(envPath)) for (const l of readFileSync(envPath, "utf8").split("\n")) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]! }
const ds = loadDataset(new URL("data/dataset/", root))
const runsDir = new URL("data/out/runs/", root), callsDir = new URL("data/out/calls/", root), soakDir = new URL("data/out/soak/", root)
for (const d of [runsDir, callsDir, soakDir]) mkdirSync(d, { recursive: true })

const args = process.argv.slice(2)
const arg = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16)
const page = (name: string) => new URL(`${name}.md`, soakDir)

if (args.includes("--judge")) {
  const verdicts: RunVerdict[] = []
  for (const f of readdirSync(runsDir).filter((f) => f.endsWith(".json")).sort()) {
    try { verdicts.push(judgeRun(ds, JSON.parse(readFileSync(new URL(f, runsDir), "utf8")) as RunReport)) } catch (e) { console.error(f, (e as Error).message) }
  }
  const text = renderSoak(verdicts, "judged from stored runs")
  writeFileSync(page(`judge-${stamp}`), text); console.log(text)
  process.exit(0)
}

const twists = (arg("--twists") ?? "cooperative,confused,rushed,wrong_fact").split(",").map((t) => Twist.parse(t.trim()))
const budget = Number(arg("--budget") ?? "10")
let refs = args.filter((a) => a.startsWith("CD-"))
if (!refs.length) {
  // Orders with something to do: a walkable timeline of at least three instants, spread over the phases.
  const n = Number(arg("--sample") ?? "6")
  const candidates = ds.rows.orders.filter((o) => (o.status === "NEW" || o.status === "WAITING_FOR_PICKUP" || o.status === "IN_TRANSIT") && planTimeline(ds, o.id).length >= 3)
  const seed = Number(arg("--seed") ?? "7"); let x = seed
  const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648 }
  refs = [...candidates].sort(() => rnd() - 0.5).slice(0, n).map((o) => o.reference)
}
console.log(`soak ${stamp}: ${refs.length} orders × ${twists.length} twists, budget $${budget}`)

const verdicts: RunVerdict[] = []
let spent = 0
const flush = (note: string) => { const text = renderSoak(verdicts, note); writeFileSync(page(stamp), text); writeFileSync(new URL(`${stamp}.json`, soakDir), JSON.stringify(verdicts, null, 1)) }
outer: for (const twist of twists) {
  for (const ref of refs) {
    if (spent >= budget) { console.log(`budget reached ($${spent.toFixed(2)})`); break outer }
    const order = ds.rows.orders.find((o) => o.reference === ref); if (!order) continue
    const report = newRunReport(ref, "TIMELINE", twist)
    const started = Date.now()
    await runDelivery(ds, order.id, report, {
      twist, mode: "TIMELINE",
      store: (call) => writeFileSync(new URL(`${call.id}.json`, callsDir), JSON.stringify(CallRecord.parse(call), null, 1)),
      onStep: (r) => writeFileSync(new URL(`${r.id}.json`, runsDir), JSON.stringify(r, null, 1)),
    })
    spent += report.costUsd
    const v = judgeRun(ds, report)
    verdicts.push(v)
    console.log(`  ${ref} ${twist}: ${report.status}, ${v.calls} calls, ${v.findings.length} findings [${v.findings.map((f) => f.kind).join(", ")}], $${report.costUsd.toFixed(3)}, ${Math.round((Date.now() - started) / 1000)}s`)
    flush(`running; $${spent.toFixed(2)} of $${budget}`)
  }
}
flush(`finished; $${spent.toFixed(2)} of $${budget}`)
console.log(`\nwritten: ${page(stamp).pathname}`)
