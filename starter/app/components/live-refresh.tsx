"use client"

import { useRouter } from "next/navigation"
import { useEffect } from "react"

let tickMissing = false

/**
 * PLAN.md 4.2: operator pages advance due follow-ups and watchdogs on every
 * poll (`POST /api/cases/tick`, stream A). Until that route exists the page
 * stops asking after the first 404, and nothing else depends on it.
 */
export async function tickCases(): Promise<void> {
  if (tickMissing) return
  try {
    const response = await fetch("/api/cases/tick", { method: "POST" })
    if (response.status === 404 || response.status === 405) tickMissing = true
  } catch {
    // Offline or restarting; the next poll tries again.
  }
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
