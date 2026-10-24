"use client"

import type { CallData } from "../calls/call-section"
import { CallSimulator } from "../calls/call-simulator"
import { DemoPanel } from "./demo-panel"
import "./studio.css"

/**
 * Demo, Bahn's side: make things happen on the left (scenarios, clock,
 * simulated driver, reset) and see the robo-calls with their transcripts and
 * claims on the right. The driver's phone is its own panel; everything shows
 * on the map.
 */
export function DemoStudio({ calls }: { calls: CallData }) {
  return <main className="studio">
    <section className="studio-col studio-left" aria-label="Make things happen"><DemoPanel /></section>
    <section className="studio-col studio-right" aria-label="Calls"><CallSimulator {...calls} /></section>
  </main>
}
