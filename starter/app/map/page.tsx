import { connection } from "next/server"
import { loadBoardBundles, loadPositions } from "@/lib/present/load"
import { buildMap } from "@/lib/present/map"
import { AppFrame } from "../components/app-frame"
import { LiveRefresh } from "../components/live-refresh"
import { MapScreen } from "../components/map-screen"

export const metadata = { title: "Map · Road Desk" }

export default async function MapPage() {
  await connection()
  const [{ snapshotAt, simNow, bundles }, positions] = await Promise.all([loadBoardBundles(), loadPositions()])
  const view = buildMap(bundles, positions, simNow)
  return <AppFrame section="map" board snapshotAt={snapshotAt}>
    <MapScreen view={view} />
    <LiveRefresh />
  </AppFrame>
}
