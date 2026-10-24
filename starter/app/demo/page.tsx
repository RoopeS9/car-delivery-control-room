import { connection } from "next/server"
import { AppFrame } from "../components/app-frame"
import { CallSimulatorSection } from "../components/calls/call-section"
import { DemoPanel } from "../components/demo/demo-panel"

export const metadata = { title: "Demo · Road Desk" }

/** Demo: start scenarios, jump the clock, reset, and try the calls. Everything propagates to the map. */
export default async function DemoPage() {
  await connection()
  return <AppFrame section="demo">
    <DemoPanel><CallSimulatorSection /></DemoPanel>
  </AppFrame>
}
