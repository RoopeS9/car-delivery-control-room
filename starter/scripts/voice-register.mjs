// Lets `tsx` scripts and the test runner import server modules. `lib/db.ts` imports "server-only",
// which Next.js aliases at build time but which is not an installed package. For scripts it
// resolves to an empty CommonJS file: a data: URL breaks when tsx compiles a module to CommonJS,
// because the CJS loader reads the URL as a file path.
// Usage: node --import ./scripts/voice-register.mjs --import tsx --test ...
import { registerHooks } from "node:module"

const EMPTY = new URL("./server-only-stub.cjs", import.meta.url).href

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: EMPTY, shortCircuit: true }
    return next(specifier, context)
  },
})
