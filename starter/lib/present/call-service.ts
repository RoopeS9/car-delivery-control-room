// The robo-call and dossier service (road-dossier), a separate local process on
// loopback. Read on the server only. Every call here tolerates the service
// being down: the map and the dossier still render without it.

import type { CallRecord, CallScenario, ServiceDossier } from "./call-types"
import type { Strength } from "./dossier-types"

export type { CallRecord, CallScenario, ServiceDossier }

const BASE = process.env.CALL_SERVICE_URL ?? "http://127.0.0.1:8799"

async function get<T>(path: string, timeoutMs = 2500): Promise<T | null> {
  try {
    const response = await fetch(`${BASE}${path}`, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return null
    return (await response.json()) as T
  } catch {
    return null
  }
}

export function callScenarios(): Promise<CallScenario[] | null> {
  return get<CallScenario[]>("/scenarios")
}

export async function callsFor(reference: string): Promise<CallRecord[]> {
  return (await get<CallRecord[]>(`/calls?ref=${encodeURIComponent(reference)}`, 1500)) ?? []
}

export function serviceDossier(reference: string): Promise<ServiceDossier | null> {
  return get<ServiceDossier>(`/dossier/${encodeURIComponent(reference)}`, 1500)
}

/** Runs one simulated call. It can take a while: the service plays both sides. */
export async function runCall(personaId: string): Promise<{ ok: true; call: CallRecord } | { ok: false; error: string }> {
  try {
    const response = await fetch(`${BASE}/calls/run`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ personaId }),
      cache: "no-store", signal: AbortSignal.timeout(180_000),
    })
    const text = await response.text()
    if (!response.ok) return { ok: false, error: text.slice(0, 300) || `The call service answered ${response.status}.` }
    return { ok: true, call: JSON.parse(text) as CallRecord }
  } catch (error) {
    return { ok: false, error: error instanceof Error && error.name === "TimeoutError" ? "The call took too long and was abandoned." : "The call service is not reachable." }
  }
}

/** The dossier's evidence words, in the map's vocabulary. */
export const SERVICE_STRENGTH: Record<string, Strength> = {
  REFERENCE: "reference", REQUEST: "request", PLAN: "planned", QUOTE: "quote", BOOKING: "booked", COMMITMENT: "commitment",
  CLAIM: "claim", OBSERVATION: "observation", VERIFIED: "verified", REJECTED: "rejected", DECISION: "decision", SIGNAL: "signal",
  PROPOSAL: "proposal", RECORD: "recorded",
}

/** Strength per `collection:id` from the service's typed dossier. */
export function strengthIndex(dossier: ServiceDossier | null): Map<string, Strength> {
  const index = new Map<string, Strength>()
  for (const items of Object.values(dossier?.classes ?? {})) {
    for (const item of items) {
      const word = SERVICE_STRENGTH[item.strength]
      if (word) index.set(`${item.collection}:${item.id}`, word)
    }
  }
  return index
}

/** The brief a call would be given: who is called and what may be asked. */
export function callBrief(reference: string, purpose: string): Promise<CallRecord["brief"]> {
  return get<CallRecord["brief"]>(`/brief/${encodeURIComponent(reference)}/${encodeURIComponent(purpose)}`, 1500)
}
