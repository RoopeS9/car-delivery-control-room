// Small time formats for the chart. Times on the chart are UTC, said so beside the clock.

const DAY = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })
const CLOCK = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" })
const CLOCK_S = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "UTC" })

export function dayOf(iso: string | null): string {
  return iso ? DAY.format(new Date(iso)) : ""
}

export function clockOf(iso: string | null, seconds = false): string {
  return iso ? (seconds ? CLOCK_S : CLOCK).format(new Date(iso)) : ""
}

/** "in 3 h", "2 d ago", against the simulated clock. */
export function relative(iso: string | null, now: string): string {
  if (!iso) return ""
  const minutes = Math.round((Date.parse(iso) - Date.parse(now)) / 60000)
  const abs = Math.abs(minutes)
  if (abs < 1) return "now"
  const amount = abs < 60 ? `${abs} min` : abs < 36 * 60 ? `${Math.round(abs / 60)} h` : `${Math.round(abs / 1440)} d`
  return minutes < 0 ? `${amount} ago` : `in ${amount}`
}
