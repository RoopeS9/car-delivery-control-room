// Runs once when the server starts. The simulated clock restarts at SIM_NOW on every process start, while the
// stored events and telemetry may already be hours past that (a rebuild mid-demo, a sandbox restart). A clock
// behind its own records makes every "new message since" check wrong, so the clock is moved up to the newest
// record first. The deploy script does the same from outside; this covers every other start.
export async function register() {
  // The runtime check is what the bundler reads: the Node.js module stays out of the edge build.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNode } = await import("./instrumentation-node")
    await registerNode()
  }
}
