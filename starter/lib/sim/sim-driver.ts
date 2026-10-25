// The simulated driver, for recording the video only (PLAN.md 4.5): in the
// live demo a teammate plays the driver, so this is off by default. When on,
// it answers the agent's questions in the driver channel for scenarios A, B
// and C, through the same routes a phone uses. In scenario F nobody answers.
//
// With a model key it speaks through Claude Haiku 5.5 from a short fact sheet;
// without one it picks scripted lines from the same facts. Either way it only
// says what the fact sheet supports.

import { and, desc, eq, inArray, or } from "drizzle-orm"
import { beginRuntimeWork, isResetting, withRuntimeWork } from "@/lib/cr/activity"
import { llm, simDriverModel } from "@/lib/agent/client"
import { simNow } from "@/lib/cr/clock"
import { crDb } from "@/lib/cr/db"
import { crAgentRuns, crEvents } from "@/lib/cr/schema"
import { sendDriverMessage, uploadPublicPhoto } from "./channel-client"
import { fleetCar } from "./fleet"
import { reconnectCar, reconnectPlace } from "./reconnect"
import { activeFaults } from "./sync"

type Reply = { text: string; photo?: boolean; reconnect?: boolean }

type Persona = {
  reference: string
  driverId: string
  /** What the driver knows, written as the driver would say it. Read by the model. */
  facts: () => Promise<string[]>
  /** Scripted answers by topic, used without a model key. First match wins. */
  scripted: (question: string) => Promise<Reply>
}

const DEMO_PHOTO = "/sim/dashboard-misfire.jpg"
const MAX_REPLIES_PER_ORDER = 8
/** Pause before answering, in real seconds, so the conversation reads like a person typing. */
const THINK_SECONDS = 4

const has = (text: string, ...words: string[]) => words.some((word) => text.includes(word))

async function stopLabel584(): Promise<string> {
  const car = await fleetCar("CD-420584")
  const plan = car ? (await activeFaults()).get(car.orderId) : undefined
  return plan?.profile === "misfire" ? plan.stopLabel : "a service area on the motorway"
}

const PERSONAS: Persona[] = [
  {
    reference: "CD-420584",
    driverId: "drv-042",
    facts: async () => [
      "You are Leo Quellford, a freelance car delivery driver, driving a Bentley Continental GT from Cologne to Helsinki (order CD-420584).",
      "On the motorway the orange engine light came on and started flashing, the car shook and lost power, and a 'reduced power' message appeared.",
      `You pulled into ${await stopLabel584()} and parked away from the traffic. You are safe and nobody is hurt.`,
      "No smoke, no burning smell. You switched the engine off after stopping.",
      "You can send a photo of the dashboard if asked.",
      "You are calm but worried about the ferry check-in in Hamburg this afternoon.",
    ],
    scripted: async (q) => {
      if (has(q, "photo", "picture", "dashboard")) return { text: "Here's the dashboard.", photo: true }
      if (has(q, "safe", "okay", "ok?", "hurt", "injur")) return { text: `Yes, I'm safe. I've pulled into ${await stopLabel584()} and parked away from the traffic.` }
      if (has(q, "where", "location", "exactly")) return { text: `I'm at ${await stopLabel584()}.` }
      if (has(q, "flash", "steady", "colour", "color", "light")) return { text: "It's the orange engine light and it was flashing. There's also a message saying reduced power." }
      if (has(q, "engine", "switch", "turn off", "running")) return { text: "The engine is off now." }
      if (has(q, "smoke", "smell", "shak", "noise", "symptom")) return { text: "It shook and lost power when I accelerated. No smoke and no smell." }
      return { text: "OK, understood. I'll wait here with the car." }
    },
  },
  {
    reference: "CD-420322",
    driverId: "drv-319",
    facts: async () => [
      "You are Kasper Kovelund, a freelance car delivery driver, with a Bentley Continental GT going from Munich to Hamburg (order CD-420322).",
      "At about 08:00 UTC a red warning light came on and the car felt weak when you accelerated. You stopped at a service-area car park at 08:04 and switched the engine off.",
      `You are at ${(await reconnectPlace("CD-420322")) ?? "a service area on the motorway"}. You are safe.`,
      "You have not touched anything under the bonnet. You are waiting for someone to tell you who collects the car.",
      "If asked to connect the OBD dongle or read the car, you plug it in and switch the ignition on without starting the engine.",
      "You cannot send a useful dashboard photo now: with the engine off the warning lights are dark.",
    ],
    scripted: async (q) => {
      if (has(q, "dongle", "obd", "readout", "read the car", "connect", "ignition")) return { text: "Done. The dongle is plugged in and the ignition is on, engine off.", reconnect: true }
      if (has(q, "photo", "picture")) return { text: "With the engine off the warning lights are dark, so a photo won't show much. The dongle can read the codes." }
      if (has(q, "where", "location", "which service")) return { text: `I'm at ${(await reconnectPlace("CD-420322")) ?? "the service area"}.` }
      if (has(q, "safe", "okay", "ok?")) return { text: "Yes, I'm safe, sitting in the car park next to the car." }
      if (has(q, "light", "warning", "colour", "color")) return { text: "It was a red warning, I think the temperature one. The car felt weak when I accelerated, so I stopped." }
      return { text: "OK. I'll wait here until someone tells me who is collecting the car." }
    },
  },
  {
    reference: "CD-420145",
    driverId: "drv-130",
    facts: async () => [
      "You are Kasper Carvell, a freelance car delivery driver, with a Porsche 911 Carrera going from Lahti to Kavornia in Helsinki (order CD-420145).",
      "Everything is fine with the car. You are about 40 minutes from Helsinki.",
      "You asked where to leave the car and the keys at the delivery.",
    ],
    scripted: async (q) => {
      if (has(q, "when", "eta", "arrive", "how long")) return { text: "In about 40 minutes." }
      return { text: "Great, thanks!" }
    },
  },
]

