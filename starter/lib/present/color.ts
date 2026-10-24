// A stable colour per person, from their name, so two drivers never share a swatch by accident and the same
// driver looks the same on the map, in a chat and on a call card. Hue from a hash; saturation and lightness fixed
// so every swatch holds white text at the same contrast and none clashes with the tone colours (red, amber, teal).

const HUES = [14, 32, 48, 95, 160, 200, 225, 262, 290, 320, 345]

function hash(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}

/** A solid swatch for a name or id: `hsl(h 48% 46%)`, readable with white text in light and dark themes. */
export function personColor(key: string | null | undefined): string {
  const hue = HUES[hash(key ?? "") % HUES.length]!
  return `hsl(${hue} 48% 46%)`
}

/** Two initials for a name ("Karin Calverick" → "KC"; a desk "Orvendin Cars Stockholm" → "OC"). */
export function initials(name: string | null | undefined): string {
  return (name ?? "").split(/\s+/).filter((part) => /^[\p{L}\d]/u.test(part)).map((part) => part[0]!.toUpperCase()).join("").slice(0, 2) || "?"
}
