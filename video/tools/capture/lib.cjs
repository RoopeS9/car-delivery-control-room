"use strict"
// Shared helpers for the screen-capture scripts. See README.md in this folder.
//
// What a "stage" is: one browser window being recorded. A run can open several at once (the demo
// panel, the driver's phone, the operator's screen). They all start within a few milliseconds of
// each other, and the offset of each one is written to events.json, so the clips line up in Final Cut.
//
// Why 2560x1440 and a page zoom instead of device pixel density: Playwright's video ignores the
// device pixel ratio (checked: a 2x page still records at 1x). So we record a big viewport and zoom
// the page, which gives a crisp 1440p picture that can be punched in on and still look sharp at 1080p.

const fs = require("fs")
const path = require("path")
const { spawnSync } = require("child_process")

// The repository root. These scripts live in video/tools/capture; if you keep them elsewhere, set ROAD_DESK_ROOT to the repository.
const ROOT = process.env.ROAD_DESK_ROOT ? path.resolve(process.env.ROAD_DESK_ROOT) : path.resolve(__dirname, "..", "..", "..")

function loadPlaywright() {
  const tried = []
  for (const base of [__dirname, ROOT, path.join(ROOT, "starter"), process.cwd()]) {
    try { return require(require.resolve("playwright", { paths: [base] })) } catch (error) { tried.push(base) }
  }
  console.error("Playwright is not installed. From video/tools/capture run:  npm install && npx playwright install chromium")
  process.exit(2)
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("--")) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith("--")) out[key] = true
      else { out[key] = next; i++ }
    } else out._.push(a)
  }
  return out
}

