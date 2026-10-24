// One interviewer reply: stream the spoken text (sentence by sentence) and
// collect the strict `record_call_state` tool call that follows it. No tool
// loop in the hot path. Forced tool_choice is not supported through
// OpenRouter, so the tool is `auto` plus an instruction, with fallbacks.

import type Anthropic from "@anthropic-ai/sdk"
import { reasoningParams, usageCost, voiceClient } from "../client"
import { voiceConfig } from "../config"
import { SentenceSplitter } from "../sentences"
import { RECORD_TOOL, type RecordInput } from "./prompt"

export type EngineInput = {
  system: Anthropic.TextBlockParam[]
  messages: Anthropic.MessageParam[]
  model?: string
  onSentence: (sentence: string) => void
}

export type EngineResult = { text: string; record: RecordInput | null; cost: number; model: string; ms: number; firstTextMs: number | null }

export async function runInterviewer(input: EngineInput): Promise<EngineResult> {
  const model = input.model ?? voiceConfig.interviewModel()
  const started = Date.now()
  let firstTextMs: number | null = null
  const splitter = new SentenceSplitter()
  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: 2000,
    system: input.system,
    messages: input.messages,
    tools: [RECORD_TOOL],
    tool_choice: { type: "auto" },
    ...reasoningParams(model, voiceConfig.interviewEffort()),
  }
  const stream = voiceClient().messages.stream(params)
  stream.on("text", (delta) => {
    firstTextMs ??= Date.now() - started
    for (const sentence of splitter.push(delta)) input.onSentence(sentence)
  })
  const message = await stream.finalMessage()
  for (const sentence of splitter.flush()) input.onSentence(sentence)
  if (process.env.VOICE_DEBUG) {
    console.log("[voice:debug]", message.stop_reason, JSON.stringify(message.content).slice(0, 1500), JSON.stringify(message.usage))
  }
  let cost = usageCost(message.usage, model)
  const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join(" ").trim()
  let toolUse = message.content.find((block): block is Anthropic.ToolUseBlock => block.type === "tool_use")

  // A reply with a record but no text is left to the caller: it knows the
  // interview state and asks the next item or does the read-back itself.
  // (In a 24 Oct trace the reply stayed empty even after a "now say your reply" follow-up.)
  if (text && !toolUse) {
    // It spoke but did not record: ask for the record alone (the driver already hears the reply).
    const follow = await voiceClient().messages.create({
      ...params,
      messages: [...input.messages, { role: "assistant", content: text },
        { role: "user", content: "(System) You did not call record_call_state. Call it now for the reply you just gave. Do not write any text." }],
    })
    cost += usageCost(follow.usage, model)
    toolUse = follow.content.find((block): block is Anthropic.ToolUseBlock => block.type === "tool_use")
  }
  return { text, record: (toolUse?.input as RecordInput | undefined) ?? null, cost, model, ms: Date.now() - started, firstTextMs }
}
