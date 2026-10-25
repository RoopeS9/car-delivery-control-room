// Local HTTP service for the Road Desk UI: scenarios, simulated calls, dossiers and briefs. Loopback only.
//   GET  /health
//   GET  /scenarios                       -> personas with their order and purpose
//   GET  /purposes                        -> CallPurpose values with which need a persona
//   GET  /dossier/:ref[?live=1]           -> full Dossier (ref = CD-xxxxxx); live pulls the app's records and clock
//   GET  /derived/:ref[?live=1]           -> the derived layer: due checks, deadlines at risk, silent gaps, conflicts
//   GET  /brief/:ref/:purpose             -> CallBrief built from the dossier (400 if not buildable, with the reason)
//   POST /calls/run {personaId, at?}      -> runs the simulated call, stores it, returns the CallRecord
//   GET  /calls?ref=CD-xxxxxx             -> stored CallRecords (all, or for one order), newest first
//   GET  /calls/:id                       -> one CallRecord
//   GET  /calls/:id/audio/:seq            -> that turn's mp3 (simulated calls rendered with SIM_TTS=1)
//   POST /runs {ref, twist?, mode?}       -> starts a delivery run (TIMELINE walks the order through its phases; LIVE is one tick as the app sees it); 202 with the run id
//   POST /suggest/:ref {thread}        -> draft replies for the operator from the dossier and the thread (ref "-" when no order is linked)
//   GET  /runs?ref=CD-xxxxxx              -> stored runs, newest first;  GET /runs/:id -> one run (mutating while it runs);  GET /runs/plan/:ref -> the timeline a run would walk
import { createServer } from "node:http"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { buildDossier, liveOverlay, loadDataset } from "./build"
import { briefFor } from "./brief"
import { CallPurpose, CallRecord, emptyLive, type CallBrief } from "./live"
import { PERSONAS } from "./sim/personas"
import { runSimulatedCall } from "./sim/call"
import { composeBrief, reason, renderDossier, type ReasonRun } from "./reason"
import { ingestTranscript, runLlmCall } from "./llm-call"
import { reviewCall } from "./review"
import { cardText, contextPrompt } from "./context"
import { renderCallAudio, ttsEnabled } from "./tts"
import { pullLive } from "./livepull"
import { derive } from "./derived"
import { RunMode, newRunReport, planTimeline, runDelivery, type RunReport } from "./run"
import { Twist } from "./sim/persona-from-dossier"
import { SuggestThread, suggestReplies } from "./suggest"

const root = new URL("../", import.meta.url)
const callsDir = new URL("data/out/calls/", root)
const audioDir = new URL("data/out/audio/", root)
const runsDir = new URL("data/out/runs/", root)
mkdirSync(callsDir, { recursive: true }); mkdirSync(audioDir, { recursive: true }); mkdirSync(runsDir, { recursive: true })
const ds = loadDataset(new URL("data/dataset/", root))
const byRef = new Map(ds.rows.orders.map((o) => [o.reference, o.id]))
const purposeFor = (p: (typeof PERSONAS)[number]): CallPurpose => (p.inbound ? "DRIVER_INBOUND" : p.role === "PICKUP_SITE_DESK" ? "PICKUP_READINESS" : "DRIVER_START_CHECK")

