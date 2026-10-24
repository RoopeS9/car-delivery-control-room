import "dotenv/config"
delete process.env.OPENROUTER_API_KEY

import assert from "node:assert/strict"
import { after, test } from "node:test"
import { inArray } from "drizzle-orm"
import { closeCrDb, crDb } from "@/lib/cr/db"
import { createCase, getCase, listEffects } from "@/lib/cr/queries"
import { crAgentRuns, crCases, crEffects, crEvents, crProposals } from "@/lib/cr/schema"
import { loadOrderFacts } from "./context"
import { submitProposal } from "./gate"
import { useTestLlm } from "./client"
import { decide, runFollowUps } from "./triggers"

const created: string[] = []
after(async () => {
  useTestLlm(null)
  if (created.length) {
    for (const table of [crAgentRuns, crEffects, crEvents, crProposals]) {
      await crDb().delete(table).where(inArray(table.caseId, created))
    }
    await crDb().delete(crCases).where(inArray(crCases.id, created))
  }
  await closeCrDb()
})

test("an uncertain booking never resumes approval follow-ups, including delayed delivery", async () => {
  const facts = (await loadOrderFacts("ord-00917"))!
  assert.ok(facts)
  const caseRow = await createCase({ orderId: facts.id, kind: "BREAKDOWN", status: "AGENT_WORKING", urgency: "HIGH", title: "Unknown booking follow-up check", channelOpened: "system" })
  created.push(caseRow.id)
  const { proposal } = await submitProposal({ audience: "operator", caseRow, facts }, {
    action_type: "BOOK_RECOVERY", title: "Book the fictional recovery", rationale: "Test an uncertain provider response.",
    handover: { what_happened: "Recovery requested", facts: [], agent_did: [], unknowns: [], recommendation: "Ask the provider", alternatives: [] },
    changes: [], draft_message: null, options: [], evidence_refs: [], assumptions: [], proposed_window: null,
    next_step_if_approved: "Check confirmation", next_step_if_rejected: "Nothing is booked",
  })
  const previous = process.env.MOCK_PROVIDER_TIMEOUT
  process.env.MOCK_PROVIDER_TIMEOUT = "1"
  try {
    const result = await decide(caseRow.id, proposal.id, { decision: "approve", decided_by: "ops-shift" })
    assert.equal(result.outcome.status, "UNKNOWN_OUTCOME")
    assert.deepEqual(result.followUps, [], "the public decision path waits for reconciliation")
  } finally {
    if (previous === undefined) delete process.env.MOCK_PROVIDER_TIMEOUT
    else process.env.MOCK_PROVIDER_TIMEOUT = previous
  }
  let modelCalls = 0
  useTestLlm({ messages: { stream() { modelCalls++; throw new Error("An uncertain booking must not resume") } } })
  await runFollowUps([{ kind: "decision", caseId: caseRow.id, proposalId: proposal.id, outcome: "approved" }])
  assert.equal(modelCalls, 0)
  assert.equal((await getCase(caseRow.id))?.status, "NEEDS_DECISION")
  assert.equal((await listEffects({ caseId: caseRow.id, kinds: ["BOOKING"] })).length, 1)
})
