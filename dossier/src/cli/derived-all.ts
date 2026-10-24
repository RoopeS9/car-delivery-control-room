// What the rules derive for every order, as of the snapshot (no network, no model): a quick read on the thresholds.
// npm run derived [-- CD-420584]
import { buildDossier, loadDataset } from "../build"
import { derive } from "../derived"

const ds = loadDataset(new URL("../../data/dataset/", import.meta.url))
const only = process.argv.slice(2).filter((a) => a.startsWith("CD-"))
const counts: Record<string, number> = {}
for (const o of ds.rows.orders) {
  if (only.length && !only.includes(o.reference)) continue
  const d = buildDossier(ds, o.id)
  const items = derive(d)
  for (const i of items) counts[i.kind === "DUE_CHECK" ? `${i.kind} ${i.purpose} ${i.state}` : i.kind] = (counts[i.kind === "DUE_CHECK" ? `${i.kind} ${i.purpose} ${i.state}` : i.kind] ?? 0) + 1
  if (only.length || items.length) console.log(`${o.reference} ${d.phase.phase.padEnd(12)} ${items.map((i) => i.kind === "DUE_CHECK" ? `${i.purpose}:${i.state}` : i.kind).join(", ") || "-"}`)
}
console.log("\n" + Object.entries(counts).sort().map(([k, v]) => `${v.toString().padStart(3)}  ${k}`).join("\n"))
