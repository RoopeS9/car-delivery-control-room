// Runs the follow-up work a scenario asks for: tell the agent about a fault,
// or send a driver or site message through the channel routes.

import { notifyAgent } from "./agent-hooks"
import { sendDriverMessage, sendSiteMessage } from "./channel-client"
import type { SimAction } from "./scenarios"

export async function runActions(origin: string, actions: SimAction[]): Promise<void> {
  for (const action of actions) {
    if (action.kind === "telemetry") await notifyAgent(origin, action.request)
    if (action.kind === "driver_message") await sendDriverMessage(origin, action.request)
    if (action.kind === "site_message") await sendSiteMessage(origin, action.request)
  }
}
