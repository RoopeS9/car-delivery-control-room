import type { SVGProps } from "react"

// A small stroke icon set at text size. Icons mark a kind of record; words carry the meaning.
const PATHS: Record<string, string> = {
  alert: "M8 2.5 14.2 13.5H1.8L8 2.5Z M8 6.5v3.2 M8 11.6v.1",
  work: "M3 3.5h10v9H3z M5.5 8l1.8 1.8L10.8 6",
  waiting: "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12Z M8 4.8V8l2.2 1.4",
  proposal: "M8 2.2 9.5 6.5 13.8 8 9.5 9.5 8 13.8 6.5 9.5 2.2 8l4.3-1.5L8 2.2Z",
  incident: "M3.5 13.5V2.8h8.3l-1.6 2.9 1.6 2.9H3.5",
  driver: "M8 8.2A2.9 2.9 0 1 0 8 2.4a2.9 2.9 0 0 0 0 5.8Z M2.8 14c.5-2.9 2.6-4.3 5.2-4.3s4.7 1.4 5.2 4.3",
  offer: "M2.6 8.6V3.2h5.4l5.4 5.4-5.4 5.4-5.4-5.4Z M5.6 6.2h.1",
  note: "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12Z M8 7.2V11 M8 5v.1",
  arrow: "M3 8h10 M9.2 4.2 13 8l-3.8 3.8",
  search: "M7 11.5A4.5 4.5 0 1 0 7 2.5a4.5 4.5 0 0 0 0 9Z M10.3 10.3 13.5 13.5",
  pin: "M8 14s4.3-4.1 4.3-7.6A4.3 4.3 0 0 0 3.7 6.4C3.7 9.9 8 14 8 14Z M8 7.9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z",
  flag: "M3.5 14V2.5h8.6l-1.8 3 1.8 3H3.5",
  yard: "M2.5 13.5V6.4L8 2.8l5.5 3.6v7.1H2.5Z M6 13.5V9h4v4.5",
  car: "M2.4 10.6V8.2l1.5-3.3h8.2l1.5 3.3v2.4H2.4Z M4.4 12.8v-2.2 M11.6 12.8v-2.2 M4.6 8.6h.1 M11.3 8.6h.1",
  ferry: "M2.3 10.4 8 12.5l5.7-2.1-1.1 3H3.4l-1.1-3Z M4.3 9.6V5.8h7.4v3.8 M8 5.8V3.4",
  train: "M4 2.8h8v8.1H4z M4 7h8 M6 13.3l-1.3 1.2 M10 13.3l1.3 1.2 M6.3 9.5h.1 M9.6 9.5h.1",
  plane: "M2.5 9.6 13.5 3.3l-2.8 10.1-2.9-4.1-5.3-.3Z M7.8 9.3l5.7-6",
  hotel: "M2.5 13.5V6.2h11v7.3 M2.5 9.8h11 M5.2 6.2V3.5h5.6v2.7 M1.5 13.5h13",
  file: "M4 2.5h5.3L12.5 5.7v7.8H4z M9 2.8v3.3h3.3",
  photo: "M2.8 3.5h10.4v9H2.8z M3.6 11.2l3-3.3 2.3 2.4 1.6-1.6 2.3 2.5 M10.4 6.3h.1",
  message: "M2.8 3.2h10.4v7.2H6.6L3.9 13V10.4H2.8z",
  chevron: "M6 3.5 10.5 8 6 12.5",
  check: "M3 8.4l3.2 3.1L13 4.8",
  dot: "M8 10.4a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8Z",
  key: "M6.2 9.8a3.3 3.3 0 1 1 0-4.6 3.3 3.3 0 0 1 0 4.6Z M8.4 8.4 14 14 M11.7 11.7l1.2-1.2 M9.8 9.8 11 8.6",
  bot: "M4 6h8v7H4z M8 3.2V6 M6.4 9.4h.1 M9.6 9.4h.1 M2 9v2 M14 9v2",
  people: "M6 7.6a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8Z M1.8 13.2c.4-2.4 2.1-3.6 4.2-3.6s3.8 1.2 4.2 3.6 M10.4 7.4a2 2 0 1 0 0-4 M11.6 9.8c1.5.3 2.4 1.4 2.7 3.2",
  building: "M3 13.5V3.5h7v10 M10 7.5h3v6 M5.2 6h.1 M7.6 6h.1 M5.2 8.6h.1 M7.6 8.6h.1 M5.2 11.2h.1 M7.6 11.2h.1 M1.8 13.5h12.4",
  inbox: "M2.5 9.2 4 3.5h8l1.5 5.7v3.3h-11z M2.5 9.2h3.3l.8 1.6h2.8l.8-1.6h3.3",
}

export type IconName = keyof typeof PATHS

export function Icon({ name, size = 16, className, ...rest }: { name: IconName | string; size?: number } & SVGProps<SVGSVGElement>) {
  const d = PATHS[name] ?? PATHS.note
  return <svg
    viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" focusable="false"
    fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
    className={`icon${className ? ` ${className}` : ""}`} {...rest}
  ><path d={d} /></svg>
}
