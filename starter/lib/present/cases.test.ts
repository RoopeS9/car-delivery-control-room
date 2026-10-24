// Presentation-layer tests for the control room (stream B). Pure functions only:
// no database and no model. Run: npm test (from starter/).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import type { Bundle } from "./bundle"
import { plainText, plainTokens } from "./cases"

const bundle = { dir: { title: (id: string) => (id === "ops-shift" ? "Shift lead" : null) } } as unknown as Bundle

describe("code names never reach an operator raw (PLAN rule 5)", () => {
  test("action types and severities read as words", () => {
    assert.equal(plainTokens("the next step is a CONTACT_CUSTOMER proposal about recovery"), "the next step is a customer-contact proposal about recovery")
    assert.equal(plainTokens("P0217 (coolant over-temperature, STOP_NOW)"), "P0217 (coolant over-temperature, stop now)")
  })

  test("a name the agent invents falls back to lower-case words", () => {
    assert.equal(plainTokens("Escalated as SOME_NEW_THING."), "Escalated as some new thing.")
  })

  test("references, codes, zones and booking numbers are left alone", () => {
    const text = "CD-420584 shows P0300 and P0302 on the OBD dongle at 09:01 UTC (11:01 CEST); ferry WBV-FERRY-00584 is booked."
    assert.equal(plainTokens(text), text)
  })

  test("a desk id after a rewritten name still gets the right capitalisation", () => {
    assert.equal(plainText(bundle, "Waiting on ops-shift after CONTACT_CUSTOMER."), "Waiting on the shift lead after customer-contact.")
    assert.equal(plainText(bundle, "ops-shift does this outside the system."), "Shift lead does this outside the system.")
    // BOOK_RECOVERY grows by three letters; the sentence start must still be found after it.
    assert.equal(plainText(bundle, "Then BOOK_RECOVERY. ops-shift does the rest."), "Then recovery-booking. Shift lead does the rest.")
    assert.equal(plainText(bundle, null), null)
  })
})
