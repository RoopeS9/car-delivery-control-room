import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"

/** Which phone contact places Road Desk's calls: LINE_CALLER, default roaddesk (turn-based); voicechat stays selectable. */
export function GET() {
  const caller = process.env.LINE_CALLER === "voicechat" ? "voicechat" : "roaddesk"
  return NextResponse.json({ caller, callers: ["roaddesk", "voicechat"] })
}
