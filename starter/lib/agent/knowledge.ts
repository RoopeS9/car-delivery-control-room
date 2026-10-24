// The rulebook (markdown playbooks) and the knowledge files, read from disk
// once per process. Paths are relative to the starter folder, which is the
// working directory for `next dev`, scripts and tests.

import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"

const ROOT = process.cwd()

export type Playbook = { name: string; title: string; markdown: string }

export type TroubleCode = {
  code: string; title: string; system: string
  severity: "STOP_NOW" | "DRIVE_TO_SAFE_STOP" | "CONTINUE_AND_MONITOR"
  drivability: string; common_causes: string[]; questions_for_driver: string[]; ev_relevant: boolean; note: string
}

export type WarningLight = {
  id: string; name: string; colour: string; keywords: string[]
  severity: TroubleCode["severity"]; safety_instruction: string; who_decides_next: string; note: string
}

type Coords = { lat: number; lng: number }

const cache: {
  playbooks?: Playbook[]
  codes?: Map<string, TroubleCode>
  lights?: WarningLight[]
  coords?: { cities: Record<string, Coords>; terminals: Record<string, Coords & { name: string; city: string }> }
} = {}

export function playbooks(): Playbook[] {
  if (!cache.playbooks) {
    const dir = path.join(ROOT, "rulebook")
    cache.playbooks = readdirSync(dir).filter((file) => file.endsWith(".md")).sort().map((file) => {
      const markdown = readFileSync(path.join(dir, file), "utf8")
      const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? file
      return { name: file.replace(/\.md$/, ""), title, markdown }
    })
  }
  return cache.playbooks
}

export function playbook(name: string): Playbook | null {
  const key = name.trim().toLowerCase().replace(/\.md$/, "")
  return playbooks().find((book) => book.name === key || book.title.toLowerCase() === key) ?? null
}

export function troubleCode(code: string): TroubleCode | null {
  if (!cache.codes) {
    const file = JSON.parse(readFileSync(path.join(ROOT, "knowledge", "dtc.json"), "utf8")) as { codes: TroubleCode[] }
    cache.codes = new Map(file.codes.map((entry) => [entry.code, entry]))
  }
  return cache.codes.get(code.trim().toUpperCase()) ?? null
}

export function warningLights(): WarningLight[] {
  if (!cache.lights) {
    const file = JSON.parse(readFileSync(path.join(ROOT, "knowledge", "warning-lights.json"), "utf8")) as { lights: WarningLight[] }
    cache.lights = file.lights
  }
  return cache.lights
}

/** Best keyword matches for a driver's description of a light, strongest first. */
export function matchWarningLights(description: string): WarningLight[] {
  const text = description.toLowerCase()
  const flashing = /flash|blink/.test(text)
  return warningLights()
    .map((light) => {
      let score = light.keywords.filter((keyword) => text.includes(keyword)).length
      if (light.id === "check_engine_flashing" && !flashing) score -= 2
      if (light.id === "check_engine_steady" && flashing) score -= 2
      if (light.colour.startsWith("red") && /\bred\b/.test(text)) score += 1
      return { light, score }
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.light)
}

export function cityCoords(city: string, country: string): Coords | null {
  if (!cache.coords) cache.coords = JSON.parse(readFileSync(path.join(ROOT, "knowledge", "city-coords.json"), "utf8"))
  return cache.coords!.cities[`${city}|${country}`] ?? null
}

export function allCities(): { key: string; lat: number; lng: number }[] {
  if (!cache.coords) cache.coords = JSON.parse(readFileSync(path.join(ROOT, "knowledge", "city-coords.json"), "utf8"))
  return Object.entries(cache.coords!.cities).map(([key, value]) => ({ key, ...value }))
}
