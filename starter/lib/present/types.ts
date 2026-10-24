// The view models the starter interface renders. They are derived on the server
// from the dataset records and carry labels, resolved names and chosen dates.
// They are reading aids; the raw records remain in the API for anyone who needs
// the source fields.

export type Tone = "danger" | "warn" | "accent" | "ok" | "neutral"

export type Row = Record<string, unknown>

export type Actor = {
  id: string | null
  kind: "driver" | "operator" | "agent" | "customer" | "site_contact" | "handoff_contact" | "system" | "unknown"
  name: string
  /** A role or title shown beside the name, for example "Support desk" or "driver". */
  role: string | null
}

export type Instant = { at: string; zone: string | null }

export type OrderRef = { id: string; reference: string }

export type Place = {
  name: string
  addressLine: string | null
  city: string
  country: string
  kind: string | null
  kindLabel: string
  zone: string | null
  siteId: string | null
}

export type AttentionKind =
  | "alert" | "owned_alert" | "work" | "incident" | "waiting" | "conversation" | "proposal"
  | "claim" | "custody" | "check" | "inbox"
  /** A decision card from our road agent, waiting on a person. */
  | "decision"
  /** One of our cases that is open but has no card waiting (agent working, or waiting on someone outside). */
  | "case"

export type AttentionItem = {
  kind: AttentionKind
  tone: Tone
  title: string
  /** The same item in a few words for a board card. */
  short: string
  detail: string | null
  /** Who owns the next step, when the record names someone. */
  owner: string | null
  /** When something is due or was last touched, as an ISO instant. */
  at: string | null
  atLabel: string | null
  /** Anchor of the record section with the source records. */
  section: string
  recordId: string
}

export type KeyDate = {
  key: "requested_pickup" | "pickup_slot" | "driver_start" | "promise" | "eta" | "delivered" | "cancelled" | "created"
  label: string
  start: string
  end: string | null
  zone: string | null
  source: string | null
  tone: Tone
  /** Short reading of the date against the snapshot: "in 2 d", "slot passed". */
  note: string | null
}

export type WorkLine = { icon: "driver" | "offer" | "alert" | "work" | "waiting" | "proposal" | "incident" | "note" | "bot"; text: string; tone: Tone }

export type BoardCard = {
  id: string
  reference: string
  displayLane: string
  status: string
  statusLabel: string
  routeKind: string
  routeKindLabel: string
  customer: string
  customerTier: string | null
  vehicle: string
  vehicleMake: string | null
  plate: string | null
  origin: string
  destination: string
  from: { city: string; country: string }
  to: { city: string; country: string }
  openAlerts: string[]
  acknowledgedAlerts: string[]
  attention: AttentionItem[]
  attentionTone: Tone
  decisive: KeyDate | null
  work: WorkLine[]
  updatedAt: string
}

export type Overview = {
  snapshotAt: string | null
  total: number
  counts: Record<string, number>
  attentionCounts: Record<string, number>
  visible: BoardCard[]
  query: string
}

export type Fact = { label: string; value: string; hint?: string | null; tone?: Tone; mono?: boolean; href?: string | null }

export type ContactView = {
  name: string | null
  handle: string | null
  role: string | null
  status: string
  statusLabel: string
  tone: Tone
  confirmedAt: string | null
  source: string | null
  sourceLabel: string | null
}

export type AccessView = {
  status: string
  statusLabel: string
  tone: Tone
  instruction: string | null
  statedBy: string | null
  statedByLabel: string | null
  confirmedAt: string | null
  source: string | null
  sourceLabel: string | null
}

export type WindowView = {
  purpose: string
  label: string
  start: string
  end: string | null
  zone: string | null
  source: string | null
  sourceLabel: string
  selected: boolean
  deadline: string | null
  deadlineSource: string | null
}

export type ProofView = {
  id: string
  kind: string
  kindLabel: string
  status: string
  statusLabel: string
  tone: Tone
  required: boolean
  fileCount: number
  submittedAt: string | null
  reviewedAt: string | null
  pointId: string | null
  pointLabel: string | null
  note: string | null
}

