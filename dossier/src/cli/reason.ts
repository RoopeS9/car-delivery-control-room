// npm run reason -- CD-420584 [CD-...]: build the dossier (with stored calls), run the reasoning step, save and print.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { buildDossier, loadDataset } from "../build"
import { CallRecord } from "../live"
import { reason, renderDossier } from "../reason"

const root = new URL("../../", import.meta.url)
// .env without a dependency: KEY=value lines, no quotes handling needed here.
const envPath = new URL(".env", root)
if (existsSync(envPath)) for (const l of readFileSync(envPath, "utf8").split("\n")) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]! }

const ds = loadDataset(new URL("data/dataset/", root))
const callsDir = new URL("data/out/calls/", root)
const calls = existsSync(callsDir) ? readdirSync(callsDir).filter((f) => f.endsWith(".json")).map((f) => CallRecord.safeParse(JSON.parse(readFileSync(new URL(f, callsDir), "utf8")))).filter((r) => r.success).map((r) => r.data) : []
mkdirSync(new URL("data/out/reason/", root), { recursive: true })

const refs = process.argv.slice(2).filter((a) => a.startsWith("CD-"))
const dry = process.argv.includes("--render")
if (!refs.length) { console.error("usage: npm run reason -- CD-420584 [--render]"); process.exit(2) }
let total = 0
for (const ref of refs) {
  const order = ds.rows.orders.find((o) => o.reference === ref); if (!order) { console.error("no order", ref); continue }
  const d = buildDossier(ds, order.id, { calls: calls.filter((c) => c.orderId === order.id), telemetry: [], operatorActions: [] })
  const rendered = renderDossier(d)
  console.log(`\n=== ${ref} · ${d.phase.phase} · rendered ${rendered.length} chars (~${Math.round(rendered.length / 4)} tokens)`)
  if (dry) { console.log(rendered.slice(0, 3000)); continue }
  try {
    const run = await reason(d)
    writeFileSync(new URL(`data/out/reason/${ref}.json`, root), JSON.stringify(run, null, 1))
    total += run.costUsd ?? 0
    const o = run.output
    console.log(`model ${run.model} · in ${run.inputTokens} out ${run.outputTokens} · $${(run.costUsd ?? 0).toFixed(4)}`)
    console.log(`headline: ${o.headline}`)
    console.log(`needs person: ${o.needsPerson ? `${o.needsPerson.what} — ${o.needsPerson.why} [${o.needsPerson.options.join(" / ")}]` : "none"}`)
    for (const w of o.watching) console.log(`watching ${w.kind}/${w.severity}: ${w.line}  <- ${w.basis.join(", ")}`)
    for (const c of o.calls) console.log(`call ${c.purpose} (${c.urgency}) ${c.who}: ${c.reason}`)
    if (o.unknowns.length) console.log(`unknowns: ${o.unknowns.join(" | ")}`)
    if (o.note) console.log(`note: ${o.note.slice(0, 300)}`)
  } catch (e) { console.log("FAILED:", (e as Error).message.slice(0, 600)) }
}
console.log(`\ntotal cost $${total.toFixed(4)}`)
