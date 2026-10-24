// Lets `tsx` scripts and the test runner import server modules. `lib/db.ts` imports "server-only",
// which Next.js aliases at build time but which is not an installed package. For scripts it
// resolves to an empty module (a data: URL, which Node loads without a load hook; older Node
// versions rejected a load hook returning an empty source).
// Usage: node --import ./scripts/voice-register.mjs --import tsx --test ...
import { registerHooks } from "node:module"

const EMPTY = "data:text/javascript,export default {}"

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: EMPTY, shortCircuit: true }
    return next(specifier, context)
  },
})