export type ClaimView = {
  id: string
  field: string
  claim: string
  confidence: string | null
  status: string
  statusLabel: string
  tone: Tone
  source: string | null
  recordedAt: string | null
  resolvedAt: string | null
}

export type SiteView = {
  id: string
  name: string
  kindLabel: string
  handoverMode: string | null
  hours: string | null
  advanceNoticeMinutes: number | null
  accessNote: string | null
  releaseRule: string | null
  requiresSignedRelease: boolean | null
  contactEmail: string | null
}

export type JourneyStep = {
  id: string
  role: "PICKUP" | "TRANSFER" | "DELIVERY"
  roleLabel: string
  boundary: string | null
  place: Place
  site: SiteView | null
  windows: WindowView[]
  contact: ContactView | null
  access: AccessView | null
  recorded: { label: string; at: string; actor: string | null } | null
  proofs: ProofView[]
  claims: ClaimView[]
  notes: string[]
}

export type TrackingView = {
  eta: string | null
  remainingKm: number | null
  progress: number | null
  observedAt: string | null
  receivedAt: string | null
  quality: string
  qualityLabel: string
  source: string
  sourceLabel: string
  note: string | null
}

export type AssignmentView = {
  id: string
  driver: Actor
  driverHome: string | null
  status: string
  statusLabel: string
  tone: Tone
  fee: string | null
  acceptedAt: string | null
  startedAt: string | null
  completedAt: string | null
  cancelledAt: string | null
  cancellation: string | null
  positioning: string | null
  priorOrder: OrderRef | null
  history: string | null
  steps: { id: string; sequence: number; title: string; kind: string; kindLabel: string; status: string; statusLabel: string; tone: Tone; scheduledStart: string | null; scheduledEnd: string | null; note: string | null; from: string | null; to: string | null }[]
}

export type JourneyLeg = {
  id: string
  sequence: number
  fromStepId: string
  toStepId: string
  distanceKm: number | null
  status: string
  statusLabel: string
  tone: Tone
  assignment: AssignmentView | null
  tracking: TrackingView | null
  inference: TrackingView | null
}

export type JourneyGroup = {
  itemId: string
  role: string
  roleLabel: string
  vehicle: string
  steps: JourneyStep[]
  legs: JourneyLeg[]
}

export type JourneyView = {
  plan: { id: string; version: number | null; status: string; statusLabel: string; source: string | null; activatedAt: string | null; active: boolean } | null
  otherPlans: { id: string; version: number | null; status: string; statusLabel: string; createdAt: string | null }[]
  groups: JourneyGroup[]
  distanceKm: number | null
}

export type OfferView = {
  id: string
  type: string
  typeLabel: string
  visibility: string
  status: string
  statusLabel: string
  tone: Tone
  fee: string | null
  publishedAt: string | null
  expiresAt: string | null
  acceptedAt: string | null
  withdrawnAt: string | null
  memberOrders: OrderRef[]
  pricingNote: string | null
  assumptions: string[]
  exposures: { id: string; driver: Actor; status: string; statusLabel: string; reason: string | null; shownAt: string | null; notifiedAt: string | null; viewedAt: string | null; decidedAt: string | null; expiresAt: string | null }[]
  reach: { checkedAt: string; screened: number; suitable: number; matched: number; accessible: number; note: string | null } | null
  demand: { views: number; passes: number; windowStart: string | null; windowEnd: string | null; note: string | null } | null
  assessment: string | null
}

export type ReservationView = {
  id: string
  kind: string
  kindLabel: string
  status: string
  statusLabel: string
  tone: Tone
  route: string | null
  departureAt: string | null
  arrivalAt: string | null
  checkInCutoffAt: string | null
  bookedAt: string | null
  reference: string | null
  driver: Actor | null
  checks: string[]
  amendment: string | null
  replaces: string | null
  replacedBy: string | null
  stateNote: string | null
}

export type OptionView = {
  id: string
  kind: string
  kindLabel: string
  status: string
  statusLabel: string
  tone: Tone
  route: string | null
  provider: string | null
  departureAt: string | null
  arrivalAt: string | null
  checkedAt: string | null
  quote: string | null
  note: string | null
}

