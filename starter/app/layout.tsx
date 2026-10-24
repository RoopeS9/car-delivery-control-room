import type { Metadata, Viewport } from "next"
import Script from "next/script"
import { BuildWatch } from "./components/build-watch"
import { THEME_SCRIPT } from "./components/theme"
import "./globals.css"

export const metadata: Metadata = {
  title: "Road Desk",
  description: "Car delivery control room: the orders that need a person, with the agent's legwork already done. Fictional data.",
}

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fffef7" },
    { media: "(prefers-color-scheme: dark)", color: "#16150f" },
  ],
  width: "device-width",
  initialScale: 1,
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Applies a saved light or dark choice before the app loads. */}
        <Script id="theme" strategy="beforeInteractive">{THEME_SCRIPT}</Script>
        {/* Brand fallback faces: Unbounded for titles, Poppins for reading, Reddit Mono for identifiers.
            Loaded from Google Fonts; without a network the stack falls back to Arial. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600&family=Reddit+Mono:wght@400;500&family=Unbounded:wght@500;600;700&display=swap"
        />
      </head>
      <body>{children}<BuildWatch id={process.env.ROAD_DESK_BUILD ?? "development"} /></body>
    </html>
  )
}
