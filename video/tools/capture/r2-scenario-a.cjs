"use strict"
// R2, R3 and R4 in one run: scenario A, the fresh warning light, from three windows at once.
//   demo   the demo panel: Reset is done beforehand, then Run on "A. Fresh warning light"
//   driver Leo's phone: the stop line arrives, he answers, the agent replies, later the update
//   ops    the operator: the queue, the Bentley's order page, the decision card, "I'll handle it", the log line
//
// Uses the real agent. It costs about $0.20 on a cheap model. Run it once; film the actors afterwards.
//   node r2-scenario-a.cjs [--app http://localhost:3000] [--slow 1] [--no-reset] [--max-wait 240]

const lib = require("./lib.cjs")
const { parseArgs, config, Run, click, typeSlow, soft, resetDemo, appIsUp, scenarioCard, threadState, waitForBahnMessage, sleep } = lib

const DRIVER_REPLY = "I'm safe, parked at the service area by the fuel station, engine off. The orange light was blinking and the car shook."
const OUTCOME = "Called the owner: their own roadside help arrives at 11:00 UTC and takes the car to the Bentley workshop nearby."

;(async () => {
  const args = parseArgs()
  const cfg = config(args)
  if (!(await appIsUp(cfg))) process.exit(1)
  if (!args["no-reset"] && !(await resetDemo(cfg))) process.exit(1)

  const run = await new Run("scenario-a", cfg).launch()
  const [demo, driver, ops] = await Promise.all([
    run.stage("demo", { route: "/demo" }),
    run.stage("driver", { kind: "phone", route: "/driver?driver=drv-042&job=CD-420584" }),
    run.stage("ops", { route: "/queue" }),
  ])
  run.mark("all three windows open")
  await sleep(3500 * cfg.slow)

  let outcomeLogged
  const outcomeDone = new Promise((resolve) => { outcomeLogged = resolve })

  // ---- the demo panel: start the scenario ----
  const demoFlow = async () => {
    const run_ = scenarioCard(demo, "A.").getByRole("button", { name: /^Run/ })
    await click(demo, run_, cfg)
    run.mark("Run A clicked", "demo panel")
    await sleep(6000 * cfg.slow)
    await demo.page.mouse.move(1500, 1000, { steps: 30 }) // park the pointer out of the way
  }

  // ---- Leo's phone ----
  const driverFlow = async () => {
    const before = await threadState(driver.page)
    run.mark("waiting for the stop line on Leo's phone")
    const first = await waitForBahnMessage(driver, before.bahn, cfg.maxWait)
    if (first === null) { run.mark("TIMEOUT: nothing reached the driver", "is the agent running?"); outcomeLogged(); return }
    run.mark("first message to Leo", first)
    await sleep(5000 * cfg.slow) // time to read it on screen

    const afterFirst = await threadState(driver.page)
    await typeSlow(driver, driver.page.locator('input[placeholder="Message Bahn"]'), DRIVER_REPLY, cfg, { perKey: 38 })
    await sleep(600 * cfg.slow)
    await click(driver, driver.page.getByRole("button", { name: "Send", exact: true }), cfg)
    run.mark("Leo replies", DRIVER_REPLY)

    const answer = await waitForBahnMessage(driver, afterFirst.bahn, cfg.maxWait)
    run.mark(answer ? "agent answers Leo" : "TIMEOUT: no answer to Leo", answer || "")
    await sleep(3000 * cfg.slow)

    // The agent may ask for a dashboard photo; the demo has a button for it.
    const photo = driver.page.getByRole("button", { name: "Send demo picture" })
    if (await photo.isVisible().catch(() => false)) {
      const beforePhoto = await threadState(driver.page)
      await click(driver, photo, cfg)
      run.mark("Leo sends the demo dashboard picture")
      const afterPhoto = await waitForBahnMessage(driver, beforePhoto.bahn, cfg.maxWait)
      run.mark("agent answers the photo", afterPhoto || "")
      await sleep(3000 * cfg.slow)
    }

    // Wait for the operator to log the outcome, then the update to Leo.
    await outcomeDone
    const beforeUpdate = await threadState(driver.page)
    const update = await waitForBahnMessage(driver, beforeUpdate.bahn, cfg.maxWait)
    run.mark(update ? "the update reaches Leo" : "TIMEOUT: no update to Leo", update || "")
    await sleep(5000 * cfg.slow)
  }

  // ---- the operator ----
  const opsFlow = async () => {
    await sleep(3000 * cfg.slow)
    // The Bentley's row on the queue. It appears when the agent opens the case.
    const row = ops.page.locator("a.q-row", { hasText: "CD-420584" })
    const sawRow = await soft((t) => row.first().waitFor({ state: "visible", timeout: t }), cfg.maxWait)
    if (sawRow) {
      run.mark("the Bentley is on the queue")
      await sleep(4000 * cfg.slow)
      await click(ops, row.first(), cfg)
    } else {
      run.mark("no queue row for the Bentley, opening the order directly")
      await ops.page.goto(`${cfg.app}/orders/ord-00584#case`)
    }
    const cardUp = await soft((t) => ops.page.locator("article.dcard").first().waitFor({ state: "visible", timeout: t }), cfg.maxWait)
    if (!cardUp) { run.mark("TIMEOUT: no decision card appeared"); outcomeLogged(); return }
    const card = ops.page.locator("article.dcard").first()
    await card.scrollIntoViewIfNeeded()
    run.mark("the decision card appears", (await card.locator("h2").first().innerText().catch(() => "")))
    await sleep(6000 * cfg.slow)

    // Open "What the agent found" so the facts and their source chips are on screen.
    const summary = card.locator("details.dcard-details > summary")
    if (await summary.count()) {
      await click(ops, summary.first(), cfg)
      run.mark("card details opened", "facts and source chips")
      await sleep(7000 * cfg.slow)
      await ops.page.mouse.wheel(0, 260)
      await sleep(3500 * cfg.slow)
    }

    // Choose "I'll handle it".
    const handle = card.getByRole("button", { name: /I.ll handle it/ })
    if (!(await handle.count())) { run.mark("no 'I'll handle it' button on this card; stopping the operator here"); outcomeLogged(); return }
    await click(ops, handle.first(), cfg)
    run.mark("operator clicks I'll handle it")

    // Log what happened.
    const input = ops.page.locator(".outcome input").first()
    const logUp = await soft((t) => input.waitFor({ state: "visible", timeout: t }), 20000)
    if (!logUp) { run.mark("the log form did not appear"); outcomeLogged(); return }
    await sleep(1200 * cfg.slow)
    await typeSlow(ops, input, OUTCOME, cfg, { perKey: 30 })
    await sleep(900 * cfg.slow)
    await click(ops, ops.page.getByRole("button", { name: /Save and hand back to the agent/ }), cfg)
    run.mark("outcome logged", OUTCOME)
    outcomeLogged()
    await sleep(14000 * cfg.slow) // let the timeline fill with the agent's follow-up
    await ops.page.mouse.move(1800, 1100, { steps: 20 })
  }

  await Promise.all([demoFlow(), driverFlow(), opsFlow()].map((p) => p.catch((error) => { run.mark("ERROR", error.message); outcomeLogged() })))
  await sleep(2000)
  await run.finish()
})()
