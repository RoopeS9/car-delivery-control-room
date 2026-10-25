import { NextResponse } from "next/server"
import { lifecycleOf } from "@/lib/cr/lifecycle"
import { fleetCar } from "@/lib/sim/fleet"
import { SCENARIOS } from "@/lib/sim/scenarios"
import { activeFaults } from "@/lib/sim/sync"

export const runtime = "nodejs"

export async function GET() {
  const faults = await activeFaults()
  // H, once the driver has reported a step, runs again to move the clock to the next step's time.
  const handover = await lifecycleOf("ord-00442").catch(() => ({}))
  const scenarios = await Promise.all(SCENARIOS.map(async (scenario) => {
    const car = scenario.orderRef ? await fleetCar(scenario.orderRef) : null
    const runLabel = scenario.name === "pickup-to-handover-442" && Object.keys(handover).length ? "Next step's time" : null
    return { ...scenario, started: !!car && faults.has(car.orderId), runLabel }
  }))
  return NextResponse.json({ scenarios })
}
