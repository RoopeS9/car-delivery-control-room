"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useEffect, useState, type ReactNode } from "react"
import { recall, remember, restoreScroll, roleUrlKey, saveScroll, type Role } from "./role-memory"
import { fmtDateTime } from "@/lib/present/time"
import { Icon } from "./icons"
import { ThemeToggle } from "./theme-toggle"

export type Section = "queue" | "board" | "map" | "driver" | "dealer" | "demo" | "calls" | "agent" | "inbox" | "customers" | "drivers" | "sites" | "site"

type NavLink = { section: Section; href: string; label: string; icon: string }

/**
 * Four roles we play, each a small site of its own with its own menu:
 * Operator (the map and the order work), Driver (the driver's phone),
 * Dealer (the desk at a pickup site) and Bahn (the demo controller).
 */
const ROLES: { id: Role; label: string; icon: string; href: string; links: NavLink[] }[] = [
  { id: "operator", label: "Operator", icon: "map", href: "/", links: [
    { section: "map", href: "/", label: "Map", icon: "map" },
    { section: "queue", href: "/queue", label: "Needs you", icon: "queue" },
    { section: "board", href: "/board", label: "All orders", icon: "board" },
    { section: "inbox", href: "/inbox", label: "Inbox", icon: "inbox" },
    { section: "agent", href: "/agent", label: "How the agent works", icon: "bot" },
    { section: "customers", href: "/customers", label: "Customers", icon: "people" },
    { section: "drivers", href: "/drivers", label: "Drivers", icon: "driver" },
    { section: "sites", href: "/sites", label: "Places", icon: "building" },
  ] },
  { id: "driver", label: "Driver", icon: "driver", href: "/driver", links: [
    { section: "driver", href: "/driver", label: "The driver's phone", icon: "driver" },
  ] },
  { id: "dealer", label: "Dealer", icon: "building", href: "/dealer", links: [
    { section: "dealer", href: "/dealer", label: "Pickup desk", icon: "building" },
    { section: "site", href: "/site", label: "Site chat", icon: "message" },
  ] },
  { id: "bahn", label: "Bahn", icon: "proposal", href: "/demo", links: [
    { section: "demo", href: "/demo", label: "Demo controller", icon: "proposal" },
  ] },
]

const ROLE_OF: Record<Section, Role> = {
  map: "operator", queue: "operator", board: "operator", inbox: "operator", agent: "operator", customers: "operator", drivers: "operator", sites: "operator",
  driver: "driver", dealer: "dealer", site: "dealer", demo: "bahn", calls: "bahn",
}

/**
 * The one frame: the four roles as a segmented control floating at the top
 * right of every page, the current role's menu in the sidebar, and the page
 * beside it. On the map the sidebar folds to a rail and opens over the map.
 */
export function AppFrame({ children, section, snapshotAt, board = false, rail = false, counts, extra }: {
  children: ReactNode; section: Section; snapshotAt?: string | null; board?: boolean
  /** Fold the navigation to a rail (the map). */
  rail?: boolean
  counts?: Partial<Record<Section, number>>
  extra?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false) }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open])
  const folded = rail && !open
  const role = ROLE_OF[section]
  const current = ROLES.find((item) => item.id === role) ?? ROLES[0]
  const needCount = counts?.map
  const pathname = usePathname()

  // Each role remembers where it was: its last page and query, and the scroll there.
  const [returns, setReturns] = useState<Partial<Record<Role, string>>>({})
  useEffect(() => {
    remember(roleUrlKey(role), `${window.location.pathname}${window.location.search}`)
    const next = Object.fromEntries(ROLES.map((item) => [item.id, recall<string>(roleUrlKey(item.id)) ?? item.href])) as Partial<Record<Role, string>>
    // Runs after every render (the query can change without the path); only a real change updates state.
    setReturns((current) => ROLES.every((item) => current[item.id] === next[item.id]) ? current : next)
  })
  useEffect(() => {
    const undo = restoreScroll()
    let timer = 0
    const onScroll = () => { window.clearTimeout(timer); timer = window.setTimeout(saveScroll, 250) }
    window.addEventListener("scroll", onScroll, true)
    window.addEventListener("pagehide", saveScroll)
    return () => { undo(); window.clearTimeout(timer); saveScroll(); window.removeEventListener("scroll", onScroll, true); window.removeEventListener("pagehide", saveScroll) }
  }, [pathname])
  return <div className={`app${board ? " app-board" : ""}${rail ? " app-rail" : ""}${rail && open ? " rail-open" : ""}`}>
    <aside className="sidebar" aria-label="Navigation">
      <div className="sidebar-top">
        <Link href="/" className="wordmark" aria-label="Road Desk home">{folded ? "RD" : "Road Desk"}</Link>
        {rail && <button type="button" className="rail-toggle" onClick={() => setOpen((value) => !value)} aria-expanded={open}
          aria-label={open ? "Fold the navigation" : "Open the navigation"} title={open ? "Fold the navigation" : "Open the navigation"}>
          <Icon name="chevron" size={14} style={open ? { transform: "rotate(180deg)" } : undefined} />
        </button>}
      </div>
      <nav className="sidebar-nav" aria-label={`${current.label} pages`}>
        <div className="nav-group">
          {current.links.map((link) => {
            const count = counts?.[link.section]
            return <Link key={link.section} href={link.href} title={folded ? link.label : undefined}
              className={`nav-link${section === link.section ? " active" : ""}`} aria-current={section === link.section ? "page" : undefined}>
              <Icon name={link.icon} size={15} /><span className="nav-text">{link.label}</span>
              {count != null && <span className={`nav-count${count > 0 ? " hot" : ""}`}>{count}</span>}
            </Link>
          })}
        </div>
      </nav>
      {rail && open && extra}
      <div className="sidebar-foot">
        <ThemeToggle />
        <p>{snapshotAt ? `Snapshot ${fmtDateTime(snapshotAt)}` : "Fictional snapshot"}<br />Fictional data · nothing real is booked or sent</p>
      </div>
    </aside>
    <nav className="roles" aria-label="Role">
      {ROLES.map((item) => <Link key={item.id} href={returns[item.id] ?? item.href} onClick={saveScroll} className={`role${item.id === role ? " active" : ""}`} aria-current={item.id === role ? "true" : undefined}>
        <Icon name={item.icon} size={14} /><span className="role-text">{item.label}</span>
        {item.id === "operator" && needCount != null && needCount > 0 && <span className="role-count" title={`${needCount} need a person`}>{needCount}</span>}
      </Link>)}
    </nav>
    {rail && open && <button type="button" className="rail-scrim" aria-label="Fold the navigation" onClick={() => setOpen(false)} />}
    <div className="main">{children}</div>
  </div>
}
