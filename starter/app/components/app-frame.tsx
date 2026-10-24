"use client"

import Link from "next/link"
import { useEffect, useState, type ReactNode } from "react"
import { fmtDateTime } from "@/lib/present/time"
import { Icon } from "./icons"
import { ThemeToggle } from "./theme-toggle"

export type Section = "queue" | "board" | "map" | "calls" | "agent" | "inbox" | "customers" | "drivers" | "sites"

type NavLink = { section: Section; href: string; label: string; icon: string; sub?: boolean }

const GROUPS: { label: string; links: NavLink[] }[] = [
  { label: "Work", links: [
    { section: "queue", href: "/queue", label: "Needs you", icon: "queue" },
    { section: "board", href: "/board", label: "All orders", icon: "board" },
    { section: "map", href: "/", label: "Map", icon: "map" },
    { section: "calls", href: "/calls", label: "Call simulator", icon: "message", sub: true },
    { section: "inbox", href: "/inbox", label: "Inbox", icon: "inbox" },
  ] },
  { label: "Agent", links: [
    { section: "agent", href: "/agent", label: "How the agent works", icon: "bot" },
  ] },
  { label: "People and places", links: [
    { section: "customers", href: "/customers", label: "Customers", icon: "people" },
    { section: "drivers", href: "/drivers", label: "Drivers", icon: "driver" },
    { section: "sites", href: "/sites", label: "Places", icon: "building" },
  ] },
]

/** Pages for the team: the simulated apps and test screens, out of the way of the operator's navigation. */
const MORE: { href: string; label: string }[] = [
  { href: "/driver", label: "Driver app" },
  { href: "/site", label: "Pickup site app" },
  { href: "/demo", label: "Demo panel" },
  { href: "/board", label: "All orders board" },
  { href: "/queue", label: "Needs you queue" },
  { href: "/agent", label: "How the agent works" },
  { href: "/driver/voice/test", label: "Voice test page" },
]

/**
 * The one frame: the left navigation and the page beside it. On the map the
 * navigation folds to a thin rail of icons and counts and opens over the map
 * on demand; `extra` is shown in the open navigation (the map puts the few
 * things that need a person there).
 */
export function AppFrame({ children, section, snapshotAt, board = false, rail = false, counts, extra }: {
  children: ReactNode; section: Section; snapshotAt?: string | null; board?: boolean
  /** Fold the navigation to a rail (the map). */
  rail?: boolean
  counts?: Partial<Record<Section, number>>
  extra?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false) }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open])
  const folded = rail && !open
  return <div className={`app${board ? " app-board" : ""}${rail ? " app-rail" : ""}${rail && open ? " rail-open" : ""}`}>
    <aside className="sidebar" aria-label="Navigation">
      <div className="sidebar-top">
        <Link href="/" className="wordmark" aria-label="Road Desk home">{folded ? "RD" : "Road Desk"}</Link>
        {rail && <button type="button" className="rail-toggle" onClick={() => setOpen((value) => !value)} aria-expanded={open}
          aria-label={open ? "Fold the navigation" : "Open the navigation"} title={open ? "Fold the navigation" : "Open the navigation"}>
          <Icon name="chevron" size={14} style={open ? { transform: "rotate(180deg)" } : undefined} />
        </button>}
      </div>
      <nav className="sidebar-nav" aria-label="Main navigation">
        {GROUPS.map((group) => <div className="nav-group" key={group.label}>
          <div className="nav-label">{group.label}</div>
          {group.links.map((link) => {
            const count = counts?.[link.section]
            return <Link key={link.section} href={link.href} title={folded ? link.label : undefined}
              className={`nav-link${link.sub ? " nav-sub" : ""}${section === link.section ? " active" : ""}`} aria-current={section === link.section ? "page" : undefined}>
              <Icon name={link.icon} size={15} /><span className="nav-text">{link.label}</span>
              {count != null && <span className={`nav-count${link.section === "queue" && count > 0 ? " hot" : ""}`}>{count}</span>}
            </Link>
          })}
        </div>)}
      </nav>
      {rail && open && extra}
      <div className="sidebar-foot">
        <details className="nav-more" open={moreOpen} onToggle={(event) => setMoreOpen((event.target as HTMLDetailsElement).open)}>
          <summary onClick={(event) => { if (folded) { event.preventDefault(); setOpen(true); setMoreOpen(true) } }} title="More pages">
            <Icon name="dot" size={14} /><span className="nav-text">More…</span>
          </summary>
          <ul>{MORE.map((item) => <li key={item.href}><Link href={item.href} className="nav-more-link">{item.label}</Link></li>)}</ul>
        </details>
        <ThemeToggle />
        <p>{snapshotAt ? `Snapshot ${fmtDateTime(snapshotAt)}` : "Fictional snapshot"}<br />Fictional data · nothing real is booked or sent</p>
      </div>
    </aside>
    {rail && open && <button type="button" className="rail-scrim" aria-label="Fold the navigation" onClick={() => setOpen(false)} />}
    <div className="main">{children}</div>
  </div>
}
