import assert from "node:assert/strict"
import { test } from "node:test"
import { beginRuntimeReset, beginRuntimeWork, isResetting, RuntimeBusyError, withRuntimeWork } from "./activity"

test("queued work blocks reset before its deferred callback starts", () => {
  const release = beginRuntimeWork("queued scenario actions")
  try { assert.throws(beginRuntimeReset, (error: unknown) => error instanceof RuntimeBusyError && error.status === 409 && error.message.includes("Nothing was cleared")) }
  finally { release() }
  const finishReset = beginRuntimeReset()
  finishReset()
})

test("a claimed reset blocks new work and another reset until it finishes", () => {
  const finishReset = beginRuntimeReset()
  try {
    assert.equal(isResetting(), true)
    assert.throws(() => beginRuntimeWork("driver call"), RuntimeBusyError)
    assert.throws(beginRuntimeReset, RuntimeBusyError)
  } finally { finishReset() }
  assert.equal(isResetting(), false)
})

test("a rejected task releases its work token, and repeated release is harmless", async () => {
  await assert.rejects(withRuntimeWork("agent work", async () => { throw new Error("task failed") }), /task failed/)
  const release = beginRuntimeWork("call")
  release(); release()
  const finishReset = beginRuntimeReset()
  finishReset()
})

test("reset stays blocked until every independently queued task finishes", () => {
  const finishOne = beginRuntimeWork("queued scenario actions")
  const finishTwo = beginRuntimeWork("agent work")
  finishOne()
  assert.throws(beginRuntimeReset, RuntimeBusyError)
  finishTwo()
  const finishReset = beginRuntimeReset()
  finishReset()
})


test("a repeated release from an earlier reset cannot unlock a later reset", () => {
  const earlier = beginRuntimeReset()
  earlier()
  const current = beginRuntimeReset()
  try { earlier(); assert.equal(isResetting(), true) }
  finally { current() }
})
