// Records the /timelapse page for the demo video: an MP4 and three stills in ../video/assets.
// Needs the app running (APP_URL, default http://localhost:3000) and a seeded database; no model calls, no key.
// Playwright and ffmpeg are installed on the machine, not in package.json (no new dependencies).
//   npm run video:timelapse

import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"

const APP = process.env.APP_URL ?? "http://localhost:3000"
const DURATION = 15
const OUT = path.resolve(import.meta.dirname, "../../video/assets")
const MAX_MB = 15

// Playwright is global on this machine; resolve it from the global modules if the project has none.
const require = createRequire(import.meta.url)
function loadPlaywright(): { chromium: { launch: (options?: object) => Promise<any> } } {
  try { return require("playwright") } catch { /* fall through */ }
  const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim()
  return require(path.join(root, "playwright"))
}

async function tilesLoaded(page: any) {
  await page.waitForFunction(() => document.querySelector(".leaflet-tile-pane") && document.querySelectorAll(".leaflet-tile-loading").length === 0 && document.querySelectorAll(".leaflet-tile-loaded").length > 4, undefined, { timeout: 60000 })
  await page.waitForTimeout(800)
}

async function main() {
  const { chromium } = loadPlaywright()
  mkdirSync(OUT, { recursive: true })
  const work = mkdtempSync(path.join(tmpdir(), "timelapse-"))
  const browser = await chromium.launch()
  const query = `clean=1&duration=${DURATION}`

  // Stills first, from the frozen page (`t=` shows one film second), so they are exact and need no timing.
  const still = await (await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: "dark" })).newPage()
  await still.goto(`${APP}/timelapse?${query}&t=0.3`, { waitUntil: "load" })
  await still.waitForSelector(".tl-stage")
  const peak = Number(await still.getAttribute(".tl-stage", "data-peak"))
  for (const [name, t] of [["timelapse-start", 0.3], ["timelapse-peak", peak], ["timelapse-end", DURATION - 0.3]] as const) {
    await still.goto(`${APP}/timelapse?${query}&t=${t}`, { waitUntil: "load" })
    await still.waitForSelector(".tl-stage")
    await tilesLoaded(still)
    await still.screenshot({ path: path.join(OUT, `${name}.png`) })
    console.log(`still ${name}.png at film second ${t}`)
  }

  // The video: wait for the map and tiles with the film held back (start=0), click, record the run.
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: "dark", recordVideo: { dir: work, size: { width: 1920, height: 1080 } } })
  const page = await context.newPage()
  const opened = Date.now()
  await page.goto(`${APP}/timelapse?${query}&start=0`, { waitUntil: "load" })
  await tilesLoaded(page)
  await page.click(".tl-start button")
  const lead = (Date.now() - opened) / 1000
  await page.waitForSelector('.tl-stage[data-state="done"]', { timeout: (DURATION + 10) * 1000 })
  await page.waitForTimeout(300)
  await context.close()
  const video = await page.video().path()
  await browser.close()

  // Cut the loading before the click, encode at a bitrate that keeps it under the limit.
  const target = path.join(OUT, "timelapse.mp4")
  for (const kbps of [8000, 5000, 3000, 1800]) {
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", lead.toFixed(2), "-i", video, "-t", String(DURATION + 0.3), "-c:v", "libx264", "-b:v", `${kbps}k`, "-maxrate", `${kbps}k`, "-bufsize", `${kbps * 2}k`, "-pix_fmt", "yuv420p", "-r", "30", "-movflags", "+faststart", "-an", target])
    const mb = statSync(target).size / 1e6
    console.log(`timelapse.mp4 at ${kbps} kbit/s: ${mb.toFixed(1)} MB`)
    if (mb < MAX_MB) break
  }
  rmSync(work, { recursive: true, force: true })
  console.log(`Written to ${OUT}`)
}

main().catch((error) => { console.error(error); process.exit(1) })
