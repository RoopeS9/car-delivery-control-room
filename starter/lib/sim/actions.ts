// Runs the follow-up work a scenario asks for: tell the agent about a fault,
// or send a driver or site message through the channel routes.

import { beginRuntimeWork } from "@/lib/cr/activity"
import { notifyAgent } from "./agent-hooks"
import { sendDriverMessage, sendSiteMessage } from "./channel-client"
import type { SimAction } from "./scenarios"

/** Reserve before after() is scheduled so reset can see queued messages. */
export function reserveScenarioActions(): () => void {
  return beginRuntimeWork("queued scenario actions")
}

export async function runActions(origin: string, actions: SimAction[], reserved?: () => void): Promise<void> {
  const release = reserved ?? reserveScenarioActions()
  try {
    for (const action of actions) {
      if (action.kind === "telemetry") await notifyAgent(origin, action.request)
      if (action.kind === "driver_message") await sendDriverMessage(origin, action.request)
      if (action.kind === "site_message") await sendSiteMessage(origin, action.request)
    }
  } finally { release() }
}
