import { sql } from "drizzle-orm"
import { crDb } from "@/lib/cr/db"
import { listRuns } from "@/lib/cr/queries"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Recent agent runs and the total model spend (OpenRouter reports cost per call), for /demo and /agent.
export async function GET(request: Request) {
  const limit = Number(new URL(request.url).searchParams.get("limit") ?? 30)
  const [runs, totals] = await Promise.all([
    listRuns({ limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 30 }),
    crDb().execute(sql`SELECT count(*)::int AS runs, coalesce(sum((usage->>'cost_usd')::numeric), 0)::float AS cost FROM cr_agent_runs`),
  ])
  const total = (totals as unknown as { runs: number; cost: number }[])[0] ?? { runs: 0, cost: 0 }
  return Response.json({
    total_runs: total.runs,
    total_cost_usd: Math.round(total.cost * 10000) / 10000,
    runs: runs.map((run) => ({
      id: run.id, case_id: run.caseId, audience: run.audience, model: run.model, effort: run.effort, status: run.status,
      started_at: run.startedAt, finished_at: run.finishedAt, tools: run.toolCalls.map((call) => ({ name: call.name, gate: call.gate })),
      output: run.output, cost_usd: (run.usage as { cost_usd?: number } | null)?.cost_usd ?? 0, error: run.error,
    })),
  })
}
