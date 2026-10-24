import { NextResponse } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const BASE = process.env.CALL_SERVICE_URL ?? "http://127.0.0.1:8799"

/**
 * Asks the call service for the line's system prompt (the model-composed brief plus the whole dossier) before the
 * call is placed, so it is ready when the phone fetches it: 5 to 10 s the first time, sometimes much longer; cached
 * after. A 400 carries the reason the agent may not make this call (for example, the pickup site belongs to the
 * paying customer).
 */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const ref = url.searchParams.get("ref")
  const purpose = url.searchParams.get("purpose")
  if (!ref || !purpose || !/^[A-Z0-9-]+$/i.test(ref) || !/^[A-Z_]+$/.test(purpose)) return NextResponse.json({ ok: false, error: "ref and purpose are required" }, { status: 400 })
  try {
    const response = await fetch(`${BASE}/context/${encodeURIComponent(ref)}/${purpose}?by=model`, { cache: "no-store", signal: AbortSignal.timeout(90_000) })
    if (response.ok) return NextResponse.json({ ok: true, by: response.headers.get("x-brief-by") })
    const body = await response.json().catch(() => null) as { error?: string } | null
    return NextResponse.json({ ok: false, error: body?.error ?? `The call service answered ${response.status}.` }, { status: response.status === 400 ? 400 : 502 })
  } catch {
    return NextResponse.json({ ok: false, error: "The call service did not answer in time." }, { status: 504 })
  }
}
