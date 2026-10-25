"use strict"
// Turns raw captures into finished 1920x1080 clips: a phone frame for the driver's phone, a window frame for desktop
// recordings, on the brand background, with an optional label and an optional "real run" tag.
//
//   node frame.cjs --dir ../../captures/scenario-a-2026-...        every clip in a run, using its events.json
//   node frame.cjs clip.mp4 --mode phone --label "Leo's phone"      one clip
//   options: --mode phone|browser|plain   --label "text"   --tag "Real run, simulated data"
//            --bg light|dark   --crop x:y:w:h (source pixels, to punch in)   --out file.mp4   --preset medium
//
// Frames are drawn as transparent PNGs (the video shows through the hole), so the picture is never resampled twice.

const fs = require("fs")
const os = require("os")
const path = require("path")
const { spawnSync } = require("child_process")
const { loadPlaywright, parseArgs } = require("./lib.cjs")

const THEMES = {
  light: { bg: "#fffef7", ink: "#12110e", muted: "#6f6758", bar: "#f6f3ec", line: "#e6e0d2", accent: "#b04617", shadow: "rgba(18,17,14,.22)" },
  dark: { bg: "#12110e", ink: "#fffef7", muted: "#bdb6a6", bar: "#26241d", line: "#3a372d", accent: "#e8895a", shadow: "rgba(0,0,0,.55)" },
}
const LABELS = { demo: "Demo panel · the simulator", ops: "Operator’s screen", driver: "Driver’s phone", map: "The live map", doc: "Our process log" }

/** The geometry of each mode: where the video sits (x, y, w, h) on the 1920x1080 canvas. */
const GEOMETRY = {
  browser: { x: 160, y: 106, w: 1600, h: 900 },
  phone: { x: 731, y: 60, w: 430, h: 932 }, // the phone body is 458 x 960 around this
  plain: { x: 0, y: 0, w: 1920, h: 1080 },
}

function frameHtml(mode, t, { label, tag }) {
  const pill = (text, style = "") => `<div style="position:absolute;${style};background:${t.bar};color:${t.ink};border-radius:999px;padding:10px 22px;font:600 24px 'Poppins',Arial,sans-serif;white-space:nowrap">${text}</div>`
  const tagPill = tag ? `<div style="position:absolute;right:56px;bottom:30px;background:${t.accent};color:${t.bg};border-radius:999px;padding:8px 22px;font:600 22px 'Poppins',Arial,sans-serif">${tag}</div>` : ""
  if (mode === "browser") {
    const g = GEOMETRY.browser
    // One div whose inside is painted with inset shadows: a 12 px frame and a 52 px title bar, leaving the video hole clear.
    return `<div style="position:absolute;left:${g.x - 20}px;top:${g.y - 52}px;width:${g.w + 40}px;height:${g.h + 52 + 20}px;border-radius:22px;
      box-shadow:inset 0 0 0 20px ${t.bar}, inset 0 52px 0 0 ${t.bar}, 0 30px 80px ${t.shadow}, 0 0 0 2px ${t.line}"></div>
      <div style="position:absolute;left:${g.x}px;top:${g.y - 52}px;height:52px;display:flex;align-items:center;gap:10px">
        <i style="width:14px;height:14px;border-radius:50%;background:#e0775a"></i><i style="width:14px;height:14px;border-radius:50%;background:#e8c05a"></i><i style="width:14px;height:14px;border-radius:50%;background:#6aa889"></i>
        <span style="margin-left:18px;font:600 22px 'Poppins',Arial,sans-serif;color:${t.muted}">Road Desk${label ? " · " + label : ""}</span></div>${tagPill}`
  }
  if (mode === "phone") {
    const g = GEOMETRY.phone
    return `<div style="position:absolute;left:${g.x - 14}px;top:${g.y - 14}px;width:${g.w + 28}px;height:${g.h + 28}px;border-radius:64px;
      box-shadow:inset 0 0 0 14px #12110e, 0 30px 80px ${t.shadow}, 0 0 0 2px ${t.line}"></div>
      ${label ? pill(label, `left:${g.x + g.w + 90}px;top:${g.y + 380}px;font-size:34px;padding:14px 30px`) : ""}${tagPill}`
  }
  return tagPill
}

