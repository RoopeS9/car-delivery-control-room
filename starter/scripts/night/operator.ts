// The operator, as a policy: what a careful shift lead does with each card the agent brings, and what a clumsy one
// does. Every decision is logged with its reason, so the morning page can say why the operator did what they did.
import type { Proposal } from "./world"
import type { World } from "./world"

export type Style = "compliant" | "clumsy"

/** Decide every pending card on the case once. Returns what was decided. */
export async function decidePending(world: World, caseId: string, proposals: Proposal[], style: Style, context: { stopNow: boolean }): Promise<string[]> {
  const done: string[] = []
  for (const p of proposals.filter((row) => row.status === "PENDING")) {
    const call = p.draftMessage?.channel === "phone_call"
    if (p.actionType === "CLEAR_TO_CONTINUE") {
      if (context.stopNow) {
        await world.decide(caseId, p.id, { decision: "reject", note: "The codes say stop now. The driver stays put until the seller's tow or a workshop has looked at it." })
        done.push(`rejected clearance (${p.title})`)
      } else if (style === "clumsy") {
        // A clumsy lead rewrites the clearance into an instruction and approves it, which is the Leo case from tonight.
        await world.decide(caseId, p.id, { decision: "approve", edited_draft_message: p.draftMessage ? { ...p.draftMessage, body: "Wait for information from the seller before driving on. The engine is misfiring." } : null })
        done.push(`approved clearance card with a non-clearing edit (${p.title})`)
      } else {
        await world.decide(caseId, p.id, { decision: "approve" })
        done.push(`approved clearance (${p.title})`)
      }
    } else if (p.actionType === "CONTACT_CUSTOMER" || p.actionType === "CONTACT_SITE_AS_CUSTOMER") {
      if (call) {
        await world.decide(caseId, p.id, { decision: "handle", option_id: p.options.find((o) => o.recommended)?.id ?? null })
        done.push(`took the call (${p.title})`)
        await world.pause(3000)
        await world.outcome(caseId, p.id, "Called them: they will send their own tow within two hours and want the driver to stay with the car.")
        done.push("logged the call's outcome")
      } else {
        if (style === "clumsy") {
          const first = await world.decide(caseId, p.id, { decision: "approve" })
          const second = await world.decide(caseId, p.id, { decision: "approve" })
          done.push(`approved twice (${p.title}): ${first.status} then ${second.status}`)
        } else {
          await world.decide(caseId, p.id, { decision: "approve" })
          done.push(`sent (${p.title})`)
        }
      }
    } else if (p.actionType === "CHANGE_PROMISE") {
      await world.decide(caseId, p.id, { decision: "approve" })
      done.push(`approved promise change to propose (${p.title})`)
    } else if (p.actionType === "BOOK_RECOVERY" || p.actionType === "BOOK_TRAVEL") {
      await world.decide(caseId, p.id, { decision: "approve" })
      done.push(`approved booking (${p.title})`)
    } else if (p.actionType === "OPERATOR_DECISION") {
      const retry = p.options.find((o) => o.id === "retry")
      const takeOver = p.options.find((o) => o.id === "take_over")
      if (retry && takeOver) {
        const tried = world.rec.lines.filter((line) => line.includes("let the agent try again")).length
        if (tried === 0) { await world.decide(caseId, p.id, { decision: "approve", option_id: retry.id }); done.push("let the agent try again") }
        else { await world.decide(caseId, p.id, { decision: "approve", option_id: takeOver.id }); done.push("took the case over") }
      } else if (p.options.length) {
        const pick = p.options.find((o) => o.recommended) ?? p.options[0]!
        if (style === "clumsy") { await world.decide(caseId, p.id, { decision: "instruct", note: "do the thing" }); done.push(`instructed nonsense instead of choosing (${p.title})`) }
        else { await world.decide(caseId, p.id, { decision: "approve", option_id: pick.id }); done.push(`chose "${pick.label}" (${p.title})`) }
      } else {
        await world.decide(caseId, p.id, { decision: "handle" })
        done.push(`will handle it (${p.title})`)
        await world.pause(2000)
        await world.outcome(caseId, p.id, "Called the driver on their phone: safe, waiting at the service area, phone battery was flat.")
        done.push("logged the outcome")
      }
    } else {
      await world.decide(caseId, p.id, { decision: "approve" })
      done.push(`approved (${p.actionType}: ${p.title})`)
    }
  }
  return done
}
