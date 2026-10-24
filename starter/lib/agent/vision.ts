// Photos are described by a vision-capable model in a side call and reach the
// agent as text. The agent's own model (DeepSeek through OpenRouter) takes no
// image input: putting the photo into its context ended every later turn of
// the case with a 404, so the picture never enters the main loop.

import { llm, usageCost } from "./client"

/** The model that looks at photos (OpenRouter name). Must accept image input. */
export function visionModel(): string {
  return process.env.VISION_MODEL || "anthropic/claude-haiku-5.5"
}

const INSTRUCTION = `You describe a photo a car-delivery driver sent to the support desk. Say only what is visible: dashboard warning lights (which symbols, lit or flashing if the image shows it, their colour), gauge readings and numbers, damage (where, how large), surroundings (road, hard shoulder, car park, weather, daylight), documents or papers (what kind, legible text). State what cannot be made out. No diagnosis, no advice, no guess at causes. Plain English, at most 120 words, as a flat paragraph.`

type ImageType = "image/jpeg" | "image/png" | "image/gif" | "image/webp"

/** A plain-text description of the photo, or null when no vision model answered. Cost in dollars is returned alongside. */
export async function describePhoto(mediaType: string, base64: string, caption: string | null): Promise<{ text: string; costUsd: number } | null> {
  const client = llm()
  if (!client) return null
  const type = (["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mediaType) ? mediaType : "image/jpeg") as ImageType
  try {
    const message = await client.messages.create({
      // A description needs no reasoning; with thinking on, the model can spend the whole budget thinking and return
      // no text, and the photo reads as "could not be read".
      model: visionModel(), max_tokens: 600, thinking: { type: "disabled" },
      system: INSTRUCTION,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: type, data: base64 } },
        { type: "text", text: caption ? `The driver wrote with it: "${caption}". Describe the photo.` : "Describe the photo." },
      ] }],
    }, { timeout: 60000 })
    const text = message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n").trim()
    return text ? { text, costUsd: usageCost(message.usage) } : null
  } catch (error) {
    console.error("Road Desk photo description failed", error instanceof Error ? error.message : error)
    return null
  }
}