// ---------------------------------------------------------------- state

type State = { enabled: boolean; humans: Set<string>; answered: Set<string>; replies: Map<string, number>; busy: Set<string> }
const holder = globalThis as unknown as { __simDriver?: State }
function state(): State {
  holder.__simDriver ??= { enabled: false, humans: new Set(), answered: new Set(), replies: new Map(), busy: new Set() }
  return holder.__simDriver
}

/** The toggle exists only when SIM_DRIVER_ENABLED is not "false". */
export function simDriverAvailable(): boolean {
  return process.env.SIM_DRIVER_ENABLED !== "false"
}

export function simDriverStatus() {
  const current = state()
  return { available: simDriverAvailable(), enabled: current.enabled && simDriverAvailable(), humans: [...current.humans], usesModel: !!llm(), model: llm() ? simDriverModel() : null }
}

export function setSimDriver(enabled: boolean): void {
  const current = state()
  current.enabled = enabled
  if (enabled) { current.humans.clear(); current.replies.clear() }
}

/** A person typed in /driver: the simulated driver stays quiet for that driver from now on. */
export function markHumanDriver(driverId: string): void {
  state().humans.add(driverId)
}

/** Forget answers and overrides, for a fresh take. */
export function resetSimDriver(): void {
  const current = state()
  current.humans.clear(); current.answered.clear(); current.replies.clear(); current.busy.clear()
}

// ---------------------------------------------------------------- step

/** Called on every sim tick: answer the newest unanswered agent question for each persona. Never awaits the agent. */
export async function simDriverStep(origin: string): Promise<void> {
  if (isResetting()) return
  return withRuntimeWork("simulated driver polling", () => runSimDriverStep(origin))
}

