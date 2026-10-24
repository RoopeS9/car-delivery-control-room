// What a scenario can do to the sandbox: raise a fault, have a party write in, decide as the operator, move the clock,
// read a case. Every call goes through the app's real endpoints except a customer writing in, which has none.
import { APP, DOSSIER, OPERATOR_ID, getJson, postChannel, postJson, q, sql, sleep, waitFor, type Rec } from "./lib"

export type CaseRow = { id: string; order_id: string; order_ref: string; kind: string; status: string; urgency: string; title: string; next_action: string | null; waiting_on: string | null; waiting_for?: string | null; pending_proposals?: number }
export type Proposal = { id: string; status: string; actionType: string; title: string; revision: number; options: { id: string; label: string; recommended?: boolean }[]; draftMessage: { to_type: string; to_id: string; to_name: string; channel: string; body: string; subject?: string | null; language?: string | null } | null; chosenOptionId: string | null; executionResult: Record<string, unknown> | null; nextStepIfApproved: string; nextStepIfRejected: string }
export type Event = { id: string; at: string; actorType: string; actorId: string | null; kind: string; channel: string; recipientType: string | null; body: string; data?: Record<string, unknown> }
export type CaseDetail = { now: string; case: CaseRow; proposals: Proposal[]; events: Event[] }
export type OrderView = { order: { id: string; reference: string }; view: { header: { id: string; reference: string; customer: { id: string; name: string }; from: { city: string; name: string }; to: { city: string; name: string }; vehicle: { title: string } | null; keyDates: { key: string; start: string; end: string | null; zone: string | null }[] }; journey: { groups: { steps: { role: string; place: { name: string; city: string }; site: { id: string; name: string } | null }[]; legs: { assignment: { driver: { id: string | null; name: string } } | null }[] }[] }; threads: { id: string; category: string; channel: string; status: string; counterparty: { id: string | null; name: string; kind: string } | null; messages: { id: string; author: { kind: string; name: string }; body: string; at: string; internal: boolean }[] }[] } }

export class World {
  constructor(public rec: Rec) {}

  order(id: string) { return getJson<OrderView>(`${APP}/api/orders/${id}`) }
  caseDetail(id: string) { return getJson<CaseDetail>(`${APP}/api/cases/${id}`) }
  async openCases(orderId?: string): Promise<CaseRow[]> {
    const data = await getJson<{ cases: CaseRow[] }>(`${APP}/api/cases`)
    return orderId ? data.cases.filter((row) => row.order_id === orderId) : data.cases
  }
  async caseFor(orderId: string): Promise<CaseDetail | null> {
    const rows = await this.openCases(orderId)
    return rows[0] ? this.caseDetail(rows[0].id) : null
  }

  async fault(orderRef: string, codes: string[], mil: "ON" | "FLASHING" | "OFF", note: string) {
    const r = await postJson<{ caseId: string; reply: string; error?: string }>(`${APP}/api/agent/telemetry`, { orderRef, codes, mil, note })
    this.rec.log(`car -> fault ${codes.join(",")} ${mil}: ${r.status} ${r.data.error ?? ""} agent->driver: "${(r.data.reply ?? "").slice(0, 200)}"`)
    if (r.status !== 200) throw new Error(`telemetry failed: ${JSON.stringify(r.data).slice(0, 300)}`)
    return r.data
  }

  async driverSays(orderRef: string, driverId: string, text: string) {
    this.rec.log(`driver -> "${text.slice(0, 200)}"`)
    const r = await postChannel(`${APP}/api/channels/driver/messages`, { orderRef, driverId, text, mode: "chat" })
    this.rec.log(`agent -> driver (${r.status}${r.error ? ` error ${r.error}` : ""}): "${r.reply.slice(0, 300)}"`)
    return r
  }

  async siteSays(orderRef: string, siteContactId: string, text: string) {
    this.rec.log(`site ${siteContactId} -> "${text.slice(0, 200)}"`)
    const r = await postChannel(`${APP}/api/channels/site/messages`, { orderRef, siteContactId, text, mode: "chat" })
    this.rec.log(`agent -> site (${r.status}, held=${String(r.done?.heldForApproval)}): "${r.reply.slice(0, 300)}"`)
    return r
  }

