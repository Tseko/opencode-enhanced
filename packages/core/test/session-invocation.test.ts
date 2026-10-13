import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionInvocation } from "@opencode-ai/core/session/invocation"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTurn } from "@opencode-ai/core/session/turn"

const sessionID = SessionSchema.ID.make("ses_invocation")
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }
const created = DateTime.makeUnsafe(1)
const ran = DateTime.makeUnsafe(2)
const completed = DateTime.makeUnsafe(3)

const tool = (state: SessionMessage.AssistantTool["state"], time: SessionMessage.AssistantTool["time"] = { created }) =>
  SessionMessage.AssistantTool.make({ type: "tool", id: "call-1", name: "echo", time, state })

const assistant = (content: SessionMessage.AssistantContent[], overrides: Partial<SessionMessage.Assistant> = {}) =>
  SessionMessage.Assistant.make({
    id: SessionMessage.ID.make("msg_invocation"),
    type: "assistant",
    agent: "build",
    model,
    content,
    time: { created },
    ...overrides,
  })

const ledger = (message: SessionMessage.Assistant) => SessionInvocation.of(sessionID, [message])

const running = (structured: Record<string, unknown> = {}, content: SessionMessage.ToolStateRunning["content"] = []) =>
  SessionMessage.ToolStateRunning.make({ status: "running", input: { text: "hi" }, structured, content })

const failed = (message: string) =>
  SessionMessage.ToolStateError.make({
    status: "error",
    input: { text: "hi" },
    error: { type: "unknown", message },
    content: [],
    structured: {},
  })

describe("SessionInvocation.of", () => {
  test("reports streamed and complete arguments before admission", () => {
    expect(
      ledger(assistant([tool(SessionMessage.ToolStatePending.make({ status: "pending", input: "" }))])).map(
        (invocation) => invocation.state,
      ),
    ).toEqual(["arguments_streaming"])
    expect(
      ledger(
        assistant([tool(SessionMessage.ToolStatePending.make({ status: "pending", input: '{"text":"hi"}' }))]),
      ).map((invocation) => invocation.state),
    ).toEqual(["arguments_complete"])
  })

  test("distinguishes an admitted call from one that is durably executing", () => {
    expect(ledger(assistant([tool(running())])).map((invocation) => invocation.state)).toEqual(["authorized"])
    expect(
      ledger(assistant([tool(running({}, [{ type: "text", text: "working" }]))])).map((invocation) => invocation.state),
    ).toEqual(["executing"])
  })

  test("reports a completed call as succeeded", () => {
    const state = SessionMessage.ToolStateCompleted.make({
      status: "completed",
      input: { text: "hi" },
      content: [],
      structured: {},
    })
    expect(ledger(assistant([tool(state, { created, ran, completed })])).map((invocation) => invocation.state)).toEqual(
      ["succeeded"],
    )
  })

  test("reports a tool-authored error as failed, never outcome_unknown", () => {
    expect(ledger(assistant([tool(failed("Command exited with code 1"), { created, ran, completed })])).map((i) => i.state)).toEqual(
      ["failed"],
    )
  })

  test("reports a call that was never admitted as failed even when reconciliation wrote the terminal", () => {
    // A call refused before settlement (step limit, unknown tool) never ran, so its error
    // is known even though the runner authored the message.
    expect(
      ledger(
        assistant([tool(failed(SessionInvocation.INTERRUPTED_REASON), { created, completed })], {
          finish: "error",
          error: { type: "unknown", message: SessionTurn.ORPHANED_REASON },
          time: { created, completed },
        }),
      ).map((invocation) => invocation.state),
    ).toEqual(["failed"])
    expect(ledger(assistant([tool(failed(SessionInvocation.INTERRUPTED_REASON), { created, completed })])).map((i) => i.state)).toEqual(
      ["failed"],
    )
  })

  test("reports a reconciled admitted call as outcome_unknown, so it is never blindly replayed", () => {
    const message = assistant([tool(failed(SessionInvocation.INTERRUPTED_REASON), { created, ran, completed })], {
      finish: "error",
      error: { type: "unknown", message: SessionTurn.ORPHANED_REASON },
      time: { created, completed },
    })
    expect(ledger(message)).toMatchObject([
      {
        identity: { sessionID, assistantMessageID: message.id, callID: "call-1", logicalAttempt: 1 },
        tool: "echo",
        state: "outcome_unknown",
      },
    ])
  })

  test("reports a reconciled call from a cancelled turn as cancelled", () => {
    const message = assistant([tool(failed(SessionInvocation.INTERRUPTED_REASON), { created, ran, completed })], {
      finish: "error",
      error: { type: "unknown", message: SessionTurn.INTERRUPTED_REASON },
      time: { created, completed },
    })
    expect(ledger(message).map((invocation) => invocation.state)).toEqual(["cancelled"])
  })

  test("treats a pipeline failure as an unknown outcome and a tool result as known", () => {
    expect(
      ledger(
        assistant([tool(failed(`${SessionInvocation.EXECUTION_FAILED_PREFIX}boom`), { created, ran, completed })]),
      ).map((invocation) => invocation.state),
    ).toEqual(["outcome_unknown"])
    expect(
      ledger(
        assistant([
          tool(
            SessionMessage.ToolStateError.make({
              status: "error",
              input: { text: "hi" },
              error: { type: "unknown", message: "Denied by policy" },
              content: [],
              structured: {},
            }),
            { created, ran, completed },
          ),
        ]),
      ).map((invocation) => invocation.state),
    ).toEqual(["failed"])
  })

  test("keys the identity tuple stably and ignores non-tool content", () => {
    const message = assistant([
      SessionMessage.AssistantText.make({ type: "text", id: "text-1", text: "hello" }),
      tool(running()),
    ])
    const [invocation] = ledger(message)
    expect(invocation && SessionInvocation.key(invocation.identity)).toBe(`${sessionID}:${message.id}:call-1:1`)
    expect(SessionInvocation.Terminals.has(invocation?.state ?? "authorized")).toBe(false)
  })
})
