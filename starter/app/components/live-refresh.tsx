"use client"

import { useRouter } from "next/navigation"
import { useEffect } from "react"

const missing = new Set<string>()

/** POST a tick route; stop asking after its first 404/405 so a missing route costs one request. */
async function post(path: string): Promise<void> {
  if (missing.has(path)) return
  try {
    const response = await fetch(path, { method: "POST" })
    if (response.status === 404 || response.status === 405) missing.add(path)
  } catch {
    // Offline or restarting; the next poll tries again.
  }
}

/**
 * What an operator page does on every poll. The simulated world only moves when
 * asked (stream C's `/api/sim/tick` writes due telemetry and sets overheating
 * codes), and the driver app or /demo may not be open. Then PLAN.md 4.2's
 * `POST /api/cases/tick` (stream A) advances due follow-ups and watchdogs against
 * that fresh state. Both are idempotent.
 */
export async function tickCases(): Promise<void> {
  await post("/api/sim/tick")
  await post("/api/cases/tick")
}

/**
 * Re-renders the server page every few seconds so new cases and decisions show
 * up without a reload (PLAN.md 4.2c: operator pages poll every 2–3 s). It pauses
 * while the tab is hidden.
 */
export function LiveRefresh({ every = 2500 }: { every?: number }) {
  const router = useRouter()
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      if (document.visibilityState === "visible") {
        await tickCases()
        router.refresh()
      }
      timer = setTimeout(tick, every)
    }
    timer = setTimeout(tick, every)
    return () => clearTimeout(timer)
  }, [router, every])
  return null
}