  /** A customer writes in on the helpdesk: a message row in a conversation (opened if needed), since no channel exists for it. */
  customerWrites(orderId: string, customerId: string, customerName: string, text: string, opts: { category?: string; channel?: string; language?: string; conversationId?: string } = {}) {
    const at = sql("select now()").split(".")[0]!.replace(" ", "T") + "Z"
    let conversationId = opts.conversationId ?? null
    if (!conversationId) {
      conversationId = `conv-night-${Math.random().toString(36).slice(2, 10)}`
      const details = { assignment_id: null, category: opts.category ?? "schedule_and_eta", channel: opts.channel ?? "email", counterparty_id: customerId, counterparty_type: "customer", counterparty_name_snapshot: customerName, id: conversationId, order_id: orderId, started_at: at, status: "OPEN", updated_at: at }
      sql(`insert into conversations (id, order_id, category, channel, status, updated_at, details) values (${q(conversationId)}, ${q(orderId)}, ${q(details.category)}, ${q(details.channel)}, 'OPEN', now(), ${q(JSON.stringify(details))}::jsonb)`)
    }
    const id = `msg-night-${Math.random().toString(36).slice(2, 10)}`
    const details = { author_id: customerId, author_type: "customer", authored_at: at, body: text, channel: opts.channel ?? "email", conversation_id: conversationId, id, language: opts.language ?? null, order_id: orderId, recipient_id: "ops-support", recipient_type: "operator", visibility: "PUBLIC" }
    sql(`insert into messages (id, order_id, conversation_id, author_type, body, authored_at, details) values (${q(id)}, ${q(orderId)}, ${q(conversationId)}, 'customer', ${q(text)}, now(), ${q(JSON.stringify(details))}::jsonb)`)
    sql(`update conversations set updated_at = now() where id = ${q(conversationId)}`)
    this.rec.log(`customer -> (${conversationId}) "${text.slice(0, 200)}"`)
    return { conversationId, messageId: id }
  }

  async suggest(conversationId: string, orderId: string) {
    const started = Date.now()
    const r = await postJson<{ language?: string; summary?: string; suggestions?: { stance: string; label: string; body: string; basis: string[]; caution: string | null }[]; error?: string }>(`${APP}/api/threads/${conversationId}/suggest`, { orderId })
    this.rec.log(`helpdesk suggest (${r.status}, ${Math.round((Date.now() - started) / 1000)}s): ${r.data.error ?? `${r.data.language} · ${r.data.suggestions?.length} suggestions · ${r.data.summary?.slice(0, 160)}`}`)
    return r
  }

  async operatorReplies(conversationId: string, body: string, language: string | null) {
    const r = await postJson<{ message?: unknown; error?: string }>(`${APP}/api/threads/${conversationId}/messages`, { body, language })
    this.rec.log(`operator -> thread ${conversationId} (${r.status}) "${body.slice(0, 160)}"`)
    return r
  }

  async decide(caseId: string, proposalId: string, body: Record<string, unknown>) {
    const r = await postJson<{ status?: string; case_status?: string; next_step?: string; error?: string; outdated?: unknown }>(`${APP}/api/cases/${caseId}/proposals/${proposalId}/decide`, { decided_by: OPERATOR_ID, ...body })
    this.rec.log(`operator decides ${String(body.decision)} on ${proposalId} -> ${r.status} ${r.data.status ?? ""} case ${r.data.case_status ?? ""} ${r.data.error ?? ""} ${r.data.outdated ? "OUTDATED " + JSON.stringify(r.data.outdated).slice(0, 200) : ""}`)
    return r
  }
  async outcome(caseId: string, proposalId: string, text: string) {
    const r = await postJson<{ case_status?: string; error?: string }>(`${APP}/api/cases/${caseId}/outcome`, { proposal_id: proposalId, text, logged_by: OPERATOR_ID })
    this.rec.log(`operator logs outcome on ${proposalId} -> ${r.status} ${r.data.case_status ?? ""} ${r.data.error ?? ""}`)
    return r
  }
  async instruct(caseId: string, text: string) {
    const r = await postJson<{ case_status?: string; error?: string }>(`${APP}/api/cases/${caseId}/instruct`, { text, by: OPERATOR_ID })
    this.rec.log(`operator instructs: "${text}" -> ${r.status} ${r.data.case_status ?? ""} ${r.data.error ?? ""}`)
    return r
  }
  async customerAnswer(caseId: string, answer: "agreed" | "declined", note: string) {
    const r = await postJson<{ case_status?: string; error?: string }>(`${APP}/api/cases/${caseId}/customer-answer`, { answer, note, logged_by: OPERATOR_ID })
    this.rec.log(`operator logs customer ${answer} -> ${r.status} ${r.data.case_status ?? ""} ${r.data.error ?? ""}`)
    return r
  }

