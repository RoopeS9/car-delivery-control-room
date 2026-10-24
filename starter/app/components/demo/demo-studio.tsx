"use client"

import type { CallData } from "../calls/call-section"
import { CallSimulator } from "../calls/call-simulator"
import { DemoPanel } from "./demo-panel"
import { DeliveryRun } from "./delivery-run"
import "./studio.css"

/**
 * Demo, Bahn's side: make things happen on the left (scenarios, clock,
 * simulated driver, reset) and see the robo-calls with their transcripts and
 * claims on the right. The driver's phone is its own panel; everything shows
 * on the map.
 */
export function DemoStudio({ calls, runnable }: { calls: CallData; runnable: { reference: string; id: string; title: string; phase: string }[] }) {
  return <main className="studio">
    <section className="studio-col studio-left" aria-label="Make things happen" data-keep-scroll="controls"><DemoPanel /></section>
    <section className="studio-col studio-right" aria-label="Calls" data-keep-scroll="calls"><DeliveryRun orders={runnable} /><CallSimulator {...calls} /></section>
  </main>
}