export type MessageView = {
  id: string
  author: Actor
  recipient: Actor
  channel: string
  channelLabel: string
  at: string
  body: string
  internal: boolean
  language: string | null
  evidenceCount: number
  otherOrder: OrderRef | null
}

export type ThreadView = {
  id: string
  category: string
  categoryLabel: string
  channel: string
  channelLabel: string
  status: string
  statusLabel: string
  tone: Tone
  counterparty: Actor | null
  waitingOn: string | null
  owner: string | null
  nextCheckAt: string | null
  startedAt: string | null
  updatedAt: string | null
  relatedOrders: OrderRef[]
  follows: string | null
  messages: MessageView[]
}

export type DocumentView = {
  id: string
  kind: string
  kindLabel: string
  status: string
  statusLabel: string
  tone: Tone
  medium: string | null
  signatureScope: string | null
  required: boolean
  fileCount: number
  updatedAt: string | null
  note: string | null
}

export type ProposalView = {
  id: string
  status: string
  statusLabel: string
  tone: Tone
  command: string
  commandLabel: string
  summary: string
  rationale: string | null
  agent: Actor
  createdAt: string
  alertId: string | null
  evidenceCount: number
  dependency: string | null
  review: { decision: string; decisionLabel: string; note: string | null; reviewer: Actor; at: string } | null
  execution: { status: string; statusLabel: string; at: string | null; error: string | null; effects: number } | null
  superseded: string | null
}

export type NotificationView = {
  id: string
  activity: string
  activityLabel: string
  destination: string
  preview: string
  at: string
  deliveryState: string
  deliveryLabel: string
  actor: Actor
  alertId: string | null
  proposalId: string | null
}

export type AlertView = {
  id: string
  signal: string
  signalLabel: string
  severity: string
  status: string
  statusLabel: string
  tone: Tone
  summary: string
  triggeredAt: string
  owner: string | null
  acknowledgedAt: string | null
  acknowledgementReason: string | null
  resolvedAt: string | null
  resolutionReason: string | null
  nextAction: string | null
  evidenceCount: number
  conversationId: string | null
  assignmentId: string | null
}

export type WorkItemView = {
  id: string
  kind: string
  kindLabel: string
  status: string
  statusLabel: string
  tone: Tone
  priority: string | null
  owner: string | null
  createdBy: string | null
  summary: string
  nextAction: string | null
  openedAt: string | null
  dueAt: string | null
  closedAt: string | null
  outcome: string | null
  sourceCount: number
}

export type IncidentView = {
  id: string
  kind: string
  kindLabel: string
  status: string
  statusLabel: string
  tone: Tone
  owner: string | null
  openedAt: string | null
  resolvedAt: string | null
  facts: Fact[]
}

export type ExpenseView = {
  id: string
  kind: string
  kindLabel: string
  status: string
  statusLabel: string
  tone: Tone
  amount: string
  payer: string | null
  claimant: Actor | null
  receipt: string
  submittedAt: string | null
  reviewedAt: string | null
  note: string | null
}

export type HistoryEvent = {
  id: string
  at: string
  text: string
  actor: string | null
  detail: string | null
  shared: boolean
}

export type HistoryDay = { key: string; label: string; events: HistoryEvent[] }

export type CustodyView = {
  assets: { id: string; kind: string; kindLabel: string; label: string; holder: string; basis: string; nextAction: string | null; owner: string | null; dueAt: string | null; relatedOrder: OrderRef | null; events: { id: string; at: string; kindLabel: string; note: string | null; verification: string }[] }[]
  reports: { id: string; at: string; driver: Actor; security: string; continuity: string; location: string; parking: string | null }[]
}

