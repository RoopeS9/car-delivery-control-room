// Parse every row of every collection with its generated schema. Exit 1 on any failure.
import { readFileSync, readdirSync } from "node:fs"
import { RECORDS, type CollectionName } from "../records.generated"
const dir = new URL("../../data/dataset/", import.meta.url)
let rows = 0, bad = 0
for (const file of readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort()) {
  const name = file.slice(0, -6) as CollectionName
  const schema = RECORDS[name]
  if (!schema) { console.error("no schema for", name); bad++; continue }
  readFileSync(new URL(file, dir), "utf8").split("\n").filter(Boolean).forEach((line, i) => {
    rows++
    const r = schema.safeParse(JSON.parse(line))
    if (!r.success) { bad++; if (bad <= 10) console.error(name, "row", i, JSON.stringify(r.error.issues.slice(0, 2))) }
  })
}
console.log(`${rows} rows, ${bad} failures`)
process.exit(bad ? 1 : 0)
