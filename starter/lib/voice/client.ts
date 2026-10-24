// Claude through OpenRouter for the live interviewer. Stream A has its own
// client in lib/agent/; this one stays small so voice does not depend on it.

import Anthropic from "@anthropic-ai/sdk"
import { openRouterKey } from "./config"

const holder = globalThis as unknown as { __voiceAnthropic?: Anthropic }

export function voiceClient(): Anthropic {
  holder.__voiceAnthropic ??= new Anthropic({
    baseURL: "https://openrouter.ai/api",
    apiKey: null,
    authToken: openRouterKey(),
    maxRetries: 1,
    timeout: 30_000,
  })
  return holder.__voiceAnthropic
}

// Dollars per million tokens (input, output). Haiku 5.5 and Sonnet 5.5 measured
// 24 Oct from OpenRouter's reported cost; Opus is a list-price guess. Estimate only.
const PRICES: [RegExp, number, number][] = [[/haiku/i, 1, 5], [/sonnet/i, 2, 10], [/opus/i, 5, 25]]

type Usage = { cost?: unknown; input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }

/**
 * OpenRouter adds `cost` (dollars) to the usage block of non-streamed
 * responses. Streamed responses omit it, so estimate from the token counts.
 */
export function usageCost(usage: unknown, model = ""): number {
  const value = usage as Usage | null | undefined
  if (typeof value?.cost === "number" && Number.isFinite(value.cost)) return value.cost
  const price = PRICES.find(([pattern]) => pattern.test(model))
  if (!value || !price) return 0
  const [, input, output] = price
  const tokensIn = (value.input_tokens ?? 0) + (value.cache_creation_input_tokens ?? 0) * 1.25 + (value.cache_read_input_tokens ?? 0) * 0.1
  return (tokensIn * input + (value.output_tokens ?? 0) * output) / 1_000_000
}

/** Haiku 5.5 thinks by default and accepts `disabled`; Sonnet and Opus 5.5 refuse it and take `effort` instead. */
export function reasoningParams(model: string, effort: "low" | "medium" | "high"): { thinking?: { type: "disabled" }; output_config?: { effort: "low" | "medium" | "high" } } {
  return /haiku/i.test(model) ? { thinking: { type: "disabled" } } : { output_config: { effort } }
}
