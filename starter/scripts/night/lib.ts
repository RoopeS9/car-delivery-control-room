// The night harness's plumbing: the sandbox app and dossier service, the model that plays people, a log that
// becomes the morning page, and the few direct database writes a test needs (a customer writing in has no API).
import "dotenv/config"
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

export const APP = process.env.NIGHT_APP ?? "http://127.0.0.1:8798"
export const DOSSIER = process.env.NIGHT_DOSSIER ?? "http://127.0.0.1:8800"
export const DB = process.env.NIGHT_DB ?? "controlroom_sim"
export const PLAYER_MODEL = process.env.NIGHT_PLAYER_MODEL ?? "deepseek/deepseek-v4-flash"
export const OPERATOR_ID = "ops-shift"

export const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms))

export async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" })
  const text = await response.text()
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status}: ${text.slice(0, 300)}`)
  return JSON.parse(text) as T
}

export async function postJson<T>(url: string, body: unknown, method = "POST"): Promise<{ status: number; data: T }> {
  const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" })
  const text = await response.text()
  let data: unknown = null
  try { data = text ? JSON.parse(text) : null } catch { data = { raw: text.slice(0, 500) } }
  return { status: response.status, data: data as T }
}

/** A channel message: the reply streams as server-sent events; this reads them to the end and returns the whole reply. */
export async function postChannel(url: string, body: unknown): Promise<{ status: number; reply: string; done: Record<string, unknown> | null; error: string | null }> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  const text = await response.text()
  if (!response.ok) return { status: response.status, reply: "", done: null, error: text.slice(0, 400) }
  let reply = "", done: Record<string, unknown> | null = null, error: string | null = null
  for (const chunk of text.split("\n\n")) {
    const event = chunk.match(/^event: (\w+)/m)?.[1]
    const data = chunk.match(/^data: (.*)$/m)?.[1]
    if (!event || !data) continue
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>
      if (event === "text_delta") reply += String(parsed.text ?? "")
      else if (event === "done") done = parsed
      else if (event === "error") error = String(parsed.message ?? "error")
    } catch { /* a partial line */ }
  }
  return { status: response.status, reply, done, error }
}

/** One chat completion from the player model. */
export async function chat(system: string, messages: { role: "user" | "assistant"; content: string }[], opts: { model?: string; temperature?: number; json?: boolean } = {}): Promise<{ text: string; costUsd: number }> {
  const key = process.env.OPENROUTER_API_KEY
  if (!key) throw new Error("OPENROUTER_API_KEY is not set")
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-title": "road-desk night" },
    body: JSON.stringify({ model: opts.model ?? PLAYER_MODEL, temperature: opts.temperature ?? 0.6, usage: { include: true }, ...(opts.json ? { response_format: { type: "json_object" } } : {}), messages: [{ role: "system", content: system }, ...messages] }),
  })
  if (!response.ok) throw new Error(`openrouter ${response.status}: ${(await response.text()).slice(0, 300)}`)
  const body = (await response.json()) as { choices: { message: { content: string } }[]; usage?: { cost?: number } }
  return { text: (body.choices[0]?.message.content ?? "").trim(), costUsd: body.usage?.cost ?? 0 }
}

/** SQL against the sandbox database through the postgres container. Values are passed as a literal-quoted statement; only the harness writes here. */
export function sql(statement: string): string {
  return execFileSync("docker", ["exec", "-i", "bahn-pg", "psql", "-U", "controlroom", "-At", "-F", "|", DB, "-c", statement], { encoding: "utf8", timeout: 20000 }).trim()
}
export const q = (value: string) => `'${value.replace(/'/g, "''")}'`

export type Verdict = { check: string; result: "PASS" | "FAIL" | "REVIEW"; evidence: string }

/** A scenario's record as it runs: the log lines, the verdicts, the cost, written to disk at the end. */
export class Rec {
  lines: string[] = []
  verdicts: Verdict[] = []
  costUsd = 0
  startedAt = new Date().toISOString()
  constructor(public name: string, public outDir: string) { mkdirSync(outDir, { recursive: true }) }
  log(line: string) { const stamp = new Date().toISOString().slice(11, 19); this.lines.push(`${stamp} ${line}`); console.log(`  [${this.name}] ${line.slice(0, 220)}`) }
  verdict(check: string, result: Verdict["result"], evidence: string) { this.verdicts.push({ check, result, evidence: evidence.slice(0, 600) }); this.log(`${result} ${check}: ${evidence.slice(0, 160)}`) }
  pass(check: string, evidence: string) { this.verdict(check, "PASS", evidence) }
  fail(check: string, evidence: string) { this.verdict(check, "FAIL", evidence) }
  review(check: string, evidence: string) { this.verdict(check, "REVIEW", evidence) }
  write(extra: Record<string, unknown> = {}) {
    const fails = this.verdicts.filter((v) => v.result === "FAIL").length, reviews = this.verdicts.filter((v) => v.result === "REVIEW").length
    const md = [`# ${this.name}`, "", `Started ${this.startedAt} · cost $${this.costUsd.toFixed(3)} · ${this.verdicts.length} checks: ${fails} fail, ${reviews} review`, "", "## Verdicts", "",
      "| Check | Result | Evidence |", "|---|---|---|", ...this.verdicts.map((v) => `| ${v.check} | ${v.result} | ${v.evidence.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`),
      "", "## Log", "", "```", ...this.lines, "```"].join("\n")
    writeFileSync(path.join(this.outDir, `${this.name}.md`), md)
    writeFileSync(path.join(this.outDir, `${this.name}.json`), JSON.stringify({ name: this.name, startedAt: this.startedAt, costUsd: this.costUsd, verdicts: this.verdicts, lines: this.lines, ...extra }, null, 1))
  }
}

/** Wait until `probe` returns a value, polling; null after the timeout. */
export async function waitFor<T>(probe: () => Promise<T | null | undefined | false>, timeoutMs: number, everyMs = 4000): Promise<T | null> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const value = await probe()
    if (value) return value
    await sleep(everyMs)
  }
  return null
}
