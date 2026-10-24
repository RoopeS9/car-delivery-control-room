import { connection } from "next/server"
import { AppFrame } from "../components/app-frame"
import { loadCallData } from "../components/calls/call-section"
import { DemoStudio } from "../components/demo/demo-studio"

export const metadata = { title: "Demo · Road Desk" }

/** Demo, one screen: start scenarios and move the clock, watch the driver's phone, see the calls. Everything propagates to the map. */
export default async function DemoPage() {
  await connection()
  const calls = await loadCallData()
  const inbound = calls.scenarios?.find((scenario) => scenario.inbound && calls.drivers[scenario.id])
  return <AppFrame section="demo">
    <DemoStudio calls={calls} firstDriver={inbound ? { driverId: calls.drivers[inbound.id], orderRef: inbound.orderRef } : null} />
  </AppFrame>
}
