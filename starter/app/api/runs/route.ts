import { NextResponse } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const BASE = process.env.CALL_SERVICE_URL ?? "http://127.0.0.1:8799"

/** Stored delivery runs on the call service, newest first (?ref= for one order). */
export async function GET(request: Request) {
  const ref = new URL(request.url).searchParams.get("ref")
  try {
    const response = await fetch(`${BASE}/runs${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`, { cache: "no-store", signal: AbortSignal.timeout(5000) })
    return NextResponse.json(await response.json(), { status: response.status })
  } catch {
    return NextResponse.json({ error: "The call service is not reachable." }, { status: 502 })
  }
}

/** Starts a delivery run for one order: { ref, twist?, mode? }. Answers 202 with the run id to poll. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { ref?: unknown; twist?: unknown; mode?: unknown } | null
  if (typeof body?.ref !== "string" || !/^CD-\d{6}$/.test(body.ref)) return NextResponse.json({ error: "ref must be an order reference" }, { status: 400 })
  try {
    const response = await fetch(`${BASE}/runs`, {
      method: "POST", headers: { "content-type": "application/json" }, cache: "no-store", signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ ref: body.ref, ...(typeof body.twist === "string" ? { twist: body.twist } : {}), ...(typeof body.mode === "string" ? { mode: body.mode } : {}) }),
    })
    return NextResponse.json(await response.json(), { status: response.status })
  } catch {
    return NextResponse.json({ error: "The call service is not reachable." }, { status: 502 })
  }
}