const briefCache = new Map<string, { brief: CallBrief; by: "MODEL" | "RULE"; at: string }>()
const storedCalls = (id: string) => [...calls.values()].filter((c) => c.orderId === id)
/** The dossier with stored calls, and with the app's live records and clock when asked and the app answers. */
async function dossierFor(ref: string, id: string, live: boolean) {
  if (live) { const pulled = await pullLive(ds, id, ref, storedCalls(id)); if (pulled) return buildDossier(ds, id, pulled.live, pulled.asOf) }
  return buildDossier(ds, id, { ...emptyLive(), calls: storedCalls(id) })
}
const reasonCache = new Map<string, ReasonRun>()
const calls = new Map<string, CallRecord>()
type Job = { id: string; personaId: string; mode: string; startedAt: string; status: "running" | "done" | "failed"; call?: CallRecord; note?: Record<string, unknown>; review?: unknown; error?: string }
const jobs = new Map<string, Job>()
const runs = new Map<string, RunReport>()
for (const f of readdirSync(runsDir).filter((f) => f.endsWith(".json"))) {
  try { const r = JSON.parse(readFileSync(new URL(f, runsDir), "utf8")) as RunReport; if (r.status === "running") { r.status = "failed"; r.error = "the service restarted during the run" } runs.set(r.id, r) } catch { /* a half-written file */ }
}
const saveRun = (r: RunReport) => writeFileSync(new URL(`${r.id}.json`, runsDir), JSON.stringify(r, null, 1))
for (const f of readdirSync(callsDir).filter((f) => f.endsWith(".json"))) {
  const r = CallRecord.safeParse(JSON.parse(readFileSync(new URL(f, callsDir), "utf8")))
  if (r.success) calls.set(r.data.id, r.data)
}
const json = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body))
}
const body = (req: import("node:http").IncomingMessage) => new Promise<string>((ok) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => ok(s)) })

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1")
  const parts = url.pathname.split("/").filter(Boolean)
  try {
    if (parts[0] === "health") return json(res, 200, { ok: true, orders: ds.rows.orders.length, calls: calls.size })
    if (parts[0] === "scenarios") return json(res, 200, PERSONAS.map((p) => ({ id: p.id, orderRef: p.orderRef, role: p.role, mood: p.mood, purpose: purposeFor(p), inbound: !!p.inbound, title: p.greeting })))
    if (parts[0] === "purposes") return json(res, 200, CallPurpose.options)
    if (parts[0] === "dossier" && parts[1]) {
      // ?live=1 pulls what the app has recorded (clock, telemetry, timeline, cases) and builds as of the app's clock.
      const id = byRef.get(parts[1]); if (!id) return json(res, 404, { error: `no order ${parts[1]}` })
      return json(res, 200, await dossierFor(parts[1], id, url.searchParams.get("live") === "1"))
    }
    if (parts[0] === "derived" && parts[1]) {
      // What the rules say is due, at risk, silent or in conflict, as of the dossier's time (live with ?live=1).
      const id = byRef.get(parts[1]); if (!id) return json(res, 404, { error: `no order ${parts[1]}` })
      const d = await dossierFor(parts[1], id, url.searchParams.get("live") === "1")
      return json(res, 200, { reference: parts[1], asOf: d.asOf, phase: d.phase, live: d.live.pulledFrom != null, derived: derive(d) })
    }
    if (parts[0] === "actions" && parts[1]) {
      // What an operator can do about this order right now: the calls the agent may place (with their card URL) and the ones a person must make.
      const id = byRef.get(parts[1]); if (!id) return json(res, 404, { error: `no order ${parts[1]}` })
      // Live by default: a car the driver reported collected in the app needs no readiness call (?live=0 reads the snapshot only).
      const d = await dossierFor(parts[1], id, url.searchParams.get("live") !== "0")
      const order = ds.rows.orders.find((o) => o.id === id)!
      const status = liveOverlay(d.live).status ?? order.status
      const site = (sid: string | null) => ds.rows.sites.find((x) => x.id === sid) ?? null
      const addr = (aid: string) => ds.rows.addresses.find((x) => x.id === aid) ?? null
      const pickup = site(order.pickup_site_id), delivery = site(order.delivery_site_id)
      const pickupAddr = addr(order.pickup_address_id), deliveryAddr = addr(order.delivery_address_id)
      const assignment = ds.rows.work_assignments.find((a) => a.order_id === id && (a.status === "IN_PROGRESS" || a.status === "ASSIGNED"))
      const driver = assignment ? ds.rows.drivers.find((x) => x.id === assignment.driver_id) : null
      const card = (purpose: string) => `http://127.0.0.1:8799/card/${order.reference}/${purpose}`
      const tryBrief = (purpose: CallPurpose) => { try { briefFor(d, purpose); return null } catch (e) { return (e as Error).message } }
      const actions: unknown[] = []
      const pickupCustomer = pickup?.customer_id === order.customer_id
      if (status === "NEW" || status === "WAITING_FOR_PICKUP") {
        const why = pickupCustomer ? "pickup site belongs to the paying customer" : tryBrief("PICKUP_READINESS")
        actions.push({ kind: "CALL", label: `Call the pickup desk`, who: pickup?.name ?? pickupAddr?.name ?? "pickup desk", purpose: "PICKUP_READINESS", agentMay: !why, reason: why, cardUrl: why ? null : card("PICKUP_READINESS") })
      }
      if (driver) {
        const purpose: CallPurpose = status === "IN_TRANSIT" ? "POSITION_CHECK" : "DRIVER_START_CHECK"
        const why = tryBrief(purpose)
        actions.push({ kind: "CALL", label: `Call the driver`, who: driver.display_name, purpose, agentMay: !why, reason: why, cardUrl: why ? null : card(purpose) })
      }
      const receiverReason = !delivery ? "no managed site at the delivery address: a person confirms who receives"
        : delivery.customer_id === order.customer_id ? "the receiver is the paying customer: a person calls" : "no brief builder yet for receiver calls"
      actions.push({ kind: "CALL", label: `Call the receiver`, who: delivery?.name ?? deliveryAddr?.name ?? "receiver", purpose: "RECEIVER_CONFIRMATION", agentMay: false, reason: receiverReason, cardUrl: null })
      actions.push({ kind: "CALL", label: `Contact the customer`, who: ds.rows.customers.find((c) => c.id === order.customer_id)?.name ?? "customer", purpose: null, agentMay: false, reason: "customers are never contacted by the agent", cardUrl: null })
      return json(res, 200, { reference: order.reference, phase: d.phase, from: { city: pickupAddr?.city, name: pickup?.name ?? pickupAddr?.name }, to: { city: deliveryAddr?.city, name: delivery?.name ?? deliveryAddr?.name }, driver: driver?.display_name ?? null, actions })
    }
    if (parts[0] === "suggest" && parts[1] && req.method === "POST") {
      // Draft replies for the operator's helpdesk. The thread comes from the app (it holds the live messages); the dossier is
      // built live when an order is linked. "-" means no order: the drafts identify it or answer policy.
      const input = JSON.parse((await body(req)) || "{}") as { thread?: unknown; live?: boolean }
      const thread = SuggestThread.safeParse(input.thread); if (!thread.success) return json(res, 400, { error: thread.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") })
      let d = null
      if (parts[1] !== "-") { const id = byRef.get(parts[1]); if (!id) return json(res, 404, { error: `no order ${parts[1]}` }); d = await dossierFor(parts[1], id, input.live !== false) }
      try { return json(res, 200, await suggestReplies(d, thread.data)) } catch (e) { return json(res, 502, { error: (e as Error).message.slice(0, 600) }) }
    }
    if (parts[0] === "reason" && parts[1]) {
      const id = byRef.get(parts[1]); if (!id) return json(res, 404, { error: `no order ${parts[1]}` })
      let run = reasonCache.get(parts[1])
      if (!run || url.searchParams.get("fresh") === "1") {
        try { run = await reason(await dossierFor(parts[1], id, url.searchParams.get("live") === "1")) } catch (e) { return json(res, 502, { error: (e as Error).message.slice(0, 600) }) }
        reasonCache.set(parts[1], run)
      }
      return json(res, 200, run)
    }
    if (parts[0] === "brief" && parts[1] && parts[2] && url.searchParams.get("by") === "model") {
      const id = byRef.get(parts[1]); if (!id) return json(res, 404, { error: `no order ${parts[1]}` })
      const purpose = CallPurpose.safeParse(parts[2]); if (!purpose.success) return json(res, 400, { error: `unknown purpose ${parts[2]}` })
      try { const r = await composeBrief(buildDossier(ds, id), purpose.data); briefCache.set(`${parts[1]}/${purpose.data}`, { brief: r.brief, by: r.by, at: new Date().toISOString() }); return json(res, 200, { by: r.by, costUsd: r.costUsd, error: r.error ?? null, brief: r.brief }) } catch (e) { return json(res, 400, { error: (e as Error).message }) }
    }
    if (parts[0] === "context" && parts[1] && parts[2]) {
      // The turn-based line's system prompt: the brief (model-composed with ?by=model) and the whole dossier, with stored calls.
      const id = byRef.get(parts[1]); if (!id) return json(res, 404, { error: `no order ${parts[1]}` })
      const purpose = CallPurpose.safeParse(parts[2]); if (!purpose.success) return json(res, 400, { error: `unknown purpose ${parts[2]}` })
      const d = buildDossier(ds, id, { ...emptyLive(), calls: [...calls.values()].filter((c) => c.orderId === id) })
      let brief: CallBrief, by = "RULE"
      try {
        if (url.searchParams.get("by") === "model") { const key = `${parts[1]}/${purpose.data}`; let hit = briefCache.get(key); if (!hit) { const r = await composeBrief(d, purpose.data); hit = { brief: r.brief, by: r.by, at: new Date().toISOString() }; briefCache.set(key, hit) } brief = hit.brief; by = hit.by }
        else brief = briefFor(d, purpose.data)
      } catch (e) { return json(res, 400, { error: (e as Error).message }) }
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-brief-by": by }); return res.end(contextPrompt(d, brief))
    }
    if (parts[0] === "card" && parts[1] && parts[2]) {
      // The brief rendered as a voice model's system prompt: plain ASCII text, speech-ready, nothing the caller may not say.
      const id = byRef.get(parts[1]); if (!id) return json(res, 404, { error: `no order ${parts[1]}` })
      const purpose = CallPurpose.safeParse(parts[2]); if (!purpose.success) return json(res, 400, { error: `unknown purpose ${parts[2]}` })
      let brief: CallBrief, by = "RULE"
      try {
        if (url.searchParams.get("by") === "model") {
          const key = `${parts[1]}/${purpose.data}`
          let hit = briefCache.get(key)
          if (!hit || url.searchParams.get("fresh") === "1") { const r = await composeBrief(buildDossier(ds, id), purpose.data); hit = { brief: r.brief, by: r.by, at: new Date().toISOString() }; briefCache.set(key, hit) }
          brief = hit.brief; by = hit.by
        } else brief = briefFor(buildDossier(ds, id), purpose.data)
      } catch (e) { return json(res, 400, { error: (e as Error).message }) }
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-brief-by": by }); return res.end(cardText(brief))
    }
    if (parts[0] === "brief" && parts[1] && parts[2]) {
      const id = byRef.get(parts[1]); if (!id) return json(res, 404, { error: `no order ${parts[1]}` })
      const purpose = CallPurpose.safeParse(parts[2]); if (!purpose.success) return json(res, 400, { error: `unknown purpose ${parts[2]}` })
      try { return json(res, 200, briefFor(buildDossier(ds, id), purpose.data)) } catch (e) { return json(res, 400, { error: (e as Error).message }) }
    }
    if (parts[0] === "calls" && req.method === "POST" && parts[1] === "run") {
      const input = JSON.parse((await body(req)) || "{}") as { personaId?: string; at?: string; mode?: "llm" | "scripted" }
      const persona = PERSONAS.find((p) => p.id === input.personaId); if (!persona) return json(res, 400, { error: "unknown personaId" })
      const d = buildDossier(ds, byRef.get(persona.orderRef)!)
      const at = input.at ?? new Date().toISOString()
      const mode = input.mode ?? (process.env.OPENROUTER_API_KEY ? "llm" : "scripted")
      const store = (call: CallRecord) => { calls.set(call.id, call); writeFileSync(new URL(`${call.id}.json`, callsDir), JSON.stringify(call, null, 1)) }
      if (mode !== "llm") { const call = runSimulatedCall(briefFor(d, purposeFor(persona)), persona, at); store(call); return json(res, 201, { ...call, review: call.direction === "OUTBOUND" ? reviewCall(call) : null }) }
      // A model-driven run takes 30 to 90 s, longer than the proxies in front of the UI allow: run it as a job and let the UI poll.
      const job: Job = { id: `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, personaId: persona.id, mode, startedAt: new Date().toISOString(), status: "running" }
      jobs.set(job.id, job)
      void (async () => {
        try {
          const r = await runLlmCall(d, persona, purposeFor(persona), at); store(r.record)
          // Speech for every turn, after the record is stored: a failed render never loses the call.
          const spoken = await renderCallAudio(r.record, audioDir); if (spoken.rendered) store(spoken.call)
          job.call = spoken.call; job.note = { costUsd: r.costUsd + spoken.costUsd, briefBy: r.briefBy, audio: ttsEnabled() ? { rendered: spoken.rendered, costUsd: spoken.costUsd, failed: spoken.failed } : null }
          job.review = r.record.direction === "OUTBOUND" ? reviewCall(r.record) : null; job.status = "done"
        }
        catch (e) { job.status = "failed"; job.error = (e as Error).message.slice(0, 400) }
      })()
      if (url.searchParams.get("sync") === "1") { while (job.status === "running") await new Promise((ok) => setTimeout(ok, 500)); return job.status === "done" ? json(res, 201, { ...job.call, review: job.review }) : json(res, 502, { error: job.error }) }
      return json(res, 202, { jobId: job.id, status: job.status, poll: `/calls/jobs/${job.id}` })
    }
    if (parts[0] === "calls" && req.method === "POST" && parts[1] === "ingest") {
      // A live phone-line call: the UI posts the transcript after hang-up; we extract typed claims, review it, store it.
      const input = JSON.parse((await body(req)) || "{}") as { ref?: string; purpose?: string; engine?: string; startedAt?: string; endedAt?: string; lineCallId?: string; turns?: { speaker: string; text: string; startedAt?: string; endedAt?: string }[] }
      const id = input.ref ? byRef.get(input.ref) : null; if (!id) return json(res, 400, { error: "ref must be an order reference" })
      const purpose = CallPurpose.safeParse(input.purpose); if (!purpose.success) return json(res, 400, { error: "unknown purpose" })
      if (!Array.isArray(input.turns) || !input.turns.length) return json(res, 400, { error: "turns required" })
      const d = buildDossier(ds, id)
      try {
        const r = await ingestTranscript(d, purpose.data, input.turns, { startedAt: input.startedAt, endedAt: input.endedAt, engine: input.engine, lineCallId: input.lineCallId })
        calls.set(r.record.id, r.record); writeFileSync(new URL(`${r.record.id}.json`, callsDir), JSON.stringify(r.record, null, 1))
        return json(res, 201, { ...r.record, review: r.record.direction === "OUTBOUND" ? reviewCall(r.record) : null, costUsd: r.costUsd })
      } catch (e) { return json(res, 502, { error: (e as Error).message.slice(0, 400) }) }
    }
    if (parts[0] === "calls" && parts[1] === "jobs" && parts[2]) { const j = jobs.get(parts[2]); return j ? json(res, 200, { id: j.id, status: j.status, personaId: j.personaId, startedAt: j.startedAt, call: j.call ?? null, review: j.review ?? null, note: j.note ?? null, error: j.error ?? null }) : json(res, 404, { error: "no such job" }) }
    if (parts[0] === "runs" && req.method === "POST" && !parts[1]) {
      const input = JSON.parse((await body(req)) || "{}") as { ref?: string; twist?: string; mode?: string }
      const id = input.ref ? byRef.get(input.ref) : null; if (!id || !input.ref) return json(res, 400, { error: "ref must be an order reference" })
      const twist = Twist.safeParse(input.twist ?? "cooperative"); if (!twist.success) return json(res, 400, { error: `twist must be one of ${Twist.options.join(", ")}` })
      const mode = RunMode.safeParse(input.mode ?? "TIMELINE"); if (!mode.success) return json(res, 400, { error: "mode must be TIMELINE or LIVE" })
      if ([...runs.values()].some((r) => r.status === "running" && r.orderRef === input.ref)) return json(res, 409, { error: "a run is already in progress for this order" })
      if (!process.env.OPENROUTER_API_KEY) return json(res, 503, { error: "OPENROUTER_API_KEY is not set: a run needs the model" })
      const report = newRunReport(input.ref, mode.data, twist.data)
      runs.set(report.id, report); saveRun(report)
      const store = (call: CallRecord) => { calls.set(call.id, call); writeFileSync(new URL(`${call.id}.json`, callsDir), JSON.stringify(call, null, 1)) }
      void runDelivery(ds, id, report, { twist: twist.data, mode: mode.data, store, onStep: saveRun }).then(async (done) => {
        // speech for the run's calls, after the fact, so the run itself is not slowed by it
        for (const step of done.steps) for (const placed of step.calls) { const c = calls.get(placed.callId); if (c) { const spoken = await renderCallAudio(c, audioDir); if (spoken.rendered) store(spoken.call) } }
      }).catch((e) => { report.status = "failed"; report.error = (e as Error).message.slice(0, 500); saveRun(report) })
      return json(res, 202, { runId: report.id, status: report.status, poll: `/runs/${report.id}` })
    }
    if (parts[0] === "runs" && parts[1] === "plan" && parts[2]) {
      const id = byRef.get(parts[2]); if (!id) return json(res, 404, { error: `no order ${parts[2]}` })
      return json(res, 200, { reference: parts[2], steps: planTimeline(ds, id).map((i) => ({ label: i.label, at: new Date(i.at).toISOString(), overlay: i.overlay, phone: i.phone ?? null })) })
    }
    if (parts[0] === "runs" && parts[1]) { const r = runs.get(parts[1]); return r ? json(res, 200, r) : json(res, 404, { error: "no such run" }) }
    if (parts[0] === "runs") {
      const ref = url.searchParams.get("ref")
      return json(res, 200, [...runs.values()].filter((r) => !ref || r.orderRef === ref).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map((r) => ({ id: r.id, orderRef: r.orderRef, mode: r.mode, twist: r.twist, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt, steps: r.steps.length, planned: r.plannedSteps.length, summary: r.summary, costUsd: r.costUsd, failures: r.failures.length })))
    }
    if (parts[0] === "calls" && parts[1] && parts[2] === "audio" && parts[3]) {
      // A simulated call's turn, spoken (rendered with SIM_TTS=1).
      const c = calls.get(parts[1]); const turn = c?.turns.find((t) => String(t.seq) === parts[3])
      if (!c || !turn?.audioKey || !/^[a-z0-9-]+\/\d+\.mp3$/i.test(turn.audioKey)) return json(res, 404, { error: "no audio for that turn" })
      const file = new URL(turn.audioKey, audioDir)
      if (!existsSync(file)) return json(res, 404, { error: "audio file missing" })
      res.writeHead(200, { "content-type": "audio/mpeg", "cache-control": "public, max-age=86400" }); return res.end(readFileSync(file))
    }
    if (parts[0] === "calls" && parts[1] && parts[2] === "review") { const c = calls.get(parts[1]); return c ? json(res, 200, reviewCall(c)) : json(res, 404, { error: "no such call" }) }
    if (parts[0] === "calls" && parts[1]) { const c = calls.get(parts[1]); return c ? json(res, 200, c) : json(res, 404, { error: "no such call" }) }
    if (parts[0] === "calls") {
      const ref = url.searchParams.get("ref"); const id = ref ? byRef.get(ref) : null
      const list = [...calls.values()].filter((c) => !id || c.orderId === id).sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      return json(res, 200, list)
    }
    return json(res, 404, { error: "no such route" })
  } catch (e) { return json(res, 500, { error: (e as Error).message }) }
}).listen(Number(process.env.PORT ?? 8799), "127.0.0.1", () => console.log(`road-dossier service on 127.0.0.1:${process.env.PORT ?? 8799}, ${ds.rows.orders.length} orders, ${calls.size} stored calls`))
