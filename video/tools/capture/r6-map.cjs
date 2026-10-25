"use strict"
// R6: a slow, steady shot of the live map in the dark theme: hold, open "show all", a gentle pan, a slow zoom, hold.
//   node r6-map.cjs [--theme dark|light] [--slow 1]
// Needs internet for the map tiles. Run it on the demo as it stands; it changes nothing.

const lib = require("./lib.cjs")
const { parseArgs, config, Run, soft, appIsUp, sleep } = lib

;(async () => {
  const args = parseArgs()
  const cfg = config(args)
  if (!(await appIsUp(cfg))) process.exit(1)

  const run = await new Run("map", { ...cfg, theme: String(args.theme || "dark") }).launch()
  const map = await run.stage("map", { kind: "map", route: "/" })
  await soft((t) => map.page.locator(".leaflet-container").first().waitFor({ state: "visible", timeout: t }), 20000)
  await sleep(4000) // let the tiles and the markers settle before the shot starts
  run.mark("map ready, hold")
  await sleep(3500 * cfg.slow)

  const showAll = map.page.getByText(/Show all \d+/).first()
  if (await showAll.isVisible().catch(() => false)) {
    await lib.click(map, showAll, cfg)
    run.mark("opened the list of orders that need a person")
    await sleep(4000 * cfg.slow)
    await showAll.click({ timeout: 3000 }).catch(() => {}) // close it again if it is still there; never wait long for it
  }

  // A gentle drag to the left, then back a little, then a slow zoom in.
  const size = map.size
  const cx = size.width * 0.55, cy = size.height * 0.5
  await map.page.mouse.move(cx, cy, { steps: 20 })
  await map.page.mouse.down()
  await map.page.mouse.move(cx - 260, cy + 40, { steps: Math.round(90 * cfg.slow) })
  await map.page.mouse.up()
  run.mark("pan")
  await sleep(1500 * cfg.slow)
  for (let i = 0; i < 3; i++) { await map.page.mouse.wheel(0, -120); await sleep(900 * cfg.slow) }
  run.mark("zoom in")
  await sleep(4000 * cfg.slow)
  await run.finish()
})()
