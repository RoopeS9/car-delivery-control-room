import { connection } from "next/server"
import { AppFrame } from "../components/app-frame"
import { loadCallData } from "../components/calls/call-section"
import { DemoStudio } from "../components/demo/demo-studio"
import { runnableOrders } from "../components/demo/runnable"

export const metadata = { title: "Demo · Road Desk" }

/** Demo, one screen: start scenarios and move the clock, see the calls; the driver's phone is its own panel. Everything propagates to the map. */
export default async function DemoPage() {
  await connection()
  const [calls, runnable] = await Promise.all([loadCallData(), runnableOrders()])
  return <AppFrame section="demo">
    <DemoStudio calls={calls} runnable={runnable} />
  </AppFrame>
}