async function renderFrame(mode, themeName, opts, outPng) {
  const t = THEMES[themeName] || THEMES.light
  const { chromium } = loadPlaywright()
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
  await page.setContent(`<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600&display=swap">
    <style>html,body{margin:0;background:transparent;width:1920px;height:1080px;overflow:hidden}</style>
    <div style="position:relative;width:1920px;height:1080px">${frameHtml(mode, t, opts)}</div>`, { waitUntil: "networkidle" }).catch(() => {})
  await page.evaluate(() => document.fonts.ready).catch(() => {})
  await page.screenshot({ path: outPng, omitBackground: true })
  await browser.close()
}

function duration(file) {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" })
  return Number(r.stdout.trim()) || 0
}

async function frameOne(input, { mode, label, tag, bg, crop, out, preset }) {
  const t = THEMES[bg] || THEMES.light
  const g = GEOMETRY[mode]
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rd-frame-"))
  const png = path.join(tmp, "frame.png")
  await renderFrame(mode, bg, { label, tag }, png)
  const cropFilter = crop ? `crop=${String(crop).split(":").slice(2).join(":")}:${String(crop).split(":").slice(0, 2).join(":")},` : ""
  const graph = `color=c=${t.bg.replace("#", "0x")}:s=1920x1080:r=30[bg];[0:v]${cropFilter}scale=${g.w}:${g.h}:flags=lanczos:force_original_aspect_ratio=decrease,pad=${g.w}:${g.h}:(ow-iw)/2:(oh-ih)/2:color=${t.bg.replace("#", "0x")}[v];[bg][v]overlay=${g.x}:${g.y}:shortest=1[t];[t][1:v]overlay=0:0:format=auto,format=yuv420p`
  const args = ["-y", "-loglevel", "error", "-i", input, "-loop", "1", "-framerate", "30", "-i", png, "-filter_complex", graph, "-t", String(duration(input)), "-c:v", "libx264", "-preset", preset, "-crf", "15", "-r", "30", "-movflags", "+faststart", out]
  const result = spawnSync("ffmpeg", args, { stdio: "inherit" })
  fs.rmSync(tmp, { recursive: true, force: true })
  if (result.status !== 0) throw new Error("ffmpeg failed for " + input)
  console.log("  wrote", out)
}

;(async () => {
  const args = parseArgs()
  const preset = String(args.preset || "medium")
  const bg = String(args.bg || "light")
  if (args.dir) {
    const dir = path.resolve(String(args.dir))
    const info = JSON.parse(fs.readFileSync(path.join(dir, "events.json"), "utf8"))
    fs.mkdirSync(path.join(dir, "framed"), { recursive: true })
    for (const [name, clip] of Object.entries(info.clips)) {
      const mode = String(args.mode || clip.suggestedFrame)
      const out = path.join(dir, "framed", clip.file.replace(/\.mp4$/, "_framed.mp4"))
      await frameOne(path.join(dir, clip.file), { mode, label: LABELS[name] && mode !== "plain" ? LABELS[name] : "", tag: args.tag ? String(args.tag) : "", bg: name === "map" || name === "doc" ? "light" : bg, crop: args.crop, out, preset })
    }
    console.log("\nFramed clips are in", path.join(dir, "framed"))
  } else if (args._[0]) {
    const input = path.resolve(args._[0])
    const mode = String(args.mode || "browser")
    const out = path.resolve(String(args.out || input.replace(/\.mp4$/, "_framed.mp4")))
    await frameOne(input, { mode, label: args.label ? String(args.label) : "", tag: args.tag ? String(args.tag) : "", bg, crop: args.crop, out, preset })
  } else {
    console.error("Usage: node frame.cjs --dir <run folder>   or   node frame.cjs clip.mp4 --mode phone|browser|plain [--label ...] [--tag ...]")
    process.exit(1)
  }
})()
