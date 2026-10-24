import { NextResponse } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const BASE = process.env.CALL_SERVICE_URL ?? "http://127.0.0.1:8799"

/** One stored call on the call service, with its review when it is an outbound call. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  if (!/^[a-z0-9-]+$/i.test(id)) return NextResponse.json({ error: "bad call id" }, { status: 400 })
  try {
    const [call, review] = await Promise.all([
      fetch(`${BASE}/calls/${id}`, { cache: "no-store", signal: AbortSignal.timeout(5000) }),
      fetch(`${BASE}/calls/${id}/review`, { cache: "no-store", signal: AbortSignal.timeout(5000) }).catch(() => null),
    ])
    if (!call.ok) return NextResponse.json({ error: "No such call." }, { status: 404 })
    return NextResponse.json({ ...(await call.json()), review: review?.ok ? await review.json() : null })
  } catch {
    return NextResponse.json({ error: "The call service is not reachable." }, { status: 502 })
  }
}