export type RecordHeader = {
  id: string
  reference: string
  customerReference: string | null
  lane: string
  laneLabel: string
  status: string
  statusLabel: string
  readiness: string | null
  readinessLabel: string | null
  routeKind: string
  routeKindLabel: string
  source: string | null
  createdAt: string
  updatedAt: string
  cancelledAt: string | null
  vehicle: { title: string; make: string; model: string; year: number | null; fuel: string | null; plate: string | null; vin: string | null; illustrationSlug: string | null; logoSlug: string | null } | null
  tradeIn: { title: string; plate: string | null; vin: string | null } | null
  customer: { id: string; name: string; tier: string | null; tierLabel: string | null; country: string | null }
  from: Place
  to: Place
  via: Place[]
  keyDates: KeyDate[]
  facts: Fact[]
  summary: string
}

/** The situation in plain words: one sentence of context, one headline, one line of dates. */
export type Story = {
  intro: string
  headline: string
  tone: Tone
  detail: string | null
}

export type Tile = { label: string; value: string; hint: string | null; tone: Tone; href?: string | null }

export type RecordView = {
  snapshotAt: string | null
  story: Story
  tiles: Tile[]
  header: RecordHeader
  attention: AttentionItem[]
  journey: JourneyView
  alerts: AlertView[]
  workItems: WorkItemView[]
  incidents: IncidentView[]
  threads: ThreadView[]
  proofs: ProofView[]
  documents: DocumentView[]
  custody: CustodyView
  siteVisits: { id: string; at: string; leftAt: string | null; outcome: string; verifiedBySite: boolean; site: string | null }[]
  notes: { id: string; at: string; author: Actor; body: string; visibility: string | null }[]
  proposals: ProposalView[]
  notifications: NotificationView[]
  offers: OfferView[]
  assignments: AssignmentView[]
  reservations: ReservationView[]
  options: OptionView[]
  confirmations: { id: string; at: string; driver: Actor; kindLabel: string; report: string }[]
  terminalEvents: { id: string; at: string; kindLabel: string; terminal: string | null; reason: string | null; note: string | null }[]
  expenses: ExpenseView[]
  history: HistoryDay[]
  historyTotal: number
  inboxHints: { id: string; state: string; stateLabel: string; category: string; channel: string; owner: string | null; waitingOn: string | null; basis: string | null; confirmed: boolean; candidates: OrderRef[]; linked: OrderRef[] }[]
  otherRecords: { collection: string; label: string; count: number }[]
  sections: { id: string; label: string; count: number | null }[]
  /** Our cases on this order, newest first, each with its decision cards. */
  cases: CaseView[]
  /** Dataset messages and events merged with our case timeline, oldest first. */
  timeline: TimelineEntry[]
  /** The simulated clock when the view was built. Live "x min ago" is measured from here. */
  simNow: string
  /** Latest simulated OBD and GPS, when the car has reported. */
  telemetry: TelemetryStripView | null
}

export type EntityKind = "driver" | "customer" | "site"

/** A driver, customer or site with the orders it is involved in. */
export type EntityView = {
  snapshotAt: string | null
  kind: EntityKind
  kindLabel: string
  id: string
  title: string
  subtitle: string | null
  facts: Fact[]
  notes: string[]
  links: { label: string; href: string; hint: string | null }[]
  cards: BoardCard[]
  /** How this entity is involved with each order, by order id. */
  roles: Record<string, string>
}

export type InboxMessageView = {
  id: string
  author: Actor
  recipient: Actor
  channel: string
  channelLabel: string
  at: string
  body: string
  internal: boolean
  language: string | null
}

export type InboxThreadView = {
  id: string
  category: string
  categoryLabel: string
  channel: string
  channelLabel: string
  status: string
  statusLabel: string
  tone: Tone
  linkState: string
  linkStateLabel: string
  linkTone: Tone
  owner: string | null
  waitingOn: string | null
  counterparty: Actor | null
  openedAt: string | null
  updatedAt: string | null
  candidateBasis: string | null
  candidates: OrderRef[]
  linked: OrderRef[]
  resolution: { decisionLabel: string; at: string | null } | null
  messages: InboxMessageView[]
}

export type InboxView = { snapshotAt: string | null; threads: InboxThreadView[]; open: number }

export type EntityListItem = { id: string; title: string; subtitle: string | null; count: number; href: string }
export type EntityList = { kind: EntityKind; kindLabel: string; items: EntityListItem[] }

