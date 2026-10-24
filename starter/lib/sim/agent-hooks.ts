// How the simulator tells the agent that something happened on the road (the
// proactive trigger in PLAN.md 4.2: a telemetry fault opens a case and the
// agent contacts the driver first). The agent owns that endpoint; until it
// exists, the event is still stored and the call reports that nobody listened.

export const AGENT_TRIGGER_PATH = "/api/agent/trigger"

export type AgentTrigger = { kind: "telemetry_fault"; orderId: string; eventId: string }

export async function notifyAgent(origin: string, trigger: AgentTrigger): Promise<{ delivered: boolean; status: number | null }> {
  try {
    const response = await fetch(new URL(AGENT_TRIGGER_PATH, origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(trigger),
    })
    if (!response.ok) console.warn(`[sim] agent trigger ${AGENT_TRIGGER_PATH} answered ${response.status}; the ${trigger.kind} event is stored but no agent picked it up yet.`)
    return { delivered: response.ok, status: response.status }
  } catch (error) {
    console.warn(`[sim] agent trigger failed: ${error instanceof Error ? error.message : String(error)}`)
    return { delivered: false, status: null }
  }
}
