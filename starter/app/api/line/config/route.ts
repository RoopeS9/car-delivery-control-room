import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"

/** The phone contact that places Road Desk's calls. There is one: roaddesk, the turn-based line (Whisper, the dossier model, ElevenLabs). */
export function GET() {
  return NextResponse.json({ caller: "roaddesk" })
}
