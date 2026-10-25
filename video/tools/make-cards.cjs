// Renders the caption overlays for the video as transparent 1920x1080 PNGs.
// Run from the repository root:  NODE_PATH=$(npm root -g) node video/tools/make-cards.cjs
// Needs Playwright (pre-installed in the cloud sandbox) and access to Google Fonts.
const { chromium } = require("playwright")
const path = require("path")
const fs = require("fs")

const out = path.join(__dirname, "..", "assets", "cards")
fs.mkdirSync(out, { recursive: true })

const INK = "#12110e"
const CREAM = "#fffef7"
const ORANGE = "#b04617"
const ORANGE_LIGHT = "#e8895a"

const base = `
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Unbounded:wght@500;700&family=Poppins:wght@400;600&display=swap">
<style>
  html, body { margin: 0; width: 1920px; height: 1080px; background: transparent; font-family: 'Poppins', Arial, sans-serif; }
  .stage { position: relative; width: 1920px; height: 1080px; }
  .display { font-family: 'Unbounded', Verdana, sans-serif; font-weight: 700; }
</style>`

// Each card: file name, and the HTML placed on the transparent stage.
const cards = {
  "calm-shift": `
    <div style="position:absolute; left:128px; bottom:128px; background:${CREAM}; color:${INK}; border-radius:20px; padding:36px 52px; box-shadow:0 8px 40px rgba(0,0,0,.25)">
      <div style="font-size:26px; font-weight:600; letter-spacing:3px; text-transform:uppercase; color:${ORANGE}">Road Desk · control room</div>
      <div class="display" style="font-size:76px; line-height:1.15; margin-top:10px">09:00. A calm shift.</div>
    </div>`,
  "sim-keys": simulator("“Where are the keys?”"),
  "sim-warning": simulator("Warning light."),
  "sim-no-shame": simulator("(it has no shame)", { label: "The simulator" }),
  "footnote-estimates": `
    <div style="position:absolute; left:128px; right:128px; bottom:56px; background:rgba(255,254,247,.94); color:${INK}; border-radius:14px; padding:20px 32px; font-size:30px; line-height:1.35; text-align:center">
      Handling times are our estimates, not measured at Bahn. AI cost is measured, on synthetic data.
    </div>`,
  "tag-simulated": `
    <div style="position:absolute; right:56px; bottom:48px; background:rgba(18,17,14,.82); color:${CREAM}; border-radius:12px; padding:14px 26px; font-size:30px; font-weight:600">
      Illustrative timelapse of simulated events
    </div>`,
  "tag-simulated-small": `
    <div style="position:absolute; left:56px; top:48px; background:rgba(18,17,14,.82); color:${CREAM}; border-radius:12px; padding:12px 24px; font-size:28px; font-weight:600; letter-spacing:2px; text-transform:uppercase">
      Simulated
    </div>`,
  "needs-you": `
    <div style="position:absolute; left:128px; top:96px; background:${ORANGE}; color:${CREAM}; border-radius:999px; padding:18px 44px; font-size:44px; font-weight:600; box-shadow:0 8px 40px rgba(0,0,0,.25)">
      1 needs you
    </div>`,
  "title-road-desk": `
    <div style="position:absolute; left:0; right:0; top:0; bottom:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:18px">
      <div class="display" style="font-size:150px; color:${CREAM}; text-shadow:0 6px 40px rgba(0,0,0,.45)">Road Desk</div>
      <div style="font-size:42px; color:${CREAM}; text-shadow:0 4px 24px rgba(0,0,0,.5)">Agents do the legwork. People make the calls.</div>
    </div>`,
}

function simulator(quote, opts = {}) {
  const label = opts.label || "The simulator"
  return `
    <div style="position:absolute; left:50%; bottom:150px; transform:translateX(-50%) rotate(-2deg); background:${INK}; color:${CREAM}; border-radius:18px; padding:30px 56px 34px; box-shadow:0 10px 44px rgba(0,0,0,.35); text-align:center; border:4px solid ${ORANGE_LIGHT}">
      <div style="font-size:28px; font-weight:600; letter-spacing:4px; text-transform:uppercase; color:${ORANGE_LIGHT}">${label}</div>
      <div class="display" style="font-size:72px; line-height:1.15; margin-top:8px">${quote}</div>
    </div>`
}

// The hazard triangle is a square sprite, so it is rendered at its own size.
const hazard = `
  <div style="width:512px; height:512px; display:flex; align-items:center; justify-content:center">
    <svg width="460" height="420" viewBox="0 0 460 420">
      <polygon points="230,30 430,380 30,380" fill="none" stroke="#f2a33a" stroke-width="44" stroke-linejoin="round"/>
      <polygon points="230,110 350,330 110,330" fill="none" stroke="#f2a33a" stroke-width="22" stroke-linejoin="round"/>
    </svg>
  </div>`

;(async () => {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
  for (const [name, html] of Object.entries(cards)) {
    await page.setContent(`${base}<div class="stage">${html}</div>`, { waitUntil: "networkidle" })
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: path.join(out, `${name}.png`), omitBackground: true })
    console.log("wrote", name)
  }
  const small = await browser.newPage({ viewport: { width: 512, height: 512 } })
  await small.setContent(`${base}<style>.stage{width:512px;height:512px}</style><div class="stage">${hazard}</div>`, { waitUntil: "networkidle" })
  await small.screenshot({ path: path.join(out, "hazard-triangle.png"), omitBackground: true })
  console.log("wrote hazard-triangle")
  await browser.close()
})()
