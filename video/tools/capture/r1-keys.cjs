"use strict"
// R1: scenario C, the routine keys question. The agent answers it from the pickup record and nobody is paged.
//   demo   the demo panel: Run on "C. Routine question, no person needed"
//   driver the driver's phone (Kasper Carvell): the question and the agent's answer
//   ops    the queue, then the order's page with the answer on its timeline
//   node r1-keys.cjs [--app ...] [--slow 1] [--no-reset]

const lib = require("./lib.cjs")
const { parseArgs, config, Run, click, soft, resetDemo, appIsUp, scenarioCard, threadState, waitForBahnMessage, sleep } = lib

;(async () => {
  const args = parseArgs()
  const cfg = config(args)
  if (!(await appIsUp(cfg))) process.exit(1)
  if (!args["no-reset"] && !(await resetDemo(cfg))) process.exit(1)

  const run = await new Run("keys", cfg).launch()
  const [demo, driver, ops] = await Promise.all([
    run.stage("demo", { route: "/demo" }),
    run.stage("driver", { kind: "phone", route: "/driver?driver=drv-130&job=CD-420145" }),
    run.stage("ops", { route: "/queue" }),
  ])
  run.mark("all three windows open")
  await sleep(3000 * cfg.slow)

  const before = await threadState(driver.page)
  await click(demo, scenarioCard(demo, "C.").getByRole("button", { name: /^Run/ }), cfg)
  run.mark("Run C clicked", "demo panel")

  const driverFlow = async () => {
    const answer = await waitForBahnMessage(driver, before.bahn, cfg.maxWait)
    run.mark(answer ? "the agent answers the keys question" : "TIMEOUT: no answer on the phone", answer || "")
    await sleep(6000 * cfg.slow)
  }
  const opsFlow = async () => {
    await sleep(5000 * cfg.slow)
    const row = ops.page.locator("a.q-row", { hasText: "CD-420145" })
    if (await soft((t) => row.first().waitFor({ state: "visible", timeout: t }), 30000)) {
      run.mark("CD-420145 shows on the queue")
      await sleep(3500 * cfg.slow)
      await click(ops, row.first(), cfg)
      run.mark("operator opens the order")
    } else {
      run.mark("no queue row (the agent handled it without opening a card); opening the order")
      await ops.page.goto(`${cfg.app}/orders/ord-00145`)
    }
    await sleep(9000 * cfg.slow)
    await ops.page.mouse.wheel(0, 500)
    await sleep(5000 * cfg.slow)
  }
  await Promise.all([driverFlow(), opsFlow()].map((p) => p.catch((error) => run.mark("ERROR", error.message))))
  await run.finish()
})()
