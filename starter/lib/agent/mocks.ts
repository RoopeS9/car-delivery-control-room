// Mocked outside world: nearby help and travel quotes. Every name here is
// fictional, every price is made up, and every result is labelled a
// suggestion or a quote, never a booking.

import { simNow } from "@/lib/cr/clock"
import type { BookingSelection, SourceRef } from "@/lib/cr/types"
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
  // Between the dataset's cities (most of a motorway), place the results around the position itself.
  const near = city.km <= 30 ? `${cityName}, ${country}` : "the reported position"
  const prefixes = PREFIXES[country] ?? PREFIXES.default
  const word = KIND_WORDS[input.kind][country] ?? KIND_WORDS[input.kind].default
  const base = seed(`${input.kind}${Math.round(input.lat * 10)}${Math.round(input.lng * 10)}`)
  const results = [0, 1, 2].map((index) => {
    const prefix = prefixes[(base + index * 3) % prefixes.length]
    const km = 3 + ((base >>> (index * 4)) % 25) + index * 6
    const name = input.kind === "brand_workshop" && input.make ? `${input.make} Partner ${prefix}` : `${word} ${prefix}`
    const result: Record<string, unknown> = {
      name: `${name} (fictional)`,
      distance_km: km,
      near,
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
    searched_near: city.km <= 30 ? `${cityName}, ${country} (${city.km} km from the given position)` : `the reported position (nearest listed city: ${cityName}, ${city.km} km away)`,
    results,
    source: { kind: "mock:nearby_help", id: `${input.kind}-${base}`, label: `Nearby ${input.kind.replace("_", " ")} search (mocked)` },
  }
}

export type TravelKind = "ferry" | "train" | "flight" | "hotel"

export function searchTravelOptions(input: { from: string; to: string; after_utc: string; kind: TravelKind }) {
  const after = Date.parse(input.after_utc)
  const start = Number.isFinite(after) ? after : simNow().getTime()
  const base = seed(`${input.kind}${input.from}${input.to}`)
  const quotedAt = simNow().toISOString()
  const searchId = `${input.kind}-${base}-${seed(new Date(start).toISOString())}-${seed(quotedAt)}`
  const source: SourceRef = { kind: "mock:travel", id: searchId, label: `${input.kind} quotes (mocked)`, at: quotedAt }
  const durations = { ferry: 29, train: 4, flight: 3, hotel: 12 }[input.kind]
  // A fixed daily timetable per route (minutes after midnight UTC, provider, base fare): the same sailing keeps its
  // time, provider and price however often or late it is searched. Only departures whose check-in is still open count.
  const timetable: Record<TravelKind, [number, string, number][]> = {
    ferry: [[3 * 60, "Vela Coast Lines", 420], [17 * 60 + 30, "Nordbridge Ferries", 465]],
    train: [[6 * 60 + 10, "Regional rail (fictional)", 64], [11 * 60 + 40, "Intercity (fictional)", 79], [16 * 60 + 25, "Intercity (fictional)", 79], [21 * 60 + 5, "Night train (fictional)", 92]],
    flight: [[7 * 60 + 15, "Skylark Air (fictional)", 185], [13 * 60 + 50, "Baltic Wings (fictional)", 210], [19 * 60 + 35, "Skylark Air (fictional)", 260]],
    hotel: [[0, "Hotel Lindenhof (fictional)", 95], [0, "Terminal Inn (fictional)", 118], [0, "Harbour Rooms (fictional)", 132]],
  }
  const leadMs = input.kind === "ferry" ? 2 * 3600000 : 0
  const departures: { departs: Date; provider: string; amount: number }[] = []
  if (input.kind === "hotel") {
    for (const [, provider, fare] of timetable.hotel) departures.push({ departs: new Date(start), provider, amount: fare + (base % 30) })
  } else {
    const firstDay = Math.floor(start / 86400000) * 86400000
    for (let day = 0; departures.length < 3 && day < 7; day++) {
      for (const [minute, provider, fare] of timetable[input.kind]) {
        const departs = new Date(firstDay + day * 86400000 + (minute + (base % 20)) * 60000)
        if (departs.getTime() - leadMs <= start || departures.length >= 3) continue
        departures.push({ departs, provider, amount: fare + ((base + Math.floor(departs.getTime() / 86400000) * 7) % 30) })
      }
    }
  }
  const providers = departures.map((entry) => entry.provider)
  const options = departures.map(({ departs, amount }, index) => {
    const arrives = new Date(departs.getTime() + durations * 3600000)
    const selection: BookingSelection = {
      quote_id: `${searchId}-${index}`, quote_source: source, quoted_at: quotedAt, kind: input.kind,
      provider: providers[index], from: input.from, to: input.to,
      departure_at: departs.toISOString(), arrival_at: arrives.toISOString(),
      check_in_cutoff_at: input.kind === "ferry" ? new Date(departs.getTime() - 2 * 3600000).toISOString() : null,
      price_amount: amount, currency: "EUR", replaces_reservation_id: null,
    }
    return {
      quote_id: selection.quote_id,
      provider: providers[index],
      from: input.from,
      to: input.to,
      departs_utc: input.kind === "hotel" ? null : departs.toISOString(),
      arrives_utc: input.kind === "hotel" ? null : arrives.toISOString(),
      price: `€${amount}${input.kind === "ferry" ? " for car and driver cabin" : input.kind === "hotel" ? " per night" : ""}`,
      price_amount: amount, currency: "EUR", check_in_cutoff_at: selection.check_in_cutoff_at,
      booking_selection: selection,
      availability: index === 0 && input.kind === "ferry" ? "vehicle space: limited" : "available",
      status: "QUOTE",
    }
  })
  return {
    note: "Mocked quotes for this demo. A quote is not a booking; availability can change. Nothing has been reserved.",
    checked_at_utc: quotedAt,
    options,
    source,
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
