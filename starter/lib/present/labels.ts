// Human labels for the dataset's codes. Every label here is a reading aid for the
// starter interface. The raw code stays in the API; the label never replaces it as
// a source of truth.

export const LANES = [
  ["intake", "New orders"],
  ["ready", "Ready to post"],
  ["market", "Finding a driver"],
  ["booked", "Driver assigned"],
  ["moving", "Moving"],
  ["delivered", "Delivered"],
  ["cancelled", "Cancelled"],
] as const

export type Lane = (typeof LANES)[number][0]

export const LANE_ORDER: Lane[] = LANES.map(([lane]) => lane)

export function laneLabel(lane: string): string {
  return LANES.find(([key]) => key === lane)?.[1] ?? humanize(lane)
}

export function isLane(value: string): value is Lane {
  return LANE_ORDER.includes(value as Lane)
}

const ACRONYMS: Record<string, string> = {
  eta: "ETA", vin: "VIN", cmr: "CMR", id: "ID", ids: "IDs", eu: "EU", fr: "FR", de: "DE", fi: "FI", dk: "DK",
  nl: "NL", se: "SE", whatsapp: "WhatsApp", sla: "SLA", ops: "Ops", app: "app", pdf: "PDF", utc: "UTC",
}

/** "SOME_ENUM_VALUE", "some_enum_value" or "order.created" to "Some enum value" / "Order created". */
export function humanize(code: string | null | undefined): string {
  if (!code) return ""
  const words = String(code).replace(/[._]+/g, " ").trim().toLowerCase().split(/\s+/)
  return words.map((word, index) => {
    const acronym = ACRONYMS[word]
    if (acronym) return acronym
    return index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word
  }).join(" ")
}

