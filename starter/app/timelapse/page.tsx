import { connection } from "next/server"
import { DEFAULT_DURATION, DEFAULT_SEED } from "@/lib/present/timelapse"
import { loadTimelapse } from "@/lib/present/timelapse-load"
import { TimelapseStage } from "../components/timelapse/timelapse-stage"

export const metadata = { title: "Timelapse · Road Desk", robots: { index: false, follow: false } }

type Search = Record<string, string | string[] | undefined>
const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)
const number = (value: string | undefined, fallback: number, min: number, max: number) => {
  const parsed = value == null || value === "" ? NaN : Number(value)
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback
}

/**
 * A hidden page for the demo video: a made-up busy day played fast on the map. Read-only, no model calls.
 * ?duration=15 (seconds) &seed=n &clean=1 (no app chrome) &loop=1 &start=0 (wait for a click) &t=7.5 (a still at that film second).
 */
export default async function TimelapsePage({ searchParams }: { searchParams: Promise<Search> }) {
  await connection()
  const query = await searchParams
  const duration = number(one(query.duration), DEFAULT_DURATION, 4, 120)
  const { orders, cars } = await loadTimelapse()
  const frozen = one(query.t)
  return <TimelapseStage orders={orders} cars={cars} options={{
    duration, seed: Math.round(number(one(query.seed), DEFAULT_SEED, 0, 2 ** 31)),
    clean: one(query.clean) === "1", loop: one(query.loop) === "1", autostart: one(query.start) !== "0",
    freeze: frozen != null && frozen !== "" ? number(frozen, 0, 0, duration) : null,
  }} />
}
