// Pure text helpers for operator-facing words. No Node imports, so client
// components can use them too.

/**
 * How a code-style name reads in a sentence ("a CONTACT_CUSTOMER proposal"). Anything not listed
 * falls back to lower-case words, so a name the agent invents never reaches an operator raw.
 */
const TOKEN_WORDS: Record<string, string> = {
  CONTACT_CUSTOMER: "customer-contact", CONTACT_SITE_AS_CUSTOMER: "site-contact", UPDATE_ETA: "ETA-update",
  CHANGE_PROMISE: "promise-change", BOOK_RECOVERY: "recovery-booking", BOOK_TRAVEL: "travel-booking",
  APPROVE_EXPENSE: "expense", REASSIGN_DRIVER: "driver-reassignment", CLEAR_TO_CONTINUE: "drive-on clearance",
  STOP_NOW: "stop now", DRIVE_TO_SAFE_STOP: "drive to a safe stop", CONTINUE_AND_MONITOR: "continue and monitor",
}

/** Record states an agent copies in capitals ("BOOKED", "UNCONFIRMED"); they read as words. */
const STATE_WORDS = new Set(["BOOKED", "UNCONFIRMED", "CONFIRMED", "PENDING", "CANCELLED", "ASSIGNED", "COMPLETED", "DELIVERED",
  "RESOLVED", "REQUIRED", "SUBMITTED", "APPROVED", "REJECTED", "EXECUTED", "PROPOSED", "VERIFIED", "UNVERIFIED", "PLANNED"])

export function plainTokens(text: string): string {
  return text
    // A record cited by table and id ("travel_reservations res-x6196641f25ccf47f, ferry booking …"): keep the label.
    .replace(/\b[a-z]+(?:_[a-z]+)+\s+[a-z]{2,6}-x?[0-9a-f]{8,}\b,?\s*/g, "")
    // A bare record id ("res-x6196641f25ccf47f", "evt-be7ecfccabd3") means nothing to a person.
    .replace(/\s*\(?\b[a-z]{2,6}-x?[0-9a-f]{10,}\b\)?/g, "")
    .replace(/\b[A-Z]{2,}(?:_[A-Z0-9]+)+\b/g, (token) => TOKEN_WORDS[token] ?? token.toLowerCase().replace(/_/g, " "))
    .replace(/\b[A-Z]{6,}\b/g, (word) => (STATE_WORDS.has(word) ? word.toLowerCase() : word))
}

export type Run = { text: string; bold?: boolean }
export type Block = { type: "p"; runs: Run[] } | { type: "ul"; items: Run[][] }

function runsOf(line: string): Run[] {
  const runs: Run[] = []
  let last = 0
  for (const match of line.matchAll(/\*\*(.+?)\*\*/g)) {
    const at = match.index ?? 0
    if (at > last) runs.push({ text: line.slice(last, at) })
    runs.push({ text: match[1], bold: true })
    last = at + match[0].length
  }
  if (last < line.length) runs.push({ text: line.slice(last) })
  return runs
}

/**
 * The agent answers in light markdown: paragraphs, "- " bullets and **bold**. Nothing else is
 * interpreted (backticks, heading marks and "---" lines are dropped), and the result is plain data for React to
 * render, never HTML.
 */
export function blocksOf(text: string): Block[] {
  const blocks: Block[] = []
  let paragraph: string[] = []
  let list: Run[][] | null = null
  const endParagraph = () => { if (paragraph.length) blocks.push({ type: "p", runs: runsOf(paragraph.join(" ")) }); paragraph = [] }
  const endList = () => { if (list) blocks.push({ type: "ul", items: list }); list = null }
  for (const raw of text.split("\n")) {
    // Inline code, heading marks and separator lines are markup the agent sometimes writes; people read the words.
    const line = raw.trim().replace(/`([^`]+)`/g, "$1")
    if (/^([-*_])\1{2,}$/.test(line)) { endParagraph(); endList(); continue }
    const heading = /^#{1,6}\s+(.+)$/.exec(line)
    if (heading) { endParagraph(); endList(); blocks.push({ type: "p", runs: [{ text: heading[1].replace(/\*\*/g, ""), bold: true }] }); continue }
    const bullet = /^[-*•]\s+(.+)$/.exec(line)
    if (!line) { endParagraph(); endList(); continue }
    if (bullet) { endParagraph(); (list ??= []).push(runsOf(bullet[1])); continue }
    endList()
    paragraph.push(line)
  }
  endParagraph()
  endList()
  return blocks
}

/** One skimmable line from a longer answer: markup removed, bullets joined, cut at a word. */
export function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\*\*/g, "").replace(/\s*\n\s*[-*•]\s+/g, " · ").replace(/\s+/g, " ").trim()
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max)
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), max / 2)).replace(/[\s,;:·-]+$/, "") + "…"
}