/** Known codes with wording that the generic rule gets wrong or leaves too terse. */
const EXPLICIT: Record<string, string> = {
  // order
  NEW: "New", WAITING_FOR_PICKUP: "Waiting for pickup", IN_TRANSIT: "In transit", DELIVERED: "Delivered",
  PREPARING: "Preparing inputs", CONFIRMED: "Confirmed", DOMESTIC: "Domestic", IMPORT: "Import",
  PRIMARY: "Primary car", TRADE_IN: "Trade-in",
  // endpoint
  NEEDS_VERIFICATION: "Needs verification", UNCONFIRMED: "Unconfirmed",
  MANAGED_SITE_PROFILE: "site profile", HANDOFF_ACCESS_REPLY: "handoff contact reply",
  DIRECT_HANDOFF_CONTACT_REPLY: "direct reply from the handoff contact", CUSTOMER_AND_HANDOFF_CONTACT: "customer and handoff contact",
  SITE_CONTACT_REPLY: "site contact reply", SITE_ACCESS_REPLY: "site access reply", CUSTOMER_ORDER_INPUT: "customer order input",
  HANDOFF_CONTACT: "handoff contact",
  // alerts and work
  PENDING_REVIEW: "Awaiting review", APPROVED_AWAITING_EXECUTION: "Approved, not yet executed",
  EXECUTED: "Executed", REJECTED: "Rejected", FAILED: "Failed", NEEDS_EXTERNAL_INPUT: "Needs external input",
  INVESTIGATING: "Investigating", AWAITING_DECISION: "Awaiting decision", NEEDS_HUMAN: "Needs a person",
  FR_IMPORT_TRAVEL_DECISION: "French import travel decision", FERRY_TRACKING_GAP_CONTEXT: "Ferry tracking gap",
  DELIVERY_PROMISE_UNACHIEVABLE: "Delivery promise unachievable", DIGITAL_CMR_CHECK: "Digital CMR check",
  PLATE_PAPERWORK_CHECK: "Plate paperwork check", CALL_AHEAD: "Call ahead",
  // market and travel
  AVAILABLE_QUOTE: "Quote available", SOLD_OUT: "Sold out", MISSED_CHECK_IN: "Missed check-in", BOOKED: "Booked",
  PUBLISHED: "Published", WITHDRAWN: "Withdrawn", ACCEPTED: "Accepted", DIRECTED: "Directed", OPEN: "Open",
  REGULAR: "Single order", BUNDLE: "Bundle", SHOWN: "Shown", NOTIFIED: "Notified", VIEWED: "Viewed", EXPIRED: "Expired",
  RETURN_ROUTE: "return route", PAYOUT_DUE: "payout due", NO_PAYOUT: "no payout",
  // proofs and documents
  PICKUP_PHOTOS: "Pickup photos", DELIVERY_PHOTOS: "Delivery photos", KEY_PICKUP_PHOTOS: "Key pickup photos",
  KEY_DELIVERY_PHOTOS: "Key delivery photos", TRADE_IN_PICKUP_PHOTOS: "Trade-in pickup photos",
  TRADE_IN_DELIVERY_PHOTOS: "Trade-in delivery photos", YARD_ARRIVAL_PHOTOS: "Yard arrival photos",
  YARD_RELEASE_PHOTOS: "Yard release photos", RELEASE_AUTHORITY: "Release authority", SIGNED_HANDOVER: "Signed handover",
  CONDITION_PHOTO: "Condition photo", COLLECTION_ONLY: "collection only", SELLER_ONLY: "seller only", BOTH: "both parties",
  NONE: "none", ATTACHED_SAMPLED: "receipt attached, sample in packet", ATTACHED_NOT_SAMPLED: "receipt attached, no sample in packet",
  MISSING: "Missing", SUBMITTED: "Submitted", APPROVED: "Approved", REQUIRED: "Required", WAIVED: "Waived",
  SUPERSEDED: "Superseded", VERIFIED: "Verified", PREPARED: "Prepared", SIGNED: "Signed", REQUESTED: "Requested",
  // expenses
  TRAIN_POSITIONING: "Train, positioning", BUS_POSITIONING: "Bus, positioning", FLIGHT_POSITIONING: "Flight, positioning",
  TAXI_POSITIONING: "Taxi, positioning", CHARGING: "Charging", FUEL: "Fuel", PARKING: "Parking", TOLL: "Toll", HOTEL: "Hotel",
  BAHN: "Bahn", DRIVER: "Driver", DRIVER_CHAT: "driver chat", CENTRAL_RECEIPT_MATCHER: "central receipt matcher",
  // conversations
  pickup_and_release: "Pickup and release", schedule_and_eta: "Schedule and ETA", documents_and_proof: "Documents and proof",
  driver_travel: "Driver travel", delivery_and_receiver: "Delivery and receiver", order_information: "Order information",
  order_change: "Order change", vehicle_custody: "Vehicle custody", ferry_and_route: "Ferry and route",
  vehicle_condition: "Vehicle condition", driver_availability: "Driver availability", costs_and_payments: "Costs and payments",
  offer_and_pricing: "Offer and pricing", travel_and_assignment: "Travel and assignment", expense_payout: "Expense payout",
  support_chat: "Support chat", case_workspace: "Case workspace", email: "Email", driver_chat: "Driver chat",
  customer_email: "Customer email", site_call: "Site call", whatsapp: "WhatsApp", app_chat: "App chat", site_chat: "Site chat",
  driver_app_chat: "Driver app chat", internal_note: "Internal note",
  SITE_CONFIRMATION: "site confirmation", OPERATOR_FOLLOWUP: "operator follow-up", CUSTOMER_VEHICLE_IDENTITY: "the customer's vehicle identity",
  CORRECTED_EXPENSE_REVIEW: "a corrected expense review", STOCK_CONTROL_REPLY: "a stock control reply", SELLER_HOLD_CLEARANCE: "seller hold clearance",
  DRIVER_DUTY_REFERENCE: "a driver duty reference",
  // tracking
  COARSE: "coarse", STALE: "stale", INFERRED: "inferred", driver_app: "driver app", ferry_schedule_inference: "ferry schedule inference",
  // custody
  LOCKED_KEYS_WITH_DRIVER: "locked, keys with driver", UNVERIFIED_DRIVER_REPORT: "unverified driver report",
  NOT_PROVIDED: "not provided", NO_HANDOVER_EVIDENCE: "no handover evidence", KEY_SET: "Key set", QUESTION_ONLY: "question only",
  REPORTED_UNVERIFIED: "reported, unverified", DOCUMENT_RECORD_ONLY: "document record only", UNKNOWN: "unknown",
  // incidents
  EMPTY_PICKUP: "Empty pickup", TRAVEL_CAPACITY: "Travel capacity", VEHICLE_WARNING: "Vehicle warning",
  POST_DELIVERY_CONDITION_CLAIM: "Post-delivery condition claim", PENDING_CUSTOMER: "pending customer",
  // plans
  ACTIVE: "Active", COMPLETED: "Completed", DRAFT: "Draft", CANCELLED: "Cancelled", REPLACED: "Replaced", PLANNED: "Planned",
  IN_PROGRESS: "In progress", ASSIGNED: "Assigned", READY: "Ready", OFFERED: "Offered", UNVERIFIED: "Unverified",
  // misc
  VEHICLE_PICKUP: "Vehicle pickup", VEHICLE_DELIVERY: "Vehicle delivery", VEHICLE_FERRY: "Vehicle ferry",
  POSITIONING_TRAVEL: "Positioning travel", RETURN_TRAVEL: "Return travel", FERRY: "Ferry", TRAIN: "Train", FLIGHT: "Flight",
  DEALERSHIP: "Dealership", PRIVATE_HOME: "Private address", THIRD_PARTY_BUSINESS: "Third-party business",
  INDEPENDENT_STORAGE: "Independent storage", SOURCE_DEALER: "Source dealer", TRANSFER_YARD: "Transfer yard",
  standard: "Standard account", key: "Key account", network: "Network account",
  WEB: "web", PORTAL: "portal", API: "API", PUBLIC: "Public", INTERNAL: "Internal", OPERATIONS: "Operations",
  POSTED: "Posted", OPERATOR_ACK: "Operator acknowledged", SOURCE_RESOLVED: "Source resolved", SUPPRESSED: "Suppressed",
  DELIVERY_FAILED: "Delivery failed", RECORDED: "recorded", PROPOSAL_REVIEW: "Proposal review",
  PENDING_MATCH: "Pending match", CONFIRMED_SINGLE: "Linked to one order", CONFIRMED_MULTI: "Linked to several orders",
  NO_ORDER_REQUIRED: "No order needed", ACCOUNT_CONFLICT: "Account conflict",
  VEHICLE_NOT_FOUND: "vehicle not found", CHECK_IN_REJECTED: "Check-in rejected",
  // support inbox
  PENDING_IDENTITY: "Pending identity", LINK_ONE_ORDER: "Linked to one order", LINK_SEVERAL_ORDERS: "Linked to several orders",
  ANSWER_GENERAL_POLICY: "Answered as general policy", SENDER_CORRECTION: "a correction from the sender",
  DOCUMENT_READY: "the document to be ready", PAYOUT_RECONCILIATION: "payout reconciliation",
  order_status: "Order status", document_request: "Document request", general_policy: "General policy",
}

export function label(code: string | null | undefined): string {
  if (code == null || code === "") return ""
  return EXPLICIT[String(code)] ?? humanize(String(code))
}

/** Lower-case label for use inside a sentence. Acronyms keep their case. */
export function labelIn(code: string | null | undefined): string {
  const text = label(code)
  if (!text) return ""
  const first = text.split(" ")[0] ?? ""
  if (first.length > 1 && first === first.toUpperCase()) return text
  return text.charAt(0).toLowerCase() + text.slice(1)
}

export function severityLabel(severity: string | null | undefined): string {
  return label(severity).toLowerCase() || "unknown"
}
