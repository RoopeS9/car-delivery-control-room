import Link from "next/link"
import { connection } from "next/server"
import { callBrief } from "@/lib/present/call-service"
import { buildDealerView } from "@/lib/present/dealer"
import { loadBoardBundles } from "@/lib/present/load"
import { AppFrame } from "../components/app-frame"
import { DealerDesk } from "../components/dealer/dealer-desk"
import "../components/dealer/dealer.css"

export const metadata = { title: "Dealer · Road Desk" }

type Search = Promise<{ [key: string]: string | string[] | undefined }>

/** The Dealer role: you are the desk at a pickup site. Pick a site, see its booked collections, take Mira's readiness call. */
export default async function DealerPage({ searchParams }: { searchParams: Search }) {
  await connection()
  const params = await searchParams
  const siteId = typeof params.site === "string" ? params.site : null
  const { bundles } = await loadBoardBundles()
  const view = buildDealerView(bundles, siteId)
  // What a readiness call sets out to find, from the call service's rule brief (cheap, local).
  const asks = Object.fromEntries(await Promise.all(view.collections.filter((item) => !item.customerSite).map(async (item) =>
    [item.reference, (await callBrief(item.reference, "PICKUP_READINESS"))?.ask ?? null] as const)))
  return <AppFrame section="dealer">
    <main className="dealer-panel">
      <nav className="dealer-sites" aria-label="Pickup sites" data-keep-scroll="sites">
        <header><h1>Dealer</h1><p>You are the desk at a pickup site. Pick the site you are playing.</p></header>
        <ul>{view.sites.map((site) => <li key={site.id}>
          <Link href={`/dealer?site=${site.id}`} className={`dealer-site${site.id === view.site?.id ? " picked" : ""}`} aria-current={site.id === view.site?.id ? "page" : undefined}>
            <b>{site.name}</b><small>{site.city} · {site.count} collection{site.count === 1 ? "" : "s"}</small>
          </Link>
        </li>)}</ul>
      </nav>
      {view.site ? <DealerDesk site={view.site} collections={view.collections} asks={asks} /> : <p className="dealer-empty">No pickup site has a collection coming.</p>}
    </main>
  </AppFrame>
}
