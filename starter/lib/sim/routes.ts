// Route shapes for the simulator, read from knowledge/routes/routes.json
// (built by lib/sim/build-routes.ts). A route is a chain of road legs and, for
// ferry orders, one sea lane between the terminals.

import routeFile from "@/knowledge/routes/routes.json"
import type { LatLng } from "./geo"

export type RoadLeg = { from: string; to: string; coords: LatLng[]; km: number; minutes: number | null; shape: "ROAD" | "STRAIGHT_FALLBACK" }
export type SeaLane = { from: string; to: string; label: string; coords: LatLng[]; km: number }
export type RouteFile = { _about: string; generated_at: string; road: Record<string, RoadLeg>; sea: Record<string, SeaLane> }

const routes = routeFile as unknown as RouteFile

export function roadLeg(key: string): RoadLeg | null {
  return routes.road[key] ?? null
}

export function seaLane(key: string): SeaLane | null {
  return routes.sea[key] ?? null
}