  async advanceClock(minutes: number) {
    const r = await postJson<{ now?: string }>(`${APP}/api/sim/clock`, { minutes })
    await postJson(`${APP}/api/cases/tick`, {})
    this.rec.log(`clock +${minutes} min -> ${r.data.now ?? r.status}; tick`)
  }
  async tick() { const r = await postJson<{ followed_up?: string[]; escalated?: string[] }>(`${APP}/api/cases/tick`, {}); if ((r.data.followed_up?.length ?? 0) + (r.data.escalated?.length ?? 0) > 0) this.rec.log(`tick: followed up ${JSON.stringify(r.data.followed_up)}, escalated ${JSON.stringify(r.data.escalated)}`); return r.data }

  /** Wait until the case has no run in flight (status not AGENT_WORKING, or a pending card), up to a limit. */
  async settle(caseId: string, timeoutMs = 240_000): Promise<CaseDetail> {
    const detail = await waitFor(async () => { const d = await this.caseDetail(caseId); return d.case.status !== "AGENT_WORKING" || d.proposals.some((p) => p.status === "PENDING") ? d : null }, timeoutMs, 5000)
    if (!detail) { const d = await this.caseDetail(caseId); this.rec.log(`settle: still ${d.case.status} after ${timeoutMs / 1000}s`); return d }
    this.rec.log(`case ${detail.case.status} ${detail.case.urgency} waiting_for=${detail.case.waiting_for ?? "-"} pending=${detail.proposals.filter((p) => p.status === "PENDING").map((p) => `${p.actionType}:${p.title}`).join(" | ") || "none"} next="${(detail.case.next_action ?? "").slice(0, 140)}"`)
    return detail
  }

  /** A model-played call on the sandbox dossier service: {jobId} then the finished record. */
  async simulatedCall(ref: string, purpose: string, twist: string) {
    const start = await postJson<{ jobId?: string; error?: string }>(`${DOSSIER}/calls/sim`, { ref, purpose, twist })
    if (!start.data.jobId) { this.rec.log(`sim call ${purpose}/${twist} refused: ${start.data.error}`); return null }
    this.rec.log(`sim call ${purpose}/${twist} started ${start.data.jobId}`)
    const job = await waitFor(async () => { const j = await getJson<{ status: string; call?: { id: string; outcome: string; turns: { speaker: string; text: string }[]; slots: { value: { slot: string; value: unknown }; turnSeq: number; quote: string }[]; triage: unknown; toolCalls: unknown[] }; review?: { verdict: string; violations: { text: string }[] } | null; error?: string; note?: { costUsd?: number } }>(`${DOSSIER}/calls/jobs/${start.data.jobId}`); return j.status === "running" ? null : j }, 300_000, 6000)
    if (!job) { this.rec.log("sim call: no result in 5 min"); return null }
    if (job.status === "failed" || !job.call) { this.rec.log(`sim call failed: ${job.error}`); return null }
    this.rec.costUsd += job.note?.costUsd ?? 0
    for (const t of job.call.turns) this.rec.log(`  ${t.speaker}: ${t.text}`)
    this.rec.log(`sim call ${job.call.id}: ${job.call.outcome}, ${job.call.slots.length} claims, triage ${JSON.stringify(job.call.triage)}, review ${job.review?.verdict ?? "-"}${job.review?.violations.length ? " violations: " + job.review.violations.map((v) => v.text).join(" | ") : ""}`)
    return job
  }

  async pause(ms: number) { await sleep(ms) }
}
