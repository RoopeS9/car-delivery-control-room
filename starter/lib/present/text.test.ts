// Tests for the operator-facing text helpers (stream B). Pure, no database.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { blocksOf, oneLine } from "./text"

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
    assert.deepEqual(blocksOf("Here it is:\n\n---\n\n## Next\nA `promise-change` card."), [
      { type: "p", runs: [{ text: "Here it is:" }] }, { type: "p", runs: [{ text: "Next", bold: true }] }, { type: "p", runs: [{ text: "A promise-change card." }] },
    ])
    assert.deepEqual(blocksOf("\n  \n"), [])
  })
})

describe("one skimmable line for the activity log", () => {
  test("markup is removed and bullets are joined", () => {
    assert.equal(oneLine("**Ferry** is booked.\n- Check-in 17:30\n- Departs 19:30"), "Ferry is booked. · Check-in 17:30 · Departs 19:30")
  })

  test("a long answer is cut at a word, with an ellipsis", () => {
    const line = oneLine("word ".repeat(100), 50)
    assert.ok(line.length <= 51 && line.endsWith("…") && !line.includes("  "), line)
  })

  test("a short line is left alone", () => {
    assert.equal(oneLine("Asked the driver for a photo."), "Asked the driver for a photo.")
  })
})
