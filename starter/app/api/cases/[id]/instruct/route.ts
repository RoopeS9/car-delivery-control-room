import { errorResponse, readJson } from "@/lib/agent/http"
import { instructAgent, runInstruction } from "@/lib/agent/triggers"
import type { CaseActionResponse, InstructRequest } from "@/lib/cr/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// A free-text instruction to the agent on a case. The agent acts on it in the background.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  try {
    const body = await readJson<InstructRequest>(request)
    const row = await instructAgent(id, body.text, body.by)
    void runInstruction(id).catch((error) => console.error("Road Desk instruction failed", error))
    return Response.json({ case_id: id, case_status: row.status, next_step: row.nextAction, next_check_at: row.nextCheckAt?.toISOString() ?? null } satisfies CaseActionResponse)
  } catch (error) {
    return errorResponse(error)
  }
}
