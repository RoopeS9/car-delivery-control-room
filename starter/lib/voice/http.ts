// Shared helpers for the /api/voice routes. Errors go to the screen as plain
// sentences, never stack traces.

import { CallError } from "./call"
import { CallContextError } from "./context"

export function errorResponse(error: unknown): Response {
  if (error instanceof CallError || error instanceof CallContextError) {
    return Response.json({ error: error.message }, { status: error.status })
  }
  console.error("[voice]", error)
  return Response.json({ error: "Something went wrong on our side. Please try the call again." }, { status: 500 })
}

export function originOf(request: Request): string {
  return new URL(request.url).origin
}