async function runSimDriverStep(origin: string): Promise<void> {
  const current = state()
  if (!current.enabled || !simDriverAvailable()) return
  for (const persona of PERSONAS) {
    if (current.humans.has(persona.driverId) || current.busy.has(persona.driverId)) continue
    const car = await fleetCar(persona.reference)
    if (!car) continue
    if ((current.replies.get(car.orderId) ?? 0) >= MAX_REPLIES_PER_ORDER) continue
    const thread = await threadFor(car.orderId, persona.driverId)
    const last = thread.at(-1)
    if (!last || last.from !== "agent" || current.answered.has(last.id)) continue
    if (!asksSomething(last)) continue
    if (simNow().getTime() - last.at.getTime() < THINK_SECONDS * 1000) continue
    if (await agentStillWorking(car.orderId)) continue
    current.answered.add(last.id)
    current.busy.add(persona.driverId)
    const release = beginRuntimeWork("simulated driver reply")
    void answer(origin, persona, car.reference, thread)
      .catch((error) => console.warn(`[sim driver] ${persona.reference}: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        release()
        current.busy.delete(persona.driverId)
        current.replies.set(car.orderId, (current.replies.get(car.orderId) ?? 0) + 1)
      })
  }
}

type Turn = { id: string; at: Date; from: "agent" | "driver"; text: string; photoRequest: boolean }

async function threadFor(orderId: string, driverId: string): Promise<Turn[]> {
  const rows = await crDb().select().from(crEvents).where(and(eq(crEvents.orderId, orderId), inArray(crEvents.kind, ["message", "voice_turn", "photo"]), or(
    and(eq(crEvents.actorType, "driver"), eq(crEvents.actorId, driverId)),
    and(eq(crEvents.recipientType, "driver"), eq(crEvents.recipientId, driverId)),
  ))).orderBy(crEvents.at)
  return rows.map((row) => ({
    id: row.id, at: row.at, from: row.actorType === "driver" ? "driver" : "agent", text: row.body,
    photoRequest: row.data.request === "photo",
  }))
}

function asksSomething(turn: Turn): boolean {
  return turn.photoRequest || turn.text.includes("?") || /\b(please (send|tell|confirm|connect|plug)|let me know)\b/i.test(turn.text)
}

async function agentStillWorking(orderId: string): Promise<boolean> {
  const [run] = await crDb().select({ status: crAgentRuns.status }).from(crAgentRuns).where(eq(crAgentRuns.orderId, orderId))
    .orderBy(desc(crAgentRuns.startedAt)).limit(1)
  return run?.status === "RUNNING"
}

async function answer(origin: string, persona: Persona, reference: string, thread: Turn[]): Promise<void> {
  const question = thread.at(-1)!
  const reply = (await modelReply(persona, thread)) ?? (await persona.scripted(question.text.toLowerCase()))
  if (question.photoRequest) reply.photo = persona.reference === "CD-420584"
  if (reply.reconnect) await reconnectCar(reference)
  const photoIds: string[] = []
  if (reply.photo) {
    const id = await uploadPublicPhoto(origin, { path: DEMO_PHOTO, orderRef: reference, uploadedBy: persona.driverId, subject: "dashboard", caption: "Photo of the dashboard" })
    if (id) photoIds.push(id)
  }
  await sendDriverMessage(origin, { orderRef: reference, driverId: persona.driverId, text: reply.text, mode: "chat", photoIds })
}

/** One short in-character answer from Claude Haiku 5.5, or null without a key or on any failure. */
async function modelReply(persona: Persona, thread: Turn[]): Promise<Reply | null> {
  const client = llm()
  if (!client) return null
  const question = thread.at(-1)!.text.toLowerCase()
  const facts = await persona.facts()
  // From the driver's side, the agent speaks as "user" and the driver answers as "assistant".
  const messages = thread.slice(-10).map((turn) => ({ role: turn.from === "agent" ? "user" as const : "assistant" as const, content: turn.text }))
  while (messages.length && messages[0].role !== "user") messages.shift()
  if (!messages.length) return null
  try {
    const response = await client.messages.create({
      model: simDriverModel(),
      max_tokens: 400,
      // A short in-character line needs no reasoning; a reasoning model would spend the budget thinking.
      thinking: { type: "disabled" },
      system: [
        "You play a delivery driver in a fictional demo, answering a dispatch assistant in a chat app.",
        "Answer in one or two short, natural sentences, as a driver typing on a phone. Answer only what was asked.",
        "Use only the facts below. If you are asked something they do not cover, say you don't know. Never invent places, codes or times.",
        "If asked for a photo of the dashboard and you can send one, say you are sending it.",
        "",
        "Facts:",
        ...facts.map((fact) => `- ${fact}`),
      ].join("\n"),
      messages,
    })
    if (response.stop_reason === "refusal") return null
    const text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(" ").trim()
    if (!text) return null
    return {
      text,
      photo: persona.reference === "CD-420584" && has(question, "photo", "picture"),
      reconnect: persona.reference === "CD-420322" && has(question, "dongle", "obd", "readout", "connect"),
    }
  } catch (error) {
    console.warn(`[sim driver] model reply failed, using the script: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}
