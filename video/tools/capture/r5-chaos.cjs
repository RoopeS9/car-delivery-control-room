"use strict"
// R5: the chaos montage. The demo panel is hammered (clock jumps, scenarios) while the map behind it fills with badges.
//   demo   the demo panel
//   map    the live map, recorded at the same time (cut between the two)
//   node r5-chaos.cjs [--no-model]    --no-model clicks the clock only and starts no scenario (no credit spent)
// Do this on a freshly reset demo, after R1 to R4 are in the can (it starts other scenarios).

const lib = require("./lib.cjs")
const { parseArgs, config, Run, click, resetDemo, appIsUp, scenarioCard, sleep } = lib

;(async () => {
  const args = parseArgs()
  const cfg = config(args)
  if (!(await appIsUp(cfg))) process.exit(1)
  if (!args["no-reset"] && !(await resetDemo(cfg))) process.exit(1)

  const run = await new Run("chaos", { ...cfg, theme: String(args.theme || "dark") }).launch()
  const [demo, map] = await Promise.all([
    run.stage("demo", { route: "/demo" }),
    run.stage("map", { kind: "map", route: "/" }),
  ])
  run.mark("both windows open")
  await sleep(3500 * cfg.slow)

  const jumps = demo.page.getByRole("group", { name: /Jump the sim clock/ })
  const fast = { ...cfg, slow: cfg.slow * 0.35 } // the whole point is that this is quick
  const hit = async (name) => { await click(demo, jumps.getByRole("button", { name }), fast, { steps: 10 }); run.mark(`clicked ${name}`) }

  await hit("+5 min")
  if (!cfg.noModel) { await click(demo, scenarioCard(demo, "F.").getByRole("button", { name: /^Run/ }), fast, { steps: 10 }); run.mark("Run F clicked", "the driver goes silent") }
  await hit("+15 min")
  if (!cfg.noModel) { await click(demo, scenarioCard(demo, "G.").getByRole("button", { name: /^Run/ }), fast, { steps: 10 }); run.mark("Run G clicked", "a light that is usually not critical") }
  await hit("+60 min")
  await hit("+5 min")
  await hit("+15 min")
  await sleep(6000 * cfg.slow) // let the map react
  await run.finish()
})()
