// Hooks into stream A (PLAN.md 4.6): `call_urgent` as soon as urgency is
// EMERGENCY or URGENT, `call_ended` at hang-up. Every trigger is recorded on
// the call (`cr_calls.state.triggers`) whether or not the agent picked it up,
// so the analyst can catch up from the table.
//
// TODO(stream A): the agent has no call trigger route yet. When it ships,
// make it accept POST { trigger, callId, orderRef, urgency } at
// VOICE_AGENT_TRIGGER_PATH (default /api/agent/call) and read the call via
// GET /api/voice/calls/:id. Until then the POST returns 404 and is a no-op.

import { voiceConfig } from "./config"
import { simNow } from "./clock"
import type { TriggerRecord, Urgency } from "./types"

export async function fireTrigger(input: {
  trigger: TriggerRecord["trigger"]; callId: string; orderRef: string; urgency: Urgency | null; origin: string | null
}): Promise<TriggerRecord> {
  const at = simNow().toISOString()
  if (!input.origin) return { trigger: input.trigger, at, delivered: false, status: null, note: "No server origin (text harness); recorded only." }
  try {
    const response = await fetch(new URL(voiceConfig.agentTriggerPath(), input.origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trigger: input.trigger, callId: input.callId, orderRef: input.orderRef, urgency: input.urgency }),
      signal: AbortSignal.timeout(3000),
    })
    return {
      trigger: input.trigger, at, delivered: response.ok, status: response.status,
      note: response.ok ? "Agent accepted the trigger." : response.status === 404 ? "Agent call trigger not built yet (stream A); recorded only." : `Agent answered ${response.status}.`,
    }
  } catch (error) {
    return { trigger: input.trigger, at, delivered: false, status: null, note: `Agent unreachable: ${error instanceof Error ? error.message : String(error)}` }
  }
}
