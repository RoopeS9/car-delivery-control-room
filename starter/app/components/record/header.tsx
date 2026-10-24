"use client"

import Image from "next/image"
import Link from "next/link"
import type { RecordView, Tile } from "@/lib/present/types"
import { Icon } from "../icons"

export function RecordHero({ view }: { view: RecordView }) {
  const { header, story, journey } = view
  const vehicle = header.vehicle
  return <>
    {vehicle?.illustrationSlug && <figure className="cover">
      <Image src={`/car-images/${vehicle.illustrationSlug}.webp`} alt={`Illustration of a ${vehicle.title}`} fill sizes="(max-width: 900px) 100vw, 1040px" priority />
      <div className="cover-pill"><span className={`dot lane-${header.lane}`} /><span className="mono">{header.reference}</span><span>{header.laneLabel}</span></div>
      <span className="cover-info" title="Model illustration. Orders with the same model share it. It is not a photo or evidence of this car." aria-label="About this image"><Icon name="note" size={14} /></span>
    </figure>}
    <h1 className="page-title">{vehicle ? vehicle.title : "Vehicle not linked"}</h1>
    <div className="chips">
      {!vehicle?.illustrationSlug && <span className="chip-fact"><span className={`dot lane-${header.lane}`} /><span className="mono">{header.reference}</span>{header.laneLabel}</span>}
      <span className={`chip-fact${vehicle?.plate ? " mono" : ""}`} title="Registration"><Icon name="car" size={13} />{vehicle?.plate ?? "No plate"}</span>
      <span className={`chip-fact${vehicle?.vin ? " mono" : ""}`} title="Synthetic VIN"><Icon name="key" size={13} />{vehicle?.vin ?? "No VIN"}</span>
      <span className="chip-fact"><Icon name="arrow" size={13} />{header.routeKindLabel}{journey.distanceKm ? ` · ${journey.distanceKm} km` : ""}</span>
      <Link className="chip-fact link" href={`/customers/${header.customer.id}`}><Icon name="people" size={13} />{header.customer.name}</Link>
      {header.tradeIn && <span className="chip-fact">Trade-in: {header.tradeIn.title}</span>}
    </div>
    <p className="intro">{story.intro}</p>
    <div className="story">
      <p className={`story-headline tone-${story.tone}`}>{story.headline}</p>
      {story.detail && <p className="story-detail">{story.detail}</p>}
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
