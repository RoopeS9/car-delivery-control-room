// Small helpers shared by the Road Desk API routes: server-sent events for
// streamed replies, plain JSON errors, and running follow-up turns after the
// response has gone out.

import { after } from "next/server"
import { beginRuntimeWork, RuntimeBusyError } from "@/lib/cr/activity"
import { EventScopeError } from "@/lib/cr/queries"
import { ApprovalRequiredError, DecisionError } from "./gate"
import { ChannelError, runFollowUps } from "./triggers"
import type { FollowUp } from "./tools"

type Send = (event: "text_delta" | "done" | "error", data: unknown) => void

/** A text/event-stream response. `work` sends events; errors become an `error` event. */
export function sseResponse(work: (send: Send) => Promise<void>): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send: Send = (event, data) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      try {
        await work(send)
      } catch (error) {
        send("error", { message: error instanceof Error ? error.message : "Something went wrong." })
      } finally {
        controller.close()
      }
    },
  })
  return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } })
}

/** Map our known errors to HTTP statuses with a plain message. */
export function errorResponse(error: unknown): Response {
  if (error instanceof RuntimeBusyError || error instanceof EventScopeError) return Response.json({ error: error.message }, { status: error.status })
  if (error instanceof ChannelError || error instanceof DecisionError) return Response.json({ error: error.message }, { status: error.status })
  if (error instanceof ApprovalRequiredError) return Response.json({ error: error.message }, { status: 403 })
  console.error("Road Desk API error", error)
  return Response.json({ error: "Something went wrong on our side." }, { status: 500 })
}

/** Follow-up turns run after the response; their results land in the case timeline. */
export function continueInBackground(followUps: FollowUp[]): void {
  if (followUps.length === 0) return
  const release = beginRuntimeWork("queued agent follow-ups")
  try {
    after(async () => {
      try {
        await runFollowUps(followUps)
      } catch (error) {
        console.error("Road Desk follow-up failed", error)
      } finally {
        release()
      }
    })
  } catch (error) {
    release()
    throw error
  }
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T
  } catch {
    throw new ChannelError(400, "The request body must be JSON.")
  }
}
