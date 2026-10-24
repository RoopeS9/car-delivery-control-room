// Each role keeps its own state when you switch away and back: the last page
// and query (which driver, which site, which order), scroll positions, and
// small per-page state (the map's selection and view). Kept in sessionStorage,
// per browser tab; every read and write tolerates storage being unavailable.

export type Role = "operator" | "driver" | "dealer" | "bahn"

const PREFIX = "rd:"

export function remember(key: string, value: unknown): void {
  try { sessionStorage.setItem(PREFIX + key, JSON.stringify(value)) } catch { /* storage unavailable: state simply resets */ }
}

export function recall<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(PREFIX + key)
    return raw ? JSON.parse(raw) as T : null
  } catch {
    return null
  }
}

/** The URL a role was last on, so its pill returns there. */
export const roleUrlKey = (role: Role) => `role:${role}:url`

const here = () => `${window.location.pathname}${window.location.search}`

/** Scroll of the window and of every [data-keep-scroll] container on this page. */
export function saveScroll(): void {
  const spots: Record<string, number> = { window: window.scrollY }
  document.querySelectorAll<HTMLElement>("[data-keep-scroll]").forEach((element) => { spots[element.dataset.keepScroll as string] = element.scrollTop })
  remember(`scroll:${here()}`, spots)
}

/** Put the scroll back, a few times while content arrives. */
export function restoreScroll(): () => void {
  const spots = recall<Record<string, number>>(`scroll:${here()}`)
  if (!spots) return () => undefined
  const apply = () => {
    if (spots.window) window.scrollTo({ top: spots.window })
    document.querySelectorAll<HTMLElement>("[data-keep-scroll]").forEach((element) => {
      const top = spots[element.dataset.keepScroll as string]
      if (top) element.scrollTop = top
    })
  }
  const timers = [50, 400, 1200].map((ms) => window.setTimeout(apply, ms))
  return () => timers.forEach((timer) => window.clearTimeout(timer))
}
