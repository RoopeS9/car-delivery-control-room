import { connection } from "next/server"
import { buildAgentPage } from "@/lib/present/agent"
import { AgentScreen } from "../components/agent-screen"
import { AppFrame } from "../components/app-frame"
import { LiveRefresh } from "../components/live-refresh"

export const metadata = { title: "How the agent works · Road Desk" }

export default async function AgentPage() {
  await connection()
  const view = await buildAgentPage()
  return <AppFrame section="agent">
    <AgentScreen view={view} />
    <LiveRefresh every={5000} />
  </AppFrame>
}
