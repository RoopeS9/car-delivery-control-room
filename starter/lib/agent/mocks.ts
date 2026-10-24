// Mocked outside world: nearby help and travel quotes. Every name here is
// fictional, every price is made up, and every result is labelled a
// suggestion or a quote, never a booking.

import { simNow } from "@/lib/cr/clock"
import { allCities } from "./knowledge"
import { distanceKm } from "./format"

export type HelpKind = "tow" | "brand_workshop" | "service_area" | "hotel"

const PREFIXES: Record<string, string[]> = {
  DE: ["Lindenau", "Rabenfeld", "Ostwalde", "Kranichsee", "Birkenhain"],
  FI: ["Kuusela", "Haapaniemi", "Rantala", "Koivula", "Mäntylä"],
  DK: ["Egelund", "Bøgholt", "Skovby", "Lindvig", "Havnsø"],
  SE: ["Björkvik", "Granholm", "Ekeby", "Lindås", "Sjövik"],
  default: ["Northgate", "Riverside", "Oakfield", "Westmere", "Hillcrest"],
}

const KIND_WORDS: Record<HelpKind, Record<string, string>> = {
  tow: { DE: "Abschleppdienst", FI: "Hinauspalvelu", DK: "Autohjælp", SE: "Bärgning", default: "Recovery" },
  brand_workshop: { DE: "Werkstatt", FI: "Huolto", DK: "Værksted", SE: "Verkstad", default: "Workshop" },
  service_area: { DE: "Rastanlage", FI: "Levähdysalue", DK: "Rasteplads", SE: "Rastplats", default: "Service area" },
  hotel: { DE: "Hotel", FI: "Hotelli", DK: "Hotel", SE: "Hotell", default: "Hotel" },
}

function nearestCity(lat: number, lng: number) {
  return allCities().map((city) => ({ ...city, km: distanceKm({ lat, lng }, city) })).sort((a, b) => a.km - b.km)[0]
}

/** A stable small number from text, so the same place always gives the same mock answers. */
function seed(text: string): number {
  let hash = 0
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return hash
}

export function findNearbyHelp(input: { lat: number; lng: number; kind: HelpKind; make: string | null }) {
  const city = nearestCity(input.lat, input.lng)
  const [cityName, country] = city.key.split("|")
  const prefixes = PREFIXES[country] ?? PREFIXES.default
  const word = KIND_WORDS[input.kind][country] ?? KIND_WORDS[input.kind].default
  const base = seed(`${input.kind}${Math.round(input.lat * 10)}${Math.round(input.lng * 10)}`)
  const results = [0, 1, 2].map((index) => {
    const prefix = prefixes[(base + index * 3) % prefixes.length]
    const km = 3 + ((base >> (index * 4)) % 25) + index * 6
    const name = input.kind === "brand_workshop" && input.make ? `${input.make} Partner ${prefix}` : `${word} ${prefix}`
    const result: Record<string, unknown> = {
      name: `${name} (fictional)`,
      distance_km: km,
      near: `${cityName}, ${country}`,
      phone: `+00 555 01${String((base + index) % 100).padStart(2, "0")} (fictional)`,
    }
    if (input.kind === "tow") {
      result.eta_minutes = 35 + km * 2
      result.price_quote = `about €${280 + km * 6} to the nearest brand workshop (quote, not booked)`
      result.flatbed = true
    }
    if (input.kind === "brand_workshop") {
      result.open_now = index !== 2
      result.can_take_vehicle = index === 0 ? "today" : "tomorrow morning"
    }
    if (input.kind === "hotel") result.price_quote = `€${89 + (base % 40) + index * 12} per night (quote, not booked)`
    if (input.kind === "service_area") result.facilities = index === 0 ? "fuel, café, toilets, lit car park" : "fuel, toilets"
    return result
  })
  return {
    note: "Mocked suggestions for this demo. Names are fictional. Prices are quotes, nothing is booked.",
    searched_near: `${cityName}, ${country} (${city.km} km from the given position)`,
    results,
    source: { kind: "mock:nearby_help", id: `${input.kind}-${base}`, label: `Nearby ${input.kind.replace("_", " ")} search (mocked)` },
  }
}

export type TravelKind = "ferry" | "train" | "flight" | "hotel"

export function searchTravelOptions(input: { from: string; to: string; after_utc: string; kind: TravelKind }) {
  const after = Date.parse(input.after_utc)
  const start = Number.isFinite(after) ? after : simNow().getTime()
  const base = seed(`${input.kind}${input.from}${input.to}`)
  const hours = { ferry: [7, 20, 31], train: [1, 3, 5], flight: [4, 9, 26], hotel: [0, 0, 0] }[input.kind]
  const durations = { ferry: 29, train: 4, flight: 3, hotel: 12 }[input.kind]
  const prices = { ferry: [420, 465, 390], train: [79, 64, 92], flight: [210, 185, 260], hotel: [95, 118, 132] }[input.kind]
  const providers = {
    ferry: ["Vela Coast Lines", "Nordbridge Ferries", "Vela Coast Lines"],
    train: ["Regional rail (fictional)", "Intercity (fictional)", "Night train (fictional)"],
    flight: ["Skylark Air (fictional)", "Baltic Wings (fictional)", "Skylark Air (fictional)"],
    hotel: ["Hotel Lindenhof (fictional)", "Terminal Inn (fictional)", "Harbour Rooms (fictional)"],
  }[input.kind]
  const options = [0, 1, 2].map((index) => {
    const departs = new Date(start + (hours[index] * 60 + (base % 50)) * 60000)
    const arrives = new Date(departs.getTime() + durations * 3600000)
    return {
      provider: providers[index],
      from: input.from,
      to: input.to,
      departs_utc: input.kind === "hotel" ? null : departs.toISOString(),
      arrives_utc: input.kind === "hotel" ? null : arrives.toISOString(),
      price: `€${prices[index] + (base % 30)}${input.kind === "ferry" ? " for car and driver cabin" : input.kind === "hotel" ? " per night" : ""}`,
      availability: index === 0 && input.kind === "ferry" ? "vehicle space: limited" : "available",
      status: "QUOTE",
    }
  })
  return {
    note: "Mocked quotes for this demo. A quote is not a booking; availability can change. Nothing has been reserved.",
    checked_at_utc: simNow().toISOString(),
    options,
    source: { kind: "mock:travel", id: `${input.kind}-${base}`, label: `${input.kind} quotes (mocked)` },
  }
}

/**
 * A mocked booking provider. It confirms with a fictional reference, except
 * when MOCK_PROVIDER_TIMEOUT=1 or for CD-420299 (ord-00299), whose dataset
 * history is exactly this: a provider request that timed out without a
 * confirmation. Then the outcome is unknown and must be reconciled.
 */
export function mockProviderBook(input: { orderId: string; kind: "recovery" | "travel"; provider: string }): { status: "confirmed" | "timeout"; reference: string } {
  const reference = `${input.kind === "recovery" ? "RCV" : "TRV"}-SIM-${(seed(`${input.orderId}${input.provider}${Date.now()}`) % 900000 + 100000).toString(36).toUpperCase()}`
  const timeout = process.env.MOCK_PROVIDER_TIMEOUT === "1" || input.orderId === "ord-00299"
  return { status: timeout ? "timeout" : "confirmed", reference }
}
