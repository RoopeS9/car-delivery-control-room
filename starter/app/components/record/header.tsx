"use client"

import Image from "next/image"
import Link from "next/link"
import type { RecordView, Tile } from "@/lib/present/types"
import { fmtDay } from "@/lib/present/time"
import { Icon } from "../icons"

export function RecordHero({ view, compact = false }: { view: RecordView; compact?: boolean }) {
  const { header, story, journey } = view
  const vehicle = header.vehicle
  return <>
    {vehicle?.illustrationSlug && !compact && <figure className="cover">
      <Image src={`/car-images/${vehicle.illustrationSlug}.webp`} alt={`Illustration of a ${vehicle.title}`} fill sizes="(max-width: 900px) 100vw, 1040px" priority />
      <div className="cover-pill"><span className={`dot lane-${header.lane}`} /><span className="mono">{header.reference}</span><span>{header.laneLabel}</span></div>
      <span className="cover-info" title="Model illustration. Orders with the same model share it. It is not a photo or evidence of this car." aria-label="About this image"><Icon name="note" size={14} /></span>
    </figure>}
    {compact ? <h2 className="page-title small">{vehicle ? vehicle.title : "Vehicle not linked"}</h2> : <h1 className="page-title">{vehicle ? vehicle.title : "Vehicle not linked"}</h1>}
    <div className="chips">
      {(!vehicle?.illustrationSlug || compact) && <span className="chip-fact"><span className={`dot lane-${header.lane}`} /><span className="mono">{header.reference}</span>{header.laneLabel}</span>}
      <span className={`chip-fact${vehicle?.plate ? " mono" : ""}`} title="Registration"><Icon name="car" size={13} />{vehicle?.plate ?? "No plate"}</span>
      <span className={`chip-fact${vehicle?.vin ? " mono" : ""}`} title="Synthetic VIN"><Icon name="key" size={13} />{vehicle?.vin ?? "No VIN"}</span>
      <span className="chip-fact"><Icon name="arrow" size={13} />{header.routeKindLabel}{journey.distanceKm ? ` · ${journey.distanceKm} km` : ""}</span>
      <Link className="chip-fact link" href={`/customers/${header.customer.id}`}><Icon name="people" size={13} />{header.customer.name}</Link>
      {header.tradeIn && <span className="chip-fact">Trade-in: {header.tradeIn.title}</span>}
    </div>
    <div className="chips chips-order" title={story.intro}>
      <span className="chip-fact"><Icon name="pin" size={13} />{header.from.city} → {header.to.city}</span>
      <span className="chip-fact"><Icon name="waiting" size={13} />Ordered {fmtDay(header.createdAt)}</span>
      {header.routeKind === "IMPORT" && <span className="chip-fact"><Icon name="ferry" size={13} />Import</span>}
    </div>
    <div className="story">
      <p className={`story-headline tone-${story.tone}`}>{story.headline}</p>
      {story.facts.length > 0 && <dl className="story-facts">{story.facts.map((item) => <div key={item.label + item.value} className={`story-fact tone-${item.tone}`}>
        <dt>{item.label}</dt><dd><b>{item.value}</b>{item.note && <span>{item.note}</span>}</dd>
      </div>)}</dl>}
    </div>
  </>
}

export function Tiles({ tiles }: { tiles: Tile[] }) {
  return <div className="tiles">{tiles.map((tile) => {
    const body = <>
      <div className="tile-label">{tile.label}</div>
      <div className="tile-value">{tile.value}</div>
      {tile.hint && <div className="tile-hint">{tile.hint}</div>}
    </>
    return tile.href
      ? <Link className={`tile tone-${tile.tone}`} href={tile.href} key={tile.label}>{body}</Link>
      : <div className={`tile tone-${tile.tone}`} key={tile.label}>{body}</div>
  })}</div>
}
