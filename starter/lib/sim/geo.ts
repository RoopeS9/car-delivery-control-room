// Small geometry helpers for the simulator: distances, bearings and walking a
// polyline by kilometres. Coordinates are [lat, lng] pairs throughout.

import coords from "@/knowledge/city-coords.json"

export type LatLng = [number, number]

type CityCoords = { cities: Record<string, { lat: number; lng: number }>; terminals: Record<string, { name: string; city: string; lat: number; lng: number }> }
const table = coords as unknown as CityCoords

/** City centre for a dataset city and country code, e.g. ("Cologne", "DE"). */
export function cityPoint(city: string, country: string): LatLng | null {
  const hit = table.cities[`${city}|${country}`]
  return hit ? [hit.lat, hit.lng] : null
}

export function terminalPoint(terminalId: string): { point: LatLng; name: string; city: string } | null {
  const hit = table.terminals[terminalId]
  return hit ? { point: [hit.lat, hit.lng], name: hit.name, city: hit.city.split("|")[0] } : null
}

/** Key of a road leg in knowledge/routes/routes.json, e.g. `city:Cologne|DE>terminal:terminal-west-baltic`. */
export const legKey = (fromId: string, toId: string) => `${fromId}>${toId}`
/** Key of a sea lane, e.g. `terminal-west-baltic>terminal-south-finland`. */
export const seaKey = (fromTerminalId: string, toTerminalId: string) => `${fromTerminalId}>${toTerminalId}`

const R = 6371

export function haversineKm(a: LatLng, b: LatLng): number {
  const rad = Math.PI / 180
  const dLat = (b[0] - a[0]) * rad
  const dLng = (b[1] - a[1]) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Compass bearing from a to b in degrees, 0 = north. */
export function bearing(a: LatLng, b: LatLng): number {
  const rad = Math.PI / 180
  const y = Math.sin((b[1] - a[1]) * rad) * Math.cos(b[0] * rad)
  const x = Math.cos(a[0] * rad) * Math.sin(b[0] * rad) - Math.sin(a[0] * rad) * Math.cos(b[0] * rad) * Math.cos((b[1] - a[1]) * rad)
  return (Math.atan2(y, x) / rad + 360) % 360
}

export function polylineKm(points: LatLng[]): number {
  let total = 0
  for (let index = 1; index < points.length; index += 1) total += haversineKm(points[index - 1], points[index])
  return total
}

/** The point `km` along a polyline, with the heading of the stretch it lies on. Clamped to the ends. */
export function pointAlong(points: LatLng[], km: number): { point: LatLng; heading: number } {
  if (points.length === 1) return { point: points[0], heading: 0 }
  let left = Math.max(0, km)
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]
    const b = points[index]
    const step = haversineKm(a, b)
    if (left <= step || index === points.length - 1) {
      const t = step === 0 ? 0 : Math.min(1, left / step)
      return { point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], heading: bearing(a, b) }
    }
    left -= step
  }
  return { point: points[points.length - 1], heading: 0 }
}

/** Douglas–Peucker simplification in degrees. Keeps the first and last point. */
export function simplify(points: LatLng[], tolerance: number): LatLng[] {
  if (points.length <= 2) return points
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack: [number, number][] = [[0, points.length - 1]]
  while (stack.length) {
    const [start, end] = stack.pop()!
    let worst = -1
    let worstDistance = tolerance
    for (let index = start + 1; index < end; index += 1) {
      const distance = offLine(points[index], points[start], points[end])
      if (distance > worstDistance) { worst = index; worstDistance = distance }
    }
    if (worst >= 0) { keep[worst] = 1; stack.push([start, worst], [worst, end]) }
  }
  return points.filter((_, index) => keep[index])
}

function offLine(p: LatLng, a: LatLng, b: LatLng): number {
  const dx = b[1] - a[1]
  const dy = b[0] - a[0]
  if (dx === 0 && dy === 0) return Math.hypot(p[1] - a[1], p[0] - a[0])
  const t = Math.max(0, Math.min(1, ((p[1] - a[1]) * dx + (p[0] - a[0]) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(p[1] - (a[1] + t * dx), p[0] - (a[0] + t * dy))
}