// ---------------------------------------------------------------- cases (team Random)

/** Where one fact came from, printed as a chip: "Driver, app chat · 08:22". */
export type SourceChip = { kind: string; id: string; label: string; at: string | null; href?: string | null }

export type DraftView = {
  /** The draft as the agent stored it; an edit sends this back with a new body. */
  original: import("@/lib/cr/types").DraftMessage
  toName: string
  /** "customer", "pickup site", "driver". */
  toRole: string
  isCustomer: boolean
  channelLabel: string
  subject: string | null
  body: string
}

export type DecisionCardView = {
  id: string
  caseId: string
  actionType: string
  actionLabel: string
  title: string
  rationale: string
  status: string
  statusLabel: string
  tone: Tone
  pending: boolean
  whatHappened: string | null
  facts: { text: string; sources: SourceChip[] }[]
  agentDid: string[]
  unknowns: string[]
  recommendation: string | null
  alternatives: string[]
  changes: { label: string; before: string | null; after: string }[]
  draft: DraftView | null
  /** The operator's version, when they edited the draft before approving. */
  editedDraft: DraftView | null
  options: { id: string; label: string; description: string | null; recommended: boolean }[]
  evidence: SourceChip[]
  nextIfApproved: string
  nextIfRejected: string
  createdAt: string
  createdBy: string
  /** Why this needs a person: the autonomy rule that applies to the action type. */
  approvalRule: string
  decision: {
    by: string; at: string | null; note: string | null; option: string | null; nextStep: string | null; executedAt: string | null
    /** `operator` when a person said "I'll handle it", `instruction` when they told the agent what to do instead. */
    mode: string | null
    /** The one line the operator logged after handling it. */
    outcome: string | null
  } | null
  /** A person said "I'll handle it" and has not logged what happened yet. */
  awaitingOutcome: boolean
  /** Something new came in from outside (driver, site, customer, car) after this card was drafted. */
  factsChanged: { at: string; what: string } | null
  /** OUTDATED: the records the card relied on changed before it could run (PLAN 4.2b). */
  outdated: { changed: { label: string; expected: string | null; actual: string | null }[] } | null
  /** UNKNOWN_OUTCOME: an outside action may or may not have happened. */
  unknownOutcome: boolean
}

export type CaseView = {
  id: string
  kind: string
  kindLabel: string
  status: string
  statusLabel: string
  tone: Tone
  urgency: string
  urgencyLabel: string
  title: string
  summary: string
  channelLabel: string
  openedAt: string
  updatedAt: string
  resolvedAt: string | null
  owner: string | null
  waitingOn: string | null
  nextStep: string | null
  sources: SourceChip[]
  pending: DecisionCardView[]
  /** Out-of-date cards the agent is redrafting, and actions whose outcome is unknown. */
  outdated: DecisionCardView[]
  unknown: DecisionCardView[]
  decided: DecisionCardView[]
}

export type TimelineEntry = {
  id: string
  at: string
  actorName: string
  actorRole: string | null
  actorKind: string
  /** message, voice, photo, safety, lookup, proposal, decision, effect, telemetry, event, note */
  kind: string
  text: string
  /** "App chat to Hamburg Prestige Cars", "Voice call", "OBD dongle (simulated)". */
  channelLabel: string | null
  /** Where the line comes from, so a reader can tell a record from a live event. */
  source: SourceChip
  tone: Tone
  /** `record` for the dataset snapshot, `live` for events after it. */
  origin: "record" | "live"
  internal: boolean
  caseId: string | null
  /** A photo sent on this line, served from /orders/:id/photos/:eventId (or a public path). */
  photo: { src: string; subject: string | null } | null
}

/** The car's latest OBD reading and phone position, for the strip on a case. */
export type TelemetryStripView = {
  at: string | null
  ageLabel: string | null
  /** Older than 10 minutes of simulated time. */
  stale: boolean
  mil: "OFF" | "ON" | "FLASHING" | null
  values: { label: string; value: string; tone: Tone }[]
  codes: { code: string; title: string | null; severity: string | null; tone: Tone }[]
  position: { label: string; ageLabel: string | null } | null
  simulated: boolean
  /** Electric cars report little over standard OBD2. */
  electric: boolean
}

