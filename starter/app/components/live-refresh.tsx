"use client"

import { useRouter } from "next/navigation"
import { useEffect } from "react"

/**
 * Re-renders the server page every few seconds so new cases and decisions show
 * up without a reload (PLAN.md 4.2c: operator pages poll every 2–3 s). It pauses
 * while the tab is hidden.
 */
export function LiveRefresh({ every = 2500 }: { every?: number }) {
  const router = useRouter()
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = () => {
      if (document.visibilityState === "visible") router.refresh()
      timer = setTimeout(tick, every)
    }
    timer = setTimeout(tick, every)
    return () => clearTimeout(timer)
  }, [router, every])
  return null
}
