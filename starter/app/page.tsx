import { connection } from "next/server"
import { loadChart } from "@/lib/present/chart-load"
import { ChartHome } from "./components/chart/chart-home"

export const metadata = { title: "Road Desk" }

/** Home: the chart of every delivery. The queue of cards lives at /queue. */
export default async function Home() {
  await connection()
  return <ChartHome initial={await loadChart()} />
}
