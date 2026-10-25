// Small formatting helpers for what the agent reads and writes. Times are
// shown in the place's own zone and measured against the simulated clock.

import { simNow } from "@/lib/cr/clock"

export function localTime(iso: string | null | undefined, timeZone?: string | null): string | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  const zone = timeZone || "UTC"
  const text = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
  }).format(date)
  return text.replace(",", "")
}

export function utcTime(iso: string | Date | null | undefined): string | null {
  if (!iso) return null
  const date = iso instanceof Date ? iso : new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`
}

/** "12 min ago", "in 3 h 10 min", measured against the simulated clock. */
export function relative(iso: string | Date | null | undefined, now: Date = simNow()): string | null {
  if (!iso) return null
  const date = iso instanceof Date ? iso : new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  const minutes = Math.round((date.getTime() - now.getTime()) / 60000)
  const abs = Math.abs(minutes)
  const span = abs < 60 ? `${abs} min` : abs < 48 * 60 ? `${Math.floor(abs / 60)} h${abs % 60 ? ` ${abs % 60} min` : ""}` : `${Math.round(abs / 1440)} days`
  if (abs === 0) return "now"
  return minutes < 0 ? `${span} ago` : `in ${span}`
}

export function money(cents: unknown, currency: unknown): string | null {
  if (typeof cents !== "number") return null
  const code = typeof currency === "string" ? currency : "EUR"
  return new Intl.NumberFormat("en-IE", { style: "currency", currency: code }).format(cents / 100)
}

export function firstName(name: string | null | undefined): string | null {
  return name ? name.split(/\s+/)[0] : null
}

/** Great-circle distance in km. */
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLng = (b.lng - a.lng) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2
  return Math.round(2 * 6371 * Math.asin(Math.sqrt(h)))
}
