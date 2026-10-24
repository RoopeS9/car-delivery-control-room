// Builds knowledge/routes/routes.json: road shapes for every moving order's
// route, plus hand-drawn sea lanes between the fictional ferry terminals.
// Run once and commit the output:
//
//   npx tsx lib/sim/build-routes.ts            (fetch roads and draw sea lanes)
//   npx tsx lib/sim/build-routes.ts --sea-only (keep the fetched roads, redraw sea lanes)
//
// Road shapes come from the public OSRM demo router (OpenStreetMap data). If a
// request fails, the leg falls back to a straight line between the two
// points and is marked as such. Sea lanes never cross land: they follow the
// Elbe and the Kiel Canal out of Hamburg and the open Baltic to Helsinki.

import { readFile, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { cityPoint, legKey, polylineKm, seaKey, simplify, terminalPoint, type LatLng } from "./geo"
import type { RouteFile, RoadLeg, SeaLane } from "./routes"

type Row = Record<string, unknown>
const DATASET = process.env.DATASET_DIR ?? join(process.cwd(), "..", "dataset", "data")
const OUT = join(process.cwd(), "knowledge", "routes", "routes.json")

async function rows(name: string): Promise<Row[]> {
  return (await readFile(join(DATASET, `${name}.jsonl`), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Row)
}

// Waypoints on water, terminal to terminal. Approximate; drawn for a city-level map.
const SEA_LANES: Record<string, { label: string; via: LatLng[] }> = {
  [seaKey("terminal-west-baltic", "terminal-south-finland")]: {
    label: "Elbe, Kiel Canal and the Baltic Sea",
    via: [
      [53.545, 9.85], [53.575, 9.68], [53.645, 9.52], [53.77, 9.375], [53.89, 9.15],
      [54.0, 9.265], [54.105, 9.38], [54.19, 9.47], [54.3, 9.66], [54.36, 9.83], [54.372, 10.04], [54.368, 10.15],
      [54.43, 10.2], [54.5, 10.3], [54.55, 10.8], [54.6, 11.25], [54.42, 12.0], [54.5, 12.4], [54.85, 13.5],
      [55.4, 14.7], [55.9, 16.2], [56.4, 17.4], [56.7, 18.5], [57.3, 19.2], [58.0, 19.7], [58.7, 20.3], [59.2, 21.4],
      [59.45, 22.2],
      [59.75, 23.5], [60.05, 24.6],
    ],
  },
  [seaKey("terminal-east-nordic", "terminal-south-finland")]: {
    label: "Stockholm archipelago, Sea of Åland and the Gulf of Finland",
    via: [
      [59.36, 18.25], [59.4, 18.5], [59.43, 18.8], [59.5, 19.2], [59.75, 19.6], [59.95, 20.1], [59.85, 21.0],
      [59.75, 22.0], [59.75, 23.5], [60.05, 24.6],
    ],
  },
}

type Endpoint = { id: string; point: LatLng; label: string }

function cityEndpoint(city: string, country: string): Endpoint | null {
  const point = cityPoint(city, country)
  return point ? { id: `city:${city}|${country}`, point, label: city } : null
}

function terminalEndpoint(terminalId: string): Endpoint | null {
  const hit = terminalPoint(terminalId)
  return hit ? { id: `terminal:${terminalId}`, point: hit.point, label: hit.name } : null
}

async function osrm(from: LatLng, to: LatLng): Promise<{ coords: LatLng[]; km: number; minutes: number } | null> {
  const url = `https://router.project-osrm.org/route/v1/driving/${from[1]},${from[0]};${to[1]},${to[0]}?overview=full&geometries=geojson`
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { "user-agent": "car-delivery-control-room hackathon prototype (route shapes, run once)" } })
      if (response.ok) {
        const body = await response.json() as { routes?: { distance: number; duration: number; geometry: { coordinates: [number, number][] } }[] }
        const route = body.routes?.[0]
        if (route) {
          const coords = route.geometry.coordinates.map(([lng, lat]) => [lat, lng] as LatLng)
          return { coords, km: route.distance / 1000, minutes: route.duration / 60 }
        }
      }
    } catch { /* retry below */ }
    await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)))
  }
  return null
}

const round = (point: LatLng): LatLng => [Math.round(point[0] * 1e5) / 1e5, Math.round(point[1] * 1e5) / 1e5]

