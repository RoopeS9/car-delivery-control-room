// The one place that knows how we reach Claude: through OpenRouter's
// Anthropic-compatible endpoint with the official Anthropic SDK (PLAN.md
// 4.2). Everything else asks this module for a client and a model name.

import Anthropic from "@anthropic-ai/sdk"

const holder = globalThis as unknown as { __roadDeskLlm?: Anthropic }

/** True when an OpenRouter key is configured. Without it the agent runs in stub mode. */
export function hasLlm(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY)
}

/** The shared client, or null without a key. */
export function llm(): Anthropic | null {
  const key = process.env.OPENROUTER_API_KEY
  if (!key) return null
  if (!holder.__roadDeskLlm) {
    holder.__roadDeskLlm = new Anthropic({
      baseURL: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api",
      apiKey: null,
      authToken: key,
      maxRetries: 2,
    })
  }
  return holder.__roadDeskLlm
}

/** The model the Road Desk agent uses (OpenRouter name). */
export function agentModel(): string {
  return process.env.AGENT_MODEL || "anthropic/claude-opus-5.5"
}

/** The model the simulated driver uses (OpenRouter name). */
export function simDriverModel(): string {
  return process.env.SIM_DRIVER_MODEL || "anthropic/claude-haiku-5.5"
}

/** OpenRouter adds the dollar cost of a call to `usage`. */
export function usageCost(usage: unknown): number {
  const cost = (usage as { cost?: unknown } | null)?.cost
  return typeof cost === "number" && Number.isFinite(cost) ? cost : 0
}
