// Towns along the simulated routes, used only to word a position ("near
// Osnabrück"). Real town names, approximate centres. The dataset's own 30
// cities come from knowledge/city-coords.json.

import coords from "@/knowledge/city-coords.json"
import { haversineKm, type LatLng } from "./geo"

const TOWNS: [string, number, number][] = [
  ["Dortmund", 51.514, 7.468], ["Münster", 51.96, 7.626], ["Osnabrück", 52.279, 8.047], ["Bremen", 53.079, 8.802],
  ["Hannover", 52.375, 9.732], ["Kassel", 51.312, 9.479], ["Göttingen", 51.541, 9.916], ["Würzburg", 49.792, 9.953],
  ["Nuremberg", 49.452, 11.077], ["Ingolstadt", 48.766, 11.426], ["Bayreuth", 49.945, 11.578], ["Hof", 50.313, 11.912],
  ["Erfurt", 50.978, 11.029], ["Magdeburg", 52.12, 11.628], ["Braunschweig", 52.269, 10.521], ["Lübeck", 53.866, 10.687],
  ["Kiel", 54.323, 10.123], ["Flensburg", 54.794, 9.446], ["Mannheim", 49.487, 8.466], ["Gießen", 50.584, 8.678],
  ["Bielefeld", 52.03, 8.532], ["Wuppertal", 51.256, 7.15], ["Siegen", 50.875, 8.024], ["Hamelin", 52.104, 9.36],
  ["Kolding", 55.49, 9.472], ["Vejle", 55.709, 9.536], ["Nyborg", 55.312, 10.79], ["Korsør", 55.33, 11.139],
  ["Ringsted", 55.443, 11.79], ["Padborg", 54.825, 9.362], ["Helsingborg", 56.046, 12.694], ["Halmstad", 56.674, 12.857],
  ["Jönköping", 57.782, 14.161], ["Linköping", 58.411, 15.621], ["Norrköping", 58.588, 16.192], ["Nyköping", 58.753, 17.008],
  ["Södertälje", 59.196, 17.626], ["Ljungby", 56.833, 13.941], ["Värnamo", 57.186, 14.04], ["Hämeenlinna", 60.996, 24.464],
  ["Salo", 60.384, 23.125], ["Jyväskylä", 62.242, 25.747], ["Kokkola", 63.838, 23.13], ["Pori", 61.485, 21.797],
  ["Forssa", 60.815, 23.621], ["Heinola", 61.204, 26.032], ["Kouvola", 60.868, 26.704], ["Jämsä", 61.864, 25.19],
  ["Vaasa", 63.096, 21.616], ["Raahe", 64.684, 24.479], ["Lohja", 60.249, 24.065], ["Pietarsaari", 63.673, 22.703],
  ["Valence", 44.933, 4.892], ["Avignon", 43.949, 4.806], ["Montélimar", 44.558, 4.751], ["Vienne", 45.525, 4.874],
]

const PLACES: { name: string; point: LatLng }[] = [
  ...TOWNS.map(([name, lat, lng]) => ({ name, point: [lat, lng] as LatLng })),
  ...Object.entries((coords as unknown as { cities: Record<string, { lat: number; lng: number }> }).cities)
    .map(([key, value]) => ({ name: key.split("|")[0], point: [value.lat, value.lng] as LatLng })),
]

/** The closest named town within `maxKm`, with its distance, or null. */
export function nearestPlace(point: LatLng, maxKm = 40): { name: string; km: number } | null {
  let best: { name: string; km: number } | null = null
  for (const place of PLACES) {
    const km = haversineKm(point, place.point)
    if (km <= maxKm && (!best || km < best.km)) best = { name: place.name, km }
  }
  return best
}

/** "near Osnabrück" when a town is close, otherwise "between Cologne and Hamburg". */
export function roughWhere(point: LatLng, from: string, to: string): string {
  const near = nearestPlace(point)
  return near ? `near ${near.name}` : `between ${from} and ${to}`
}
