// Loads the service's .env for a command-line run, the way systemd reads it for the service: KEY=value lines, an
// optional export prefix, quotes stripped, Windows line ends ignored, and nothing already in the environment replaced.
import { existsSync, readFileSync } from "node:fs"

export function loadEnv(root: URL): void {
  const file = new URL(".env", root)
  if (!existsSync(file)) return
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.replace(/\r$/, "").trim()
    if (!line || line.startsWith("#")) continue
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    let value = m[2]!.trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (!process.env[m[1]!]) process.env[m[1]!] = value
  }
}
