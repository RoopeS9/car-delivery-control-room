// Agent settings. Effort comes from env vars so we can tune for latency
// without touching code (PLAN.md 4.2). The model is chosen in client.ts.

export const AGENT_ID = "road-agent"
export const AGENT_NAME = "Road Desk agent"

export type Effort = "low" | "medium" | "high" | "xhigh" | "max"

const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"]

function effortFrom(value: string | undefined, fallback: Effort): Effort {
  return EFFORTS.includes(value as Effort) ? (value as Effort) : fallback
}

/** Driver chat, voice turns and site chat: keep replies quick. */
export function fastEffort(): Effort {
  return effortFrom(process.env.AGENT_EFFORT_FAST, "low")
}

/** Case analysis, building decision cards, operator questions. */
export function deepEffort(): Effort {
  return effortFrom(process.env.AGENT_EFFORT_DEEP, "medium")
}

/** Hard cap on model calls in one turn, so a confused loop cannot run away. */
export const MAX_ITERATIONS = 12

export const MAX_TOKENS = 16000
