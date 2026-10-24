// How the simulator tells the agent that something happened on the road (the
// proactive trigger in PLAN.md 4.2: a telemetry fault opens a case and the
// agent contacts the driver first). The agent owns the endpoint; if it fails,
// the `dtc` event is still stored and shows on the order.

import type { TelemetryTriggerRequest } from "@/lib/cr/types"

export const AGENT_TELEMETRY_PATH = "/api/agent/telemetry"

export async function notifyAgent(origin: string, trigger: TelemetryTriggerRequest): Promise<{ delivered: boolean; status: number | null }> {
  try {
    const response = await fetch(new URL(AGENT_TELEMETRY_PATH, origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(trigger),
    })
    if (!response.ok) console.warn(`[sim] ${AGENT_TELEMETRY_PATH} answered ${response.status} for ${trigger.orderRef}; the fault is stored but the agent did not pick it up.`)
    return { delivered: response.ok, status: response.status }
  } catch (error) {
    console.warn(`[sim] agent telemetry trigger failed: ${error instanceof Error ? error.message : String(error)}`)
    return { delivered: false, status: null }
  }
}