// ---------------------------------------------------------------- queue (home)

export type QueueRow = {
  orderId: string
  reference: string
  vehicle: string
  vehicleMake: string | null
  route: string
  customer: string
  /** `agent`: one of our cases with the agent's work behind it. `records`: the starter's recorded reasons, no agent analysis. */
  origin: "agent" | "records"
  caseId: string | null
  /** One line: what happened. */
  headline: string
  /** The decision waiting, or the next action. */
  ask: string | null
  tone: Tone
  /** Lower sorts first: the most urgent row leads its section. */
  rank: number
  urgencyLabel: string | null
  statusLabel: string
  /** "Road agent", a desk title, or "Owner not recorded". */
  who: string
  whoKind: "agent" | "person" | "nobody"
  /** The moment the age is measured from. */
  since: string | null
  sinceLabel: string
  /** For a records row: the reasons the records give, each with its source. */
  reasons: { text: string; detail: string | null; source: string; href: string }[]
  /** Waiting rows: who we wait on and when we look again. */
  waitingOn: string | null
  nextCheckAt: string | null
  nextCheckLabel: string | null
  /** The next check time has passed. */
  overdue: boolean
  /** Other open items on the same order, in a few words. */
  more: string | null
}

export type QueueView = {
  snapshotAt: string | null
  simNow: string
  /** Needs your decision: cards, escalations, overdue follow-ups and urgent records, most urgent first. */
  decide: QueueRow[]
  /** Records rows with only routine open items (open threads, unverified pickup details). Folded under the decide section. */
  routine: QueueRow[]
  agentWorking: QueueRow[]
  waiting: QueueRow[]
  /** Closed by the agent (or resolved) in the last 24 h of simulated time. */
  handled: QueueRow[]
  /** Orders with nothing open in the records and no open case. */
  quietCount: number
  total: number
}

// ---------------------------------------------------------------- map

export type MapMarkerState = "decide" | "agent" | "waiting" | "fine"

export type MapMarker = {
  orderId: string
  reference: string
  vehicle: string
  vehicleMake: string | null
  route: string
  customer: string
  driver: string | null
  lat: number
  lng: number
  /** When the simulated phone reported this position. */
  at: string
  ageLabel: string
  /** No position for a while: drawn hollow with "last seen". */
  stale: boolean
  state: MapMarkerState
  stateLabel: string
  tone: Tone
  caseId: string | null
  caseTitle: string | null
  ask: string | null
  speedKmh: number | null
  placeLabel: string | null
  /** Always true in this prototype; shown on every position. */
  simulated: boolean
}

export type MapView = {
  simNow: string
  markers: MapMarker[]
  /** Moving orders without any simulated position yet. */
  unplaced: { orderId: string; reference: string; vehicle: string; route: string }[]
  staleAfterMinutes: number
}

// ---------------------------------------------------------------- agent page

/** A run of text in a playbook line. Tool names and codes are already in plain words. */
export type InlineRun = { text: string; bold?: boolean; italic?: boolean; term?: boolean }
export type PlaybookBlock =
  | { type: "h2"; text: string }
  | { type: "p"; runs: InlineRun[] }
  | { type: "ol" | "ul"; items: InlineRun[][] }

export type PlaybookView = { slug: string; title: string; intro: string | null; blocks: PlaybookBlock[] }

export type AutonomyView = {
  actionType: string
  label: string
  meaning: string
  level: string
  levelLabel: string
  locked: boolean
  updatedBy: string | null
  updatedAt: string | null
}

export type ActivityView = { id: string; at: string; orderId: string; reference: string; text: string; kind: string; channelLabel: string | null }

export type AgentPageView = {
  simNow: string
  playbooks: PlaybookView[]
  autonomy: AutonomyView[]
  activity: ActivityView[]
  runs: { count: number; toolCalls: number; costUsd: number | null; lastAt: string | null }
}
