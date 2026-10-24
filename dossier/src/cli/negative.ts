// Strictness check: each mutation of a valid row must be rejected.
import { readFileSync } from "node:fs"
import { RECORDS } from "../records.generated"
const row = (c: string, i = 0) => JSON.parse(readFileSync(new URL(`../../data/dataset/${c}.jsonl`, import.meta.url), "utf8").split("\n")[i]!)
const cases: [string, keyof typeof RECORDS, (r: any) => void][] = [
  ["unknown top-level key", "orders", (r) => { r.priority = "high" }],
  ["misspelled status", "orders", (r) => { r.status = "IN_TRANSITT" }],
  ["time without offset", "messages", (r) => { r.authored_at = "2026-10-21 08:00" }],
  ["number as string", "expenses", (r) => { r.amount_minor = "1200" }],
  ["unknown nested key", "agent_proposals", (r) => { r.dependency.extra = 1 }],
  ["payload key from another command", "agent_proposals", (r) => { r.proposed_payload.buy_ticket = true }],
  ["event changes key not seen for this command", "operational_events", (r) => { r.changes = { ...(r.changes ?? {}), bogus_field: 1 } }],
  ["id with spaces", "alerts", (r) => { r.order_id = "ord 00322" }],
  ["missing required key", "time_windows", (r) => { delete r.purpose }],
]
let ok = 0
for (const [label, coll, mutate] of cases) {
  const r = row(coll); const before = RECORDS[coll].safeParse(r).success; mutate(r)
  const after = RECORDS[coll].safeParse(r).success
  console.log(`${!after && before ? "REJECTED" : "ACCEPTED (bad)"}  ${label}`); if (!after && before) ok++
}
console.log(`${ok}/${cases.length} mutations rejected`)
