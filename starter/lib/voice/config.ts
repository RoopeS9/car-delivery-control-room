// Voice settings, all from the environment (see starter/.env.example).

export const voiceConfig = {
  interviewModel: () => process.env.VOICE_INTERVIEW_MODEL || "anthropic/claude-sonnet-5.5",
  interviewEffort: () => (process.env.VOICE_INTERVIEW_EFFORT || "low") as "low" | "medium" | "high",
  sttModel: () => process.env.VOICE_STT_MODEL || "openai/gpt-4o-transcribe",
  liveStt: (): "browser" | "server" => (process.env.VOICE_LIVE_STT === "server" ? "server" : "browser"),
  ttsModel: () => process.env.VOICE_TTS_MODEL || "elevenlabs/eleven-flash-v2.5",
  agentVoice: () => process.env.VOICE_TTS_VOICE_AGENT || "21m00Tcm4TlvDq8ikWAM",
  driverVoice: () => process.env.VOICE_TTS_VOICE_DRIVER || null,
  /** "openrouter" (default) or "browser": the browser speaks and only live recognition is used. */
  provider: () => (process.env.VOICE_PROVIDER === "browser" || !process.env.OPENROUTER_API_KEY ? "browser" : "openrouter"),
  /** Where the agent's call trigger lives once stream A ships it. */
  agentTriggerPath: () => process.env.VOICE_AGENT_TRIGGER_PATH || "/api/agent/call",
  cacheDir: () => process.env.VOICE_CACHE_DIR || `${process.cwd()}/.voice-cache`,
}

/** Measured 24 Oct: ElevenLabs Flash via OpenRouter cost $0.00464 for 116 characters. */
export const TTS_DOLLARS_PER_CHAR = 0.00464 / 116

export function openRouterKey(): string {
  const key = process.env.OPENROUTER_API_KEY
  if (!key) throw new Error("OPENROUTER_API_KEY is not set. Add it to starter/.env.")
  return key
}
