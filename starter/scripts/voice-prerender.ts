// Render the fixed call phrases (safety templates, fillers, next steps,
// goodbyes, the driver-initiated opening and the scenario openings) into the
// speech cache, so they play without waiting. Each one is screened first.
//   npm run voice:prerender

import "dotenv/config"
import { fixedPhrases, openingLine } from "@/lib/voice/interview/phrases"
import { screenDriverUtterance } from "@/lib/voice/screen"
import { speak } from "@/lib/voice/tts-cache"
import { TTS_DOLLARS_PER_CHAR } from "@/lib/voice/config"

const SCENARIO_OPENINGS = [
  openingLine({ direction: "AGENT_INITIATED", firstName: "Leo", telemetryFault: true, vehicleLabel: "Bentley Continental GT" }),
]

async function main(): Promise<void> {
  const lines = [...new Set([...fixedPhrases(), ...SCENARIO_OPENINGS])]
  let chars = 0
  let screenCost = 0
  for (const text of lines) {
    const screen = await screenDriverUtterance(text)
    screenCost += screen.cost
    if (!screen.allowed) {
      console.log(`  BLOCKED by the screen (${screen.category}): ${text}`)
      continue
    }
    const started = Date.now()
    const result = await speak(text)
    const ms = Date.now() - started
    if (ms > 150) chars += text.length
    console.log(`  ${result.audio ? `${String(result.audio.length).padStart(6)} bytes` : "   no audio"}  ${ms > 150 ? "rendered" : "cached  "}  ${text}`)
  }
  console.log(`\n${lines.length} phrases. Estimated spend: speech $${(chars * TTS_DOLLARS_PER_CHAR).toFixed(4)}, screen $${screenCost.toFixed(4)}.`)
  process.exit(0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
