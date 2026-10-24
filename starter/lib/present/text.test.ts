// Tests for the operator-facing text helpers (stream B). Pure, no database.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { blocksOf } from "./text"

describe("the agent's light markdown becomes plain data for React", () => {
  test("paragraphs, bullets and bold", () => {
    const blocks = blocksOf("The promise is **Mon 26 Oct**. The customer set it.\n\n- **Requested:** Tue 27 Oct, a wish.\n- Ferry: booked.\n\nLeo's reply is due.")
    assert.deepEqual(blocks.map((block) => block.type), ["p", "ul", "p"])
    assert.deepEqual(blocks[0], { type: "p", runs: [{ text: "The promise is " }, { text: "Mon 26 Oct", bold: true }, { text: ". The customer set it." }] })
    const list = blocks[1]
    assert.equal(list.type === "ul" && list.items.length, 2)
    assert.deepEqual(list.type === "ul" && list.items[0], [{ text: "Requested:", bold: true }, { text: " Tue 27 Oct, a wish." }])
  })

  test("a line that starts with bold is not mistaken for a bullet", () => {
    const [block] = blocksOf("**Note:** the car is stopped.")
    assert.equal(block.type, "p")
  })

  test("lines of one paragraph are joined, and html stays text", () => {
    const [block] = blocksOf("first line\nsecond <b>line</b>")
    assert.deepEqual(block, { type: "p", runs: [{ text: "first line second <b>line</b>" }] })
  })

  test("nothing in, nothing out", () => {
    assert.deepEqual(blocksOf(""), [])
    assert.deepEqual(blocksOf("\n  \n"), [])
  })
})
