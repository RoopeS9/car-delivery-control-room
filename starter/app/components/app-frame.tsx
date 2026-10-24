import Link from "next/link"
import type { ReactNode } from "react"
import { fmtDateTime } from "@/lib/present/time"
import { Icon } from "./icons"
import { ThemeToggle } from "./theme-toggle"

export type Section = "queue" | "board" | "map" | "agent" | "inbox" | "customers" | "drivers" | "sites"

const GROUPS: { label: string; links: { section: Section; href: string; label: string; icon: string }[] }[] = [
  { label: "Work", links: [
    { section: "queue", href: "/", label: "Needs you", icon: "queue" },
    { section: "board", href: "/board", label: "All orders", icon: "board" },
    { section: "map", href: "/map", label: "Map", icon: "map" },
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

export function AppFrame({ children, section, snapshotAt, board = false }: { children: ReactNode; section: Section; snapshotAt?: string | null; board?: boolean }) {
  return <div className={`app${board ? " app-board" : ""}`}>
    <aside className="sidebar">
      <Link href="/" className="wordmark" aria-label="Control Room home">Control Room</Link>
      <nav className="sidebar-nav" aria-label="Main navigation">
        {GROUPS.map((group) => <div className="nav-group" key={group.label}>
          <div className="nav-label">{group.label}</div>
          {group.links.map((link) => <Link key={link.section} href={link.href} className={`nav-link${section === link.section ? " active" : ""}`} aria-current={section === link.section ? "page" : undefined}>
            <Icon name={link.icon} size={15} />{link.label}
          </Link>)}
        </div>)}
      </nav>
      <div className="sidebar-foot">
        <ThemeToggle />
        <p>{snapshotAt ? `Snapshot ${fmtDateTime(snapshotAt)}` : "Fictional snapshot"}<br />Fictional data · nothing real is booked or sent</p>
      </div>
    </aside>
    <div className="main">{children}</div>
  </div>
}
