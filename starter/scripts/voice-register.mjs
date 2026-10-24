// Lets `tsx` scripts import server modules. `lib/db.ts` imports "server-only",
// which Next.js aliases at build time but which is not an installed package.
// For scripts it resolves to an empty module.
// Usage: tsx --import ./scripts/voice-register.mjs scripts/voice-test.ts
import { registerHooks } from "node:module"

const EMPTY = "voice-shim:server-only"

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: EMPTY, format: "commonjs", shortCircuit: true }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url === EMPTY) return { format: "commonjs", source: "", shortCircuit: true }
    return next(url, context)
  },
})
