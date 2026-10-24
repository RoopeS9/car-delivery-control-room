import { readFile } from "node:fs/promises"
import { join } from "node:path"

type Source = { id: string; order_id?: string; plan_id?: string; active_plan_id?: string; vehicle_id?: string;
  status?: string; type?: string; synthetic_vin?: string | null; boundary?: string;
  link_state?: string; candidate_order_ids?: string[]; linked_order_ids?: string[];
  contact_name?: string | null; contact_handle?: string | null }
type Related = { id: string; details: Source }
type OrderResponse = { order: { id: string }; items: { vehicle: { syntheticVin: string | null } }[];
  related: Record<string, Related[]> }

async function readRows(collection: string): Promise<Source[]> {
  const path = join(process.env.DATASET_DIR ?? join(process.cwd(), "..", "dataset", "data"), `${collection}.jsonl`)
  return (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Source)
}

function sameIds(actual: Related[], expected: Source[], label: string): void {
  const actualIds = actual.map((row) => row.id).sort()
  const expectedIds = expected.map((row) => row.id).sort()
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    throw new Error(`${label} mismatch: API=${actualIds.join(",")} source=${expectedIds.join(",")}`)
  }
}

async function main(): Promise<void> {
  const [orders, plans, points, segments] = await Promise.all([
    readRows("orders"), readRows("transport_plans"),
    readRows("transport_points"), readRows("transport_segments"),
  ])
  const order = orders.find((row) => {
    const planId = row.active_plan_id
    return planId && points.some((point) => point.plan_id === planId)
      && segments.some((segment) => segment.plan_id === planId)
  })
  if (!order?.active_plan_id) throw new Error("No order with a plan, points and segments in the source dataset")

  const base = process.env.APP_URL ?? "http://localhost:3000"
  const response = await fetch(`${base}/api/orders/${order.id}`)
  if (!response.ok) throw new Error(`Order API returned ${response.status} from ${base}`)
  const body = await response.json() as OrderResponse
  if (body.order.id !== order.id) throw new Error("Order API returned a different order")
  const orderPlans = plans.filter((plan) => plan.order_id === order.id)
  const planIds = new Set(orderPlans.map((plan) => plan.id))
  sameIds(body.related.transport_plans ?? [], orderPlans, "plans")
  sameIds(body.related.transport_points ?? [], points.filter((point) => planIds.has(point.plan_id ?? "")), "plan points")
  sameIds(body.related.transport_segments ?? [], segments.filter((segment) => planIds.has(segment.plan_id ?? "")), "plan segments")
  const [vehicles, items, ferryBookings, custodyReports, terminals, roadEstimates, proposals, steps] = await Promise.all([
    readRows("vehicles"), readRows("order_items"), readRows("travel_reservations"),
    readRows("custody_reports"), readRows("ferry_terminals"), readRows("terminal_road_estimates"),
    readRows("agent_proposals"), readRows("assignment_steps"),
  ])
  const vehicleById = new Map(vehicles.map((vehicle) => [vehicle.id, vehicle]))
  const expectedVins = items.filter((item) => item.order_id === order.id)
    .map((item) => vehicleById.get(String(item.vehicle_id))?.synthetic_vin).sort()
  const actualVins = body.items.map((item) => item.vehicle.syntheticVin).sort()
  if (JSON.stringify(actualVins) !== JSON.stringify(expectedVins)) throw new Error("Order API lost synthetic VINs")

  const [missedResponse, custodyResponse, referenceResponse, relayResponse, proposalResponse, travelResponse, bundleResponse] = await Promise.all([
    fetch(`${base}/api/orders/ord-00194`),
    fetch(`${base}/api/orders/ord-00004`),
    fetch(`${base}/api/reference-data`),
    fetch(`${base}/api/orders/ord-00702`),
    fetch(`${base}/api/orders/ord-00299`),
    fetch(`${base}/api/orders/ord-00449`),
    fetch(`${base}/api/orders/ord-00384`),
  ])
  if (!missedResponse.ok || !custodyResponse.ok || !referenceResponse.ok ||
      !relayResponse.ok || !proposalResponse.ok || !travelResponse.ok || !bundleResponse.ok) {
    throw new Error("One of the detailed evidence routes did not load")
  }
  const missed = await missedResponse.json() as OrderResponse
  const custody = await custodyResponse.json() as OrderResponse
  const reference = await referenceResponse.json() as { related: Record<string, Related[]> }
  const relay = await relayResponse.json() as OrderResponse
  const proposalCase = await proposalResponse.json() as OrderResponse
  const travelCase = await travelResponse.json() as OrderResponse
  const bundleCase = await bundleResponse.json() as OrderResponse & {
    events: { command: string; targetId: string }[]
  }
  sameIds(missed.related.travel_reservations ?? [], ferryBookings.filter((row) => row.order_id === "ord-00194"), "ferry history")
  if (!missed.related.travel_reservations?.some((row) => row.details.status === "MISSED_CHECK_IN")) {
    throw new Error("Original missed ferry status disappeared")
  }
  sameIds(custody.related.custody_reports ?? [], custodyReports.filter((row) => row.order_id === "ord-00004"), "custody reports")
  sameIds(reference.related.ferry_terminals ?? [], terminals, "shared ferry terminals")
  sameIds(reference.related.terminal_road_estimates ?? [], roadEstimates, "shared road estimates")
  const relayPlanIds = new Set(plans.filter((row) => row.order_id === "ord-00702").map((row) => row.id))
  sameIds(relay.related.transport_segments ?? [], segments.filter((row) => relayPlanIds.has(row.plan_id ?? "")), "relay legs")
  sameIds(proposalCase.related.agent_proposals ?? [], proposals.filter((row) => row.order_id === "ord-00299"), "agent review records")
  sameIds(travelCase.related.assignment_steps ?? [], steps.filter((row) => row.order_id === "ord-00449"), "assignment itinerary")
  const bundleOffer = (bundleCase.related.market_offers ?? []).find((row) =>
    row.details.type === "BUNDLE" && row.details.status === "ACCEPTED")
  if (!bundleOffer) {
    throw new Error("Second bundle order lost the shared accepted offer")
  }
  if (!bundleCase.events.some((row) => row.command === "offer.accepted" && row.targetId === bundleOffer.id)) {
    throw new Error("Second bundle order lost the shared acceptance history")
  }
  const [ownedBoardResponse, ownedDetailResponse, resolvedDetailResponse] = await Promise.all([
    fetch(`${base}/api/overview?q=CD-420593`),
    fetch(`${base}/api/orders/ord-00593`),
    fetch(`${base}/api/orders/ord-00020`),
  ])
  if (!ownedBoardResponse.ok || !ownedDetailResponse.ok || !resolvedDetailResponse.ok) {
    throw new Error("Alert lifecycle routes did not load")
  }
  const ownedBoard = await ownedBoardResponse.json() as { visible: { id: string; acknowledgedAlerts: string[] }[] }
  const ownedDetail = await ownedDetailResponse.json() as { alerts: { status: string; details: { owner?: string } }[] }
  const resolvedDetail = await resolvedDetailResponse.json() as { alerts: { status: string }[] }
  if (ownedBoard.visible.find((row) => row.id === "ord-00593")?.acknowledgedAlerts.length !== 1 ||
      !ownedDetail.alerts.some((alert) => alert.status === "ACKNOWLEDGED" && alert.details.owner === "ops-shift") ||
      !resolvedDetail.alerts.some((alert) => alert.status === "RESOLVED")) {
    throw new Error("Acknowledged or resolved alert evidence disappeared from the starter API")
  }
  const [identityResponse, contactResponse, streetResponse, supportResponse] = await Promise.all([
    fetch(`${base}/api/orders/ord-00009`),
    fetch(`${base}/api/orders/ord-00010`),
    fetch(`${base}/api/orders/ord-00023`),
    fetch(`${base}/api/orders/ord-00015`),
  ])
  if ([identityResponse, contactResponse, streetResponse, supportResponse].some((res) => !res.ok)) {
    throw new Error("One of the incomplete-input or support cases did not load")
  }
  const identity = await identityResponse.json() as OrderResponse
  const contact = await contactResponse.json() as OrderResponse
  const street = await streetResponse.json() as OrderResponse & { pickup: { details: { address_line1: string | null } } }
  const support = await supportResponse.json() as OrderResponse & {
    conversations: { details: { waiting_on?: string; owner?: string } }[];
    messages: { body: string }[]
  }
  if (!identity.items.some((item) => item.vehicle.syntheticVin === null)) {
    throw new Error("Missing vehicle identity was filled in by the starter")
  }
  if (!contact.related.order_endpoint_details?.some((row) => row.details.boundary === "PICKUP" &&
      row.details.contact_name === null && row.details.contact_handle === null)) {
    throw new Error("Missing pickup contact was filled in by the starter")
  }
  if (street.pickup.details.address_line1 !== null) {
    throw new Error("Missing pickup street was filled in by the starter")
  }
  if (support.messages.length !== 5 ||
      !support.conversations.some((row) => row.details.waiting_on === "SITE_CONFIRMATION" &&
        row.details.owner === "ops-readiness")) {
    throw new Error("Delayed support handoff was lost from the starter API")
  }
  const inboxResponse = await fetch(`${base}/api/inbox`)
  if (!inboxResponse.ok) throw new Error("Unlinked support inbox did not load")
  const inbox = await inboxResponse.json() as {
    threads: { id: string; order_id?: string; link_state: string;
      candidate_order_ids: string[]; linked_order_ids: string[] }[];
    messages: { id: string; thread_id: string; order_id?: string }[]
  }
  const [sourceThreads, sourceMessages] = await Promise.all([
    readRows("support_inbox_threads"), readRows("support_inbox_messages"),
  ])
  if (inbox.threads.length !== sourceThreads.length || inbox.messages.length !== sourceMessages.length ||
      inbox.threads.some((thread) => "order_id" in thread) ||
      inbox.messages.some((message) => "order_id" in message) ||
      !inbox.threads.some((thread) => thread.link_state === "PENDING_MATCH" &&
        thread.candidate_order_ids.length > 1 && thread.linked_order_ids.length === 0) ||
      !inbox.threads.some((thread) => thread.link_state === "NO_ORDER_REQUIRED" &&
        thread.linked_order_ids.length === 0) ||
      !inbox.threads.some((thread) => thread.link_state === "CONFIRMED_SINGLE" &&
        thread.linked_order_ids.length === 1)) {
    throw new Error("Inbox link uncertainty was lost from the starter API")
  }
  // The board and the order record must agree on whether an order needs a person.
  const overviewResponse = await fetch(`${base}/api/overview`)
  if (!overviewResponse.ok) throw new Error("Overview did not load")
  const overview = await overviewResponse.json() as { visible: { id: string; reference: string; attention: unknown[] }[] }
  const disagreements: string[] = []
  for (let index = 0; index < overview.visible.length; index += 10) {
    const cards = overview.visible.slice(index, index + 10)
    const views = await Promise.all(cards.map(async (card) => {
      const detailResponse = await fetch(`${base}/api/orders/${card.id}`)
      if (!detailResponse.ok) throw new Error(`Order API returned ${detailResponse.status} for ${card.id}`)
      const detail = await detailResponse.json() as { view: { attention: unknown[] } }
      return detail.view.attention
    }))
    cards.forEach((card, position) => {
      const recordAttention = views[position]
      if ((card.attention.length > 0) !== (recordAttention.length > 0)) {
        disagreements.push(`${card.reference} (board ${card.attention.length}, record ${recordAttention.length})`)
      }
    })
  }
  if (disagreements.length) {
    throw new Error(`Board and record disagree on "needs a person": ${disagreements.join(", ")}`)
  }
  console.log(`Verified ${order.id}: ${orderPlans.length} plans, ${(body.related.transport_points ?? []).length} points, ${(body.related.transport_segments ?? []).length} segments. Board and record agree on "needs a person" for ${overview.visible.length} orders.`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
