"use strict"
// R7: the map timelapse. The page is built by the separate timelapse branch (video/TIMELAPSE-BRIEF.md);
// this script records it once it exists. If the page is missing it says so and does nothing.
//   node r7-timelapse.cjs [--duration 15] [--theme dark|light] [--path "/timelapse?clean=1&duration=15"]

const lib = require("./lib.cjs")
const { parseArgs, config, Run, appIsUp, sleep } = lib

;(async () => {
  const args = parseArgs()
  const cfg = config(args)
  if (!(await appIsUp(cfg))) process.exit(1)
  const duration = Number(args.duration || 15)
  const route = String(args.path || `/timelapse?clean=1&duration=${duration}`)

  const probe = await fetch(cfg.app + route.split("?")[0]).catch(() => null)
  if (!probe || probe.status === 404) {
    console.error(`The timelapse page (${route}) is not in this build. It comes from the timelapse branch; merge it, rebuild, and run this again.`)
    process.exit(0)
  }

  const run = await new Run("timelapse", { ...cfg, theme: String(args.theme || "dark") }).launch()
  const map = await run.stage("map", { kind: "map", route })
  run.mark("timelapse page opened", route)
  await sleep((duration + 3) * 1000) // the page autostarts; add a moment to hold the calm last frame
  run.mark("timelapse finished")
  await run.finish()
})()
