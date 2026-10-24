"use client"

import { readToolArgument, slotLabel, slotValue, type CallRecord, type CallReview } from "@/lib/present/call-types"
import { labelIn } from "@/lib/present/labels"
import { fmtDateTime } from "@/lib/present/time"
import { Icon } from "../icons"
import "./calls.css"

// The review of a call and what it established, shared by the simulator and the live call screen.

const VERDICT_TONE: Record<CallReview["verdict"], string> = { PASS: "ok", PARTIAL: "warn", FAIL: "danger" }
export const MUST_NOT_WORDS: Record<string, string> = {
  CUSTOMER_DETAILS: "Customer details", PRICES: "Prices", OTHER_ORDERS: "Other orders", MECHANICAL_ADVICE: "Mechanical advice", PROMISE_CHANGES: "Promise changes", CLEARANCE_TO_DRIVE: "Clearance to drive",
}

/** The review of an outbound call, above its transcript: verdict, coverage, forbidden lines, numbers not in the card, closings, turns. */
export function Scorecard({ review, compact = false }: { review: CallReview; compact?: boolean }) {
  return <section className={`scorecard sc-${VERDICT_TONE[review.verdict]}${compact ? " sc-compact" : ""}`} aria-label="Review of the call">
    <header>
      <span className="sc-verdict">{review.verdict}</span>
      <p>{review.summary.replace(/\b[A-Z][A-Z_]{3,}\b/g, (code) => slotLabel(code).toLowerCase())}</p>
    </header>
    <dl className="sc-grid">
      <div><dt>Coverage</dt><dd><b>{review.coverage.answered.length}/{review.coverage.asked.length}</b> asks answered
        {review.coverage.missing.length > 0 && <small>Missing: {review.coverage.missing.map(slotLabel).join(", ")}</small>}</dd></div>
      <div className={review.violations.length ? "sc-bad" : undefined}><dt>Forbidden lines</dt><dd><b>{review.violations.length}</b>{review.violations.length === 0 && <small>None said</small>}</dd></div>
      <div><dt>Numbers not in the card</dt><dd><b>{review.unsupportedNumbers.length}</b>{review.unsupportedNumbers.length === 0 && <small>None</small>}</dd></div>
      <div><dt>Closings</dt><dd><b>{review.closingCount}</b><small>{review.closingCount === 1 ? "Closed once" : review.closingCount === 0 ? "Never closed" : "Closed more than once"}</small></dd></div>
      <div><dt>Turns</dt><dd><b>{review.callerTurns + review.calleeTurns}</b><small>Mira {review.callerTurns} · desk {review.calleeTurns} · {Math.round(review.durationS)} s</small></dd></div>
    </dl>
    {review.violations.length > 0 && <ul className="sc-lines sc-violations" aria-label="Forbidden lines Mira said">{review.violations.map((item, index) => <li key={index}>
      <span className="chip-s s-missed">{MUST_NOT_WORDS[item.kind] ?? labelIn(item.kind)}</span> <a href={`#turn-${item.turnSeq}`}>turn {item.turnSeq}</a>: <q>{item.text}</q>
    </li>)}</ul>}
    {review.unsupportedNumbers.length > 0 && <ul className="sc-lines">{review.unsupportedNumbers.map((item, index) => <li key={index}>
      <span className="chip-s s-unverified">“{item.value}” not in the card</span> <a href={`#turn-${item.turnSeq}`}>turn {item.turnSeq}</a>: <q>{item.text}</q>
    </li>)}</ul>}
  </section>
}

/** What a call established, each claim citing its turn; what it did not; the retry; actions the caller took. */
export function ClaimsList({ call }: { call: CallRecord }) {
  const said = new Set(call.slots.map((slot) => slot.value.slot))
  const missing = (call.brief?.ask ?? []).filter((slot) => !said.has(slot))
  return <>
      <h3>What the call established</h3>
      {call.slots.length === 0 ? <p className="calls-quiet">Nothing was established.</p> : <ul className="slot-list">
        {call.slots.map((slot) => <li key={`${slot.value.slot}-${slot.turnSeq}`}>
          <b>{slotLabel(slot.value.slot)}</b><span className="slot-value">{slotValue(slot.value.value)}</span>
          <a href={`#turn-${slot.turnSeq}`} className="slot-cite"><span className="chip-s s-claim">Claim</span> turn {slot.turnSeq}: <q>{slot.quote}</q></a>
        </li>)}
      </ul>}
      {missing.length > 0 && <>
        <h3>Not established</h3>
        <ul className="slot-missing">{missing.map((slot) => <li key={slot}>{slotLabel(slot)}</li>)}</ul>
      </>}
      {call.retryAfter && <p className="call-retry"><Icon name="waiting" size={13} />Tries again {fmtDateTime(call.retryAfter)}</p>}
      {call.toolCalls.length > 0 && <>
        <h3>Actions the caller took</h3>
        <ul className="slot-list">{call.toolCalls.map((tool, index) => <li key={index} className={tool.name === "ESCALATE_TO_OPERATOR" ? "escalate" : undefined}>
          <b>{tool.name === "ESCALATE_TO_OPERATOR" ? "Handed to an operator" : labelIn(String(tool.name ?? "tool"))}</b>
          {tool.argument ? <span className="slot-value">{readToolArgument(tool.argument)}</span> : null}
          {typeof tool.turnSeq === "number" && <a href={`#turn-${tool.turnSeq}`} className="slot-cite">turn {tool.turnSeq}</a>}
        </li>)}</ul>
      </>}
  </>
}
