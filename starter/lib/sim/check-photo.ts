// Checks that Claude can read the drawn dashboard picture (PLAN.md 4.5: "It
// must be readable by Claude's vision; test it"). Sends the image to the
// agent's model and checks the answer names the warning and the message.
//
// Run from starter/: npx tsx lib/sim/check-photo.ts   (needs OPENROUTER_API_KEY)

import "dotenv/config"
import { readFileSync } from "node:fs"
import path from "node:path"
import { agentModel, llm } from "@/lib/agent/client"

async function main() {
  const client = llm()
  if (!client) throw new Error("Set OPENROUTER_API_KEY in starter/.env first.")
  const image = readFileSync(path.join(process.cwd(), "public", "sim", "dashboard-misfire.jpg")).toString("base64")
  const response = await client.messages.create({
    model: agentModel(),
    max_tokens: 2000,
    output_config: { effort: "low" },
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
        { type: "text", text: "A driver sent this photo of the dashboard. List the warning lights that are lit, any text message shown, and the speed shown. Plain text, no guessing." },
      ],
    }],
  })
  if (response.stop_reason === "refusal") throw new Error("The model declined to read the picture.")
  const text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")
  console.log(text)
  const lower = text.toLowerCase()
  const checks = [
    ["engine or check-engine light", /engine/.test(lower)],
    ["the 'reduced power' message", /reduced power/.test(lower)],
    ["speed 0", /\b0\s*(km\/h|kmh)|stationary|not moving|zero/.test(lower)],
  ] as const
  for (const [label, ok] of checks) console.log(`${ok ? "ok  " : "MISS"} ${label}`)
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
