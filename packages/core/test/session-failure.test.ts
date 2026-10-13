import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionFailure } from "@opencode-ai/core/session/failure"
import { SessionMessage } from "@opencode-ai/core/session/message"

const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }
const created = DateTime.makeUnsafe(1)
const completed = DateTime.makeUnsafe(2)
const nextID = (() => {
  let index = 0
  return () => SessionMessage.ID.make(`msg_failure_${index++}`)
})()

const user = (text: string) =>
  SessionMessage.User.make({ id: nextID(), type: "user", text, time: { created } })

const failed = (message: string) =>
  SessionMessage.Assistant.make({
    id: nextID(),
    type: "assistant",
    agent: "build",
    model,
    content: [],
    finish: "error",
    error: { type: "unknown", message },
    time: { created, completed },
  })

const completedTurn = () =>
  SessionMessage.Assistant.make({
    id: nextID(),
    type: "assistant",
    agent: "build",
    model,
    content: [],
    finish: "stop",
    time: { created, completed },
  })

describe("SessionFailure", () => {
  test("unifies volatile tokens so attempts share one fingerprint", () => {
    const first = SessionFailure.signature(
      "Rate limit reached for gpt-x in organization org-test on tokens per min (TPM): Limit 500000, " +
        "Used 453487, Requested 81138. Please try again in 4.155s. id=chatcmpl-abc123def",
    )
    const second = SessionFailure.signature(
      "Rate limit reached for gpt-x in organization org-test on tokens per min (TPM): Limit 499999, " +
        "Used 453000, Requested 81000. Please try again in 12s. id=chatcmpl-zzz999qqq",
    )
    const third = SessionFailure.signature(
      "Rate limit reached for gpt-x in organization org-test on tokens per min (TPM): Limit 500000, " +
        "Used 453487, Requested 81138. Please try again in 4.155s. id=chatcmpl-abc123def",
    )
    expect(second).toBe(first)
    expect(third).toBe(first)
    expect(SessionFailure.signature("2026-09-22T10:11:12.123Z upload failed")).toBe(
      SessionFailure.signature("2026-09-22T11:12:13.456Z upload failed"),
    )
    expect(SessionFailure.signature("2026-09-22T10:11:12.123Z upload failed")).not.toBe(
      SessionFailure.signature("2026-09-22T10:11:12.123Z download failed"),
    )
    expect(SessionFailure.signature("Provider request failed with HTTP 503")).not.toBe(
      SessionFailure.signature("Insufficient quota"),
    )
  })

  test("counts identical failures only while the input stays the same", () => {
    const messages = [user("Deploy the fix"), failed("Rate limit reached"), failed("Rate limit reached")]
    expect(SessionFailure.streak(messages, "Rate limit reached")).toBe(2)
    // A new prompt is the clear path: accounting is scoped to one input.
    expect(SessionFailure.streak([...messages, user("Try again")], "Rate limit reached")).toBe(0)
    // A different failure class ends the streak.
    expect(SessionFailure.streak([...messages, failed("Insufficient quota")], "Rate limit reached")).toBe(0)
    // A turn that did not fail ends the streak.
    expect(SessionFailure.streak([...messages, completedTurn()], "Rate limit reached")).toBe(0)
  })

  test("reports a quarantined input at the policy threshold", () => {
    const failure = failed("Provider request failed with HTTP 503")
    expect(SessionFailure.account([user("Fix the build")])).toMatchObject({ failures: 0, quarantined: false })
    expect(SessionFailure.account([user("Fix the build"), failure, failure, failure])).toMatchObject({
      failures: SessionFailure.MAX_IDENTICAL_FAILURES,
      threshold: SessionFailure.MAX_IDENTICAL_FAILURES,
      quarantined: true,
    })
    expect(
      SessionFailure.account([user("Fix the build"), failure, failure, failure, user("Continue")]),
    ).toMatchObject({ failures: 0, quarantined: false })
  })
})
