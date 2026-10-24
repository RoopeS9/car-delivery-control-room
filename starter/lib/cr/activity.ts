// Local-process lifecycle coordination. A reset must not delete records while
// a call, agent turn or deferred simulation task can still write into them.
// This is deliberately an in-memory guard for the single demo server.

type Activity = { active: Map<symbol, string>; resetting: boolean }
const holder = globalThis as unknown as { __crActivity?: Activity }
const state = () => (holder.__crActivity ??= { active: new Map(), resetting: false })

export class RuntimeBusyError extends Error {
  readonly status = 409
  constructor(message: string) { super(message); this.name = "RuntimeBusyError" }
}

export function isResetting(): boolean { return state().resetting }

/** Reserve before scheduling deferred work. Release once, in its finally. */
export function beginRuntimeWork(label: string): () => void {
  const current = state()
  if (current.resetting) throw new RuntimeBusyError("The demo is resetting. Try again in a moment.")
  const token = Symbol(label)
  current.active.set(token, label)
  return () => { current.active.delete(token) }
}

export async function withRuntimeWork<T>(label: string, work: () => Promise<T>): Promise<T> {
  const release = beginRuntimeWork(label)
  try { return await work() } finally { release() }
}

/** Checking for work and claiming reset are synchronous and therefore atomic
 * within this process: no new work may start until the reset releases it. */
export function beginRuntimeReset(): () => void {
  const current = state()
  if (current.resetting) throw new RuntimeBusyError("The demo is already resetting. Please wait.")
  if (current.active.size) {
    const labels = [...new Set(current.active.values())].join(", ")
    throw new RuntimeBusyError(`Wait for ${labels} to finish, and hang up any active driver call before resetting. Nothing was cleared.`)
  }
  current.resetting = true
  let finished = false
  return () => { if (!finished) { finished = true; current.resetting = false } }
}
