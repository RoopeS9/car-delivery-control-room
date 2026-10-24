import { connection } from "next/server"
import { loadBoardBundles } from "@/lib/present/load"
import { buildQueue } from "@/lib/present/queue"
import { AppFrame } from "../components/app-frame"
import { LiveRefresh } from "../components/live-refresh"
import { QueuePage } from "../components/queue"

export const metadata = { title: "Needs you · Road Desk" }

export default async function QueueHome() {
  await connection()
  const { snapshotAt, simNow, bundles } = await loadBoardBundles()
  const queue = buildQueue(bundles, snapshotAt, simNow)
  return <AppFrame section="queue" snapshotAt={snapshotAt}>
    <QueuePage queue={queue} />
    <LiveRefresh />
  </AppFrame>
}
