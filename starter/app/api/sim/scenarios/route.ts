import { NextResponse } from "next/server"
import { fleetCar } from "@/lib/sim/fleet"
import { SCENARIOS } from "@/lib/sim/scenarios"
import { activeFaults } from "@/lib/sim/sync"

export const runtime = "nodejs"

export async function GET() {
  const faults = await activeFaults()
  const scenarios = await Promise.all(SCENARIOS.map(async (scenario) => {
    const car = scenario.orderRef ? await fleetCar(scenario.orderRef) : null
    return { ...scenario, started: !!car && faults.has(car.orderId) }
  }))
  return NextResponse.json({ scenarios })
}
