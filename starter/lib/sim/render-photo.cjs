// Renders the drawn dashboard SVGs in public/sim/ to PNG so Claude's vision can
// read them (it does not take SVG). Uses the Playwright Chromium that comes
// with the dev machine:
//
//   NODE_PATH=$(npm root -g) node lib/sim/render-photo.cjs
const { chromium } = require("playwright")
const { readFileSync } = require("node:fs")
const { join } = require("node:path")

const PHOTOS = ["dashboard-misfire"]

;(async () => {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  for (const name of PHOTOS) {
    const svg = readFileSync(join(__dirname, "..", "..", "public", "sim", `${name}.svg`), "utf8")
    await page.setContent(`<!doctype html><html><body style="margin:0;background:#000">${svg}</body></html>`)
    await page.screenshot({ path: join(__dirname, "..", "..", "public", "sim", `${name}.jpg`), type: "jpeg", quality: 86 })
    console.log(`Rendered public/sim/${name}.jpg`)
  }
  await browser.close()
})()