async function main(): Promise<void> {
  const [orders, assignments, points, segments, addresses, reservations] = await Promise.all([
    rows("orders"), rows("work_assignments"), rows("transport_points"), rows("transport_segments"), rows("addresses"),
    rows("travel_reservations"),
  ])
  const addressById = new Map(addresses.map((row) => [String(row.id), row]))
  const pointById = new Map(points.map((row) => [String(row.id), row]))
  const segmentById = new Map(segments.map((row) => [String(row.id), row]))
  const orderById = new Map(orders.map((row) => [String(row.id), row]))
  const legs = new Map<string, [Endpoint, Endpoint]>()

  // A car is moving when its driver assignment is in progress. That also covers
  // a trade-in return that is still moving after the primary car was delivered.
  for (const assignment of assignments.filter((row) => row.status === "IN_PROGRESS")) {
    const order = orderById.get(String(assignment.order_id))
    for (const segmentId of assignment.segment_ids as string[]) {
      const segment = segmentById.get(segmentId)
      if (!order || !segment) continue
      const fromAddress = addressById.get(String(pointById.get(String(segment.from_point_id))?.address_id))
      const toAddress = addressById.get(String(pointById.get(String(segment.to_point_id))?.address_id))
      if (!fromAddress || !toAddress) continue
      const from = cityEndpoint(String(fromAddress.city), String(fromAddress.country))
      const to = cityEndpoint(String(toAddress.city), String(toAddress.country))
      if (!from || !to) { console.warn(`No coordinates for ${order.reference}`); continue }
      const ferry = segment.transport_mode === "DRIVE_WITH_FERRY"
        ? reservations.find((row) => row.order_id === order.id && row.kind === "FERRY" && row.status === "BOOKED")
        : undefined
      if (ferry) {
        const origin = terminalEndpoint(String(ferry.origin_terminal_id))
        const destination = terminalEndpoint(String(ferry.destination_terminal_id))
        if (!origin || !destination) { console.warn(`Unknown terminal on ${order.reference}`); continue }
        if (!SEA_LANES[seaKey(String(ferry.origin_terminal_id), String(ferry.destination_terminal_id))]) {
          console.warn(`No sea lane for ${order.reference}: ${ferry.origin_terminal_id} -> ${ferry.destination_terminal_id}`)
        }
        legs.set(legKey(from.id, origin.id), [from, origin])
        legs.set(legKey(destination.id, to.id), [destination, to])
      } else {
        legs.set(legKey(from.id, to.id), [from, to])
      }
    }
  }

  const road: Record<string, RoadLeg> = {}
  const previous = process.argv.includes("--sea-only")
    ? (JSON.parse(await readFile(OUT, "utf8")) as RouteFile).road
    : {}
  for (const [key, [from, to]] of [...legs.entries()].sort()) {
    if (previous[key]) { road[key] = previous[key]; continue }
    const fetched = await osrm(from.point, to.point)
    const coords = fetched ? simplify(fetched.coords, 0.004).map(round) : [from.point, to.point]
    road[key] = {
      from: from.label, to: to.label, coords,
      km: Math.round(fetched?.km ?? polylineKm(coords) * 1.25),
      minutes: fetched ? Math.round(fetched.minutes) : null,
      shape: fetched ? "ROAD" : "STRAIGHT_FALLBACK",
    }
    console.log(`${fetched ? "road " : "LINE "} ${from.label} -> ${to.label}: ${road[key].km} km, ${coords.length} points`)
    await new Promise((resolve) => setTimeout(resolve, 1100))
  }

  const sea: Record<string, SeaLane> = {}
  for (const [key, lane] of Object.entries(SEA_LANES)) {
    const [fromId, toId] = key.split(">")
    const from = terminalPoint(fromId)!
    const to = terminalPoint(toId)!
    const coords = [from.point, ...lane.via, to.point].map(round)
    sea[key] = { from: from.name, to: to.name, label: lane.label, coords, km: Math.round(polylineKm(coords)) }
  }

  const file: RouteFile = {
    _about: "Route shapes for simulated phone GPS. Road legs: OSRM demo router, map data © OpenStreetMap contributors (ODbL), " +
      "simplified. Sea lanes: drawn by hand between the fictional terminals, which the dataset only places at city level. " +
      "Every position derived from these is simulated.",
    generated_at: new Date().toISOString(),
    road,
    sea,
  }
  await mkdir(join(OUT, ".."), { recursive: true })
  await writeFile(OUT, `${JSON.stringify(file)}\n`)
  console.log(`Wrote ${Object.keys(road).length} road legs and ${Object.keys(sea).length} sea lanes to ${OUT}`)
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
