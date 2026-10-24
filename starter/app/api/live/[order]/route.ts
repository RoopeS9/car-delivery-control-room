import { NextResponse } from "next/server"
import { simNow } from "@/lib/cr/clock"
import { casesForOrder, listEvents, resolveOrder, telemetrySince } from "@/lib/cr/queries"
import { appMessagesFor } from "@/lib/present/helpdesk"
import { carReadings } from "@/lib/sim/status"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const DAY_MS = 24 * 3600_000

/**
 * What the world has done to one order since the dataset snapshot, for the dossier service's live pull: the
 * simulated clock, the car's phone state, telemetry of the last day, every timeline event and the agent's cases.
 * Plain records, no interpretation: the dossier types and grades them on its side.
 */
export async function GET(_request: Request, context: { params: Promise<{ order: string }> }) {
  const { order: ref } = await context.params
  const order = await resolveOrder(ref)
  if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 })
  const now = simNow()
  const [readings, telemetry, events, cases, helpdesk] = await Promise.all([
    carReadings(order.id).catch(() => null),
    telemetrySince(order.id, new Date(now.getTime() - DAY_MS)),
    listEvents({ orderId: order.id }),
    casesForOrder(order.id),
    appMessagesFor(order.id).catch(() => []),
  ])
  const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null)
  return NextResponse.json({
    now: now.toISOString(),
    order,
    car: readings ? { phone: readings.phone, phoneNote: readings.phoneNote, driverId: readings.driverId, lastGpsAt: readings.gps?.at ?? null, codes: readings.codes, mil: readings.mil } : null,
    telemetry: {
      gps: telemetry.filter((row) => row.source === "PHONE_GPS").slice(-60).map((row) => ({ id: row.id, at: row.at.toISOString(), vehicleId: row.vehicleId, data: row.data })),
      obd: telemetry.filter((row) => row.source === "OBD").slice(-60).map((row) => ({ id: row.id, at: row.at.toISOString(), vehicleId: row.vehicleId, data: row.data })),
    },
    events: events.slice(-200).map((event) => ({
      id: event.id, caseId: event.caseId, at: event.at.toISOString(), actorType: event.actorType, actorId: event.actorId,
      kind: event.kind, channel: event.channel, body: event.body,
    })),
    cases: cases.map((row) => ({
      id: row.id, kind: row.kind, status: row.status, urgency: row.urgency, title: row.title, summary: row.summary,
      openedAt: row.openedAt.toISOString(), updatedAt: row.updatedAt.toISOString(), waitingFor: row.waitingFor ?? null, nextCheckAt: iso(row.nextCheckAt),
    })),
    // What the helpdesk wrote on this order since the snapshot; the dataset's own messages are in the dossier already.
    messages: helpdesk,
  })
}
