import "dotenv/config"
import { defineConfig } from "drizzle-kit"

export default defineConfig({
  schema: ["./lib/schema.ts", "./lib/cr/schema.ts"],
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://controlroom:controlroom@localhost:5438/controlroom" },
})
