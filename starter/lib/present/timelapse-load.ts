// Database side of the timelapse page. Read-only: it never calls syncTelemetry or any writer, so opening /timelapse
// leaves the database as it was. Car positions come from the simulator's own pure motion model (the same function that
// produced the stored phone fixes), sampled across the simulated day; see the note on STEP_MINUTES.

import { loadFleet, type FleetCar } from "@/lib/sim/fleet"
import { simplify, type LatLng } from "@/lib/sim/geo"
import { baseMotion } from "@/lib/sim/motion"
import { withRebookedFerries } from "@/lib/sim/sync"
import { buildChart } from "./chart"
import { loadBoardBundles } from "./load"
import { DAY_END, DAY_START, type TimelapseOrder } from "./timelapse"

/**
 * One position every six simulated minutes; the page interpolates between them in a straight line, which on a six-minute
 * step is well inside the width of the road line on the map. Stored phone fixes cover only the minutes since the app
 * started, so the day is sampled from the model that wrote them instead.
 */
const STEP_MINUTES = 6

export type TimelapseCar = {
  orderId: string
  reference: string
  /** Positions at DAY_START and every STEP_MINUTES after: [lat, lng, heading]. */
  samples: [number, number, number][]
  route: LatLng[][]
}

export type TimelapseData = { orders: TimelapseOrder[]; cars: TimelapseCar[] }

function carOf(car: FleetCar): TimelapseCar {
  const from = Date.parse(DAY_START)
  const steps = Math.round((Date.parse(DAY_END) - from) / (STEP_MINUTES * 60000))
  const samples: TimelapseCar["samples"] = []
  for (let i = 0; i <= steps; i += 1) {
    const motion = baseMotion(car, new Date(from + i * STEP_MINUTES * 60000))
    samples.push([Math.round(motion.point[0] * 1e5) / 1e5, Math.round(motion.point[1] * 1e5) / 1e5, Math.round(motion.heading)])
  }
  return { orderId: car.orderId, reference: car.reference, samples, route: car.parts.map((part) => simplify(part.coords, 0.003)) }
}

export async function loadTimelapse(): Promise<TimelapseData> {
  const [fleet, { snapshotAt, simNow, bundles }] = await Promise.all([loadFleet().then(withRebookedFerries), loadBoardBundles()])
  // The queue's own wording for what is open on an order (an alert, a quiet phone, a missed connection), never a record id.
  const chart = buildChart({ bundles, fleet, samples: [], snapshotAt, now: simNow })
  const headline = new Map(chart.nodes.map((node) => [node.orderId, node.headline]))
  const cars = fleet.map(carOf).filter((car) => car.samples.length > 1)
  const orders: TimelapseOrder[] = fleet.map((car) => ({
    orderId: car.orderId, reference: car.reference, vehicle: car.vehicleTitle, driver: car.driverName, problem: headline.get(car.orderId) ?? null,
  }))
  return { orders, cars }
}
