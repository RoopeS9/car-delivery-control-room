import { NextResponse } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const BASE = process.env.CALL_SERVICE_URL ?? "http://127.0.0.1:8799"

/** One delivery run, as it stands now (steps are appended while it runs). */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  if (!/^[a-z0-9-]+$/i.test(id)) return NextResponse.json({ error: "bad run id" }, { status: 400 })
  try {
    const response = await fetch(`${BASE}/runs/${id}`, { cache: "no-store", signal: AbortSignal.timeout(5000) })
    return NextResponse.json(await response.json(), { status: response.status })
  } catch {
    return NextResponse.json({ error: "The call service is not reachable." }, { status: 502 })
  }
}