function config(args) {
  return {
    app: String(args.app || process.env.APP_URL || "http://localhost:3000").replace(/\/$/, ""),
    out: path.resolve(String(args.out || path.join(ROOT, "video", "captures"))),
    theme: String(args.theme || "light"),
    zoom: Number(args.zoom || 1.5),
    slow: Number(args.slow || 1), // 1 = a calm human pace; 1.5 = slower; 0.5 = quick test runs
    headed: Boolean(args.headed),
    keepRaw: Boolean(args["keep-raw"]),
    preset: String(args.preset || "medium"), // x264 speed: ultrafast for test runs, medium for the real thing
    crf: String(args.crf || 15), // x264 quality: lower is better and bigger
    maxWait: Number(args["max-wait"] || 240) * 1000, // how long to wait for the agent, per step
    noModel: Boolean(args["no-model"]), // skip the steps that start an agent run (no credit is spent)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)

// ---- what runs inside every page: page zoom, the cursor and the click ripple, hiding dev badges ----

function overlayInit({ zoom }) {
  const install = () => {
    if (!document.documentElement || document.getElementById("rd-style")) return
    const style = document.createElement("style")
    style.id = "rd-style"
    style.textContent = `
      html { zoom: ${zoom}; }
      nextjs-portal, [data-nextjs-toast], [data-next-badge-root], #__next-build-watcher { display: none !important; }
      #rd-cursor { position: fixed; left: 0; top: 0; width: 30px; height: 30px; pointer-events: none; z-index: 2147483647; display: none; filter: drop-shadow(0 2px 3px rgba(0,0,0,.35)); }
      .rd-ripple { position: fixed; pointer-events: none; z-index: 2147483646; width: 44px; height: 44px; margin: -22px 0 0 -22px; border: 4px solid rgba(176,70,23,.9); border-radius: 50%; animation: rd-rip .55s ease-out forwards; }
      @keyframes rd-rip { from { opacity: .95; transform: scale(.4); } to { opacity: 0; transform: scale(2.2); } }
      * { caret-color: #b04617; }
    `
    document.documentElement.appendChild(style)
    const cursor = document.createElement("div")
    cursor.id = "rd-cursor"
    cursor.innerHTML = '<svg width="30" height="30" viewBox="0 0 30 30"><path d="M5 3 L5 24 L10.5 19 L14 27 L17.5 25.5 L14 18 L21 18 Z" fill="#12110e" stroke="#fffef7" stroke-width="2" stroke-linejoin="round"/></svg>'
    document.documentElement.appendChild(cursor)
    window.addEventListener("mousemove", (event) => {
      cursor.style.display = "block"
      cursor.style.left = event.clientX / zoom + "px"
      cursor.style.top = event.clientY / zoom + "px"
    }, true)
    window.addEventListener("mousedown", (event) => {
      const ripple = document.createElement("div")
      ripple.className = "rd-ripple"
      ripple.style.left = event.clientX / zoom + "px"
      ripple.style.top = event.clientY / zoom + "px"
      document.documentElement.appendChild(ripple)
      setTimeout(() => ripple.remove(), 700)
    }, true)
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install)
  else install()
}

// ---- a run: several recorded stages, one event log, one output folder ----

const KINDS = {
  desktop: (cfg) => ({ width: 2560, height: 1440, zoom: cfg.zoom }), // recorded big, zoomed, framed to 1080p later
  map: () => ({ width: 1920, height: 1080, zoom: 1 }), // the map's own mouse maths is simplest without page zoom
  phone: () => ({ width: 430, height: 932, zoom: 1 }), // shown at about 1:1 inside the phone frame
}

class Run {
  constructor(name, cfg) {
    this.name = name
    this.cfg = cfg
    this.dir = path.join(cfg.out, `${name}-${stamp()}`)
    fs.mkdirSync(path.join(this.dir, "_raw"), { recursive: true })
    this.stages = []
    this.events = []
    this.t0 = null
  }

  async launch() {
    const { chromium } = loadPlaywright()
    this.browser = await chromium.launch({ headless: !this.cfg.headed, args: ["--hide-scrollbars", "--disable-infobars"] })
    return this
  }

  /** Open one recorded window. kind: desktop | map | phone. */
  async stage(name, { kind = "desktop", route = "/", theme } = {}) {
    const dims = KINDS[kind](this.cfg)
    const size = { width: dims.width, height: dims.height }
    const context = await this.browser.newContext({
      viewport: size,
      colorScheme: theme || this.cfg.theme,
      locale: "en-GB",
      recordVideo: { dir: path.join(this.dir, "_raw", name), size },
    })
    await context.addInitScript(overlayInit, { zoom: dims.zoom })
    const page = await context.newPage()
    const startedAt = Date.now()
    if (this.t0 === null) this.t0 = startedAt
    const stage = { name, kind, context, page, size, startedAt, route }
    this.stages.push(stage)
    await page.goto(/^(https?|file):/.test(route) ? route : this.cfg.app + route, { waitUntil: "domcontentloaded" })
    return stage
  }

  /** Note something that happened, in seconds since the first stage opened. These become markers for the edit. */
  mark(label, detail = "") {
    const t = this.t0 === null ? 0 : (Date.now() - this.t0) / 1000
    this.events.push({ t: Math.round(t * 10) / 10, label, detail })
    console.log(`  ${fmt(t)}  ${label}${detail ? "  " + String(detail).slice(0, 110) : ""}`)
  }

  /** Close every window (this is what writes the videos), convert them, and write the event log. */
  async finish() {
    const files = {}
    for (const stage of this.stages) {
      let raw = null
      try { raw = await stage.page.video()?.path() } catch { /* the page may already be closed */ }
      await stage.context.close()
      if (!raw || !fs.existsSync(raw)) { console.warn(`  no video for ${stage.name}`); continue }
      const mp4 = path.join(this.dir, `${this.name}_${stage.name}.mp4`)
      const result = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", raw, "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-preset", this.cfg.preset, "-crf", this.cfg.crf, "-movflags", "+faststart", mp4], { stdio: "inherit" })
      if (result.status !== 0) { console.warn(`  ffmpeg failed for ${stage.name}; raw file kept at ${raw}`); continue }
      files[stage.name] = {
        file: path.basename(mp4), kind: stage.kind, width: stage.size.width, height: stage.size.height,
        offsetSeconds: Math.round((stage.startedAt - this.t0)) / 1000,
        suggestedFrame: stage.kind === "phone" ? "phone" : stage.kind === "map" ? "plain" : "browser",
      }
    }
    await this.browser.close()
    if (!this.cfg.keepRaw) fs.rmSync(path.join(this.dir, "_raw"), { recursive: true, force: true })
    const info = { run: this.name, folder: path.basename(this.dir), app: this.cfg.app, clips: files, events: this.events }
    fs.writeFileSync(path.join(this.dir, "events.json"), JSON.stringify(info, null, 2))
    fs.writeFileSync(path.join(this.dir, "events.csv"), "seconds,label,detail\n" + this.events.map((e) => [e.t, csv(e.label), csv(e.detail)].join(",")).join("\n") + "\n")
    console.log(`\nDone: ${this.dir}`)
    for (const [name, clip] of Object.entries(files)) console.log(`  ${clip.file}  (${name}, starts ${clip.offsetSeconds}s after the first window)`)
    return info
  }
}

const csv = (text) => `"${String(text).replace(/"/g, '""')}"`
const fmt = (seconds) => `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${(seconds % 60).toFixed(1).padStart(4, "0")}`

// ---- acting: a visible, human-paced pointer ----

async function moveTo(stage, locator, { steps = 28, dx = 0, dy = 0 } = {}) {
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  if (!box) throw new Error("element has no box")
  await stage.page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps })
}

