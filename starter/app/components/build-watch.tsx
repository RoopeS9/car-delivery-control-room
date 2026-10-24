"use client"

import { useEffect, useState } from "react"

const EVERY_MS = 30_000

/**
 * After a redeploy an open tab still holds the old build's chunk names, so
 * navigation can fail quietly. Ask the server for its build every 30 s, and
 * at once after a failed request; when it differs, offer a reload.
 */
export function BuildWatch({ id }: { id: string }) {
  const [stale, setStale] = useState(false)
  useEffect(() => {
    if (id === "development") return
    let stopped = false
    let checking = false
    const check = async () => {
      if (checking || stopped) return
      checking = true
      try {
        const response = await original("/api/build", { cache: "no-store" })
        const body = (await response.json()) as { id?: string }
        if (!stopped && body.id && body.id !== id) setStale(true)
      } catch {
        // Server restarting; the next check tries again.
      } finally {
        checking = false
      }
    }
    const original = window.fetch.bind(window)
    window.fetch = async (...args: Parameters<typeof fetch>) => {
      try {
        const response = await original(...args)
        if (response.status === 404 || response.status >= 500) void check()
        return response
      } catch (error) {
        void check()
        throw error
      }
    }
    // A chunk of the old build that no longer exists fails as a script or module error.
    const onError = (event: Event) => { if (event.target instanceof HTMLScriptElement || event instanceof PromiseRejectionEvent) void check() }
    window.addEventListener("error", onError, true)
    window.addEventListener("unhandledrejection", onError)
    const timer = setInterval(() => void check(), EVERY_MS)
    return () => {
      stopped = true
      clearInterval(timer)
      window.fetch = original
      window.removeEventListener("error", onError, true)
      window.removeEventListener("unhandledrejection", onError)
    }
  }, [id])
  if (!stale) return null
  return <div className="build-banner" role="status">
    <span>A new version of Road Desk is ready.</span>
    <button type="button" className="btn primary" onClick={() => window.location.reload()}>Reload</button>
  </div>
}
