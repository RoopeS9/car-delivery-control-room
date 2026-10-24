// npm run night -- [--only a,b] [--style compliant|clumsy] [--out night/<stamp>]
// Plays the scenarios against the sandbox stack (NIGHT_APP, NIGHT_DOSSIER, NIGHT_DB), one after another, and writes
// a page per scenario plus an index with every verdict, so the morning starts from the failures.
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { APP, DOSSIER, Rec } from "./lib"
import { SCENARIOS } from "./scenarios"
import { World } from "./world"
import type { Style } from "./operator"

const args = process.argv.slice(2)
const arg = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16)
const outDir = arg("--out") ?? path.join("night", stamp)
const style = (arg("--style") ?? "compliant") as Style
const only = arg("--only")?.split(",").map((s) => s.trim()).filter(Boolean)
mkdirSync(outDir, { recursive: true })

const chosen = only ? SCENARIOS.filter((s) => only.includes(s.name)) : SCENARIOS
console.log(`night ${stamp}: ${chosen.length} scenarios, operator ${style}, app ${APP}, dossier ${DOSSIER}, out ${outDir}`)

const summary: { name: string; title: string; pass: number; fail: number; review: number; costUsd: number; error: string | null }[] = []
const writeIndex = () => {
  const lines = [`# Night ${stamp} · operator ${style}`, "", `${summary.length} of ${chosen.length} scenarios done · $${summary.reduce((a, s) => a + s.costUsd, 0).toFixed(2)}`, "",
    "| Scenario | Pass | Fail | Review | $ | Error |", "|---|---|---|---|---|---|",
    ...summary.map((s) => `| [${s.name}](${s.name}.md) ${s.title} | ${s.pass} | ${s.fail} | ${s.review} | ${s.costUsd.toFixed(3)} | ${s.error ?? ""} |`)]
  writeFileSync(path.join(outDir, "index.md"), lines.join("\n"))
}

for (const scenario of chosen) {
  const rec = new Rec(scenario.name, outDir)
  const world = new World(rec)
  rec.log(`START ${scenario.title}`)
  let error: string | null = null
  try { await scenario.run(world, style) } catch (e) { error = (e as Error).message.slice(0, 300); rec.fail("The scenario ran to its end", error) }
  rec.write({ title: scenario.title, style })
  summary.push({ name: scenario.name, title: scenario.title, pass: rec.verdicts.filter((v) => v.result === "PASS").length, fail: rec.verdicts.filter((v) => v.result === "FAIL").length, review: rec.verdicts.filter((v) => v.result === "REVIEW").length, costUsd: rec.costUsd, error })
  writeIndex()
  console.log(`  done ${scenario.name}: ${summary.at(-1)!.pass} pass, ${summary.at(-1)!.fail} fail, ${summary.at(-1)!.review} review`)
}
console.log(`written: ${path.resolve(outDir, "index.md")}`)