async function click(stage, locator, cfg, opts = {}) {
  await moveTo(stage, locator, opts)
  await sleep(250 * cfg.slow)
  await locator.click({ delay: 90 })
  await sleep(200 * cfg.slow)
}

async function typeSlow(stage, locator, text, cfg, { perKey = 42 } = {}) {
  await moveTo(stage, locator)
  await locator.click()
  await locator.pressSequentially(text, { delay: perKey * cfg.slow })
}

/** Wait for a condition; never throws. Returns true if it came true in time. */
async function soft(fn, timeoutMs) {
  try { await fn(timeoutMs); return true } catch { return false }
}

// ---- the app ----

/** Clear the demo (no recording). Retries while agent work is still finishing (the app answers 409). */
async function resetDemo(cfg) {
  for (let attempt = 1; attempt <= 8; attempt++) {
    const response = await fetch(`${cfg.app}/api/sim/scenarios/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => null)
    if (response && response.ok) { console.log("  demo reset"); return true }
    console.log(`  reset refused (${response ? response.status : "no answer"}), waiting 10 s (${attempt}/8)`)
    await sleep(10000)
  }
  console.error("Could not reset the demo. Is the app running at " + cfg.app + "?")
  return false
}

async function appIsUp(cfg) {
  const response = await fetch(`${cfg.app}/api/cases`).catch(() => null)
  if (!response || !response.ok) { console.error(`The app does not answer at ${cfg.app}. Start it first (see the README), or pass --app.`); return false }
  return true
}


/** The driver's thread: how many messages, how many are from Bahn, and the last of each. */
async function threadState(page) {
  return page.evaluate(() => {
    const section = document.querySelector('section[aria-label="Messages with Bahn"]')
    if (!section) return { count: 0, bahn: 0, last: "", lastBahn: "" }
    const text = (element) => element.innerText.replace(/\s+/g, " ").trim()
    const kids = [...section.children].filter((child) => !/threadEmpty|typing/.test(String(child.className)))
    const bahn = kids.filter((child) => !/mine/.test(String(child.className)))
    return { count: kids.length, bahn: bahn.length, last: kids.length ? text(kids[kids.length - 1]) : "", lastBahn: bahn.length ? text(bahn[bahn.length - 1]) : "" }
  })
}

/** Wait until Bahn has written something new on the phone and has stopped typing. Returns its text, or null on timeout. */
async function waitForBahnMessage(stage, countBefore, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await threadState(stage.page)
    if (state.bahn > countBefore) {
      let text = state.lastBahn
      for (let stable = 0; stable < 4 && Date.now() < deadline; ) {
        await sleep(700)
        const next = (await threadState(stage.page)).lastBahn
        if (next === text) stable++
        else { text = next; stable = 0 }
      }
      return text
    }
    await sleep(700)
  }
  return null
}

/** The scenario card on /demo whose heading starts with this text, for example "A." */
function scenarioCard(stage, titleStart) {
  return stage.page.locator("li", { has: stage.page.locator("h3", { hasText: new RegExp("^" + titleStart.replace(".", "\\.")) }) })
}

module.exports = { ROOT, loadPlaywright, parseArgs, config, sleep, Run, moveTo, click, typeSlow, soft, resetDemo, appIsUp, scenarioCard, threadState, waitForBahnMessage, fmt }
