import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionTurn } from "@opencode-ai/core/session/turn"

const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }
const created = DateTime.makeUnsafe(1)
const completed = DateTime.makeUnsafe(2)

const assistant = (overrides: Partial<SessionMessage.Assistant> = {}) =>
  SessionMessage.Assistant.make({
    id: SessionMessage.ID.make("msg_turn"),
    type: "assistant",
    agent: "build",
    model,
    content: [],
    time: { created },
    ...overrides,
  })

const stateOf = (message: SessionMessage.Assistant) =>
  SessionTurn.of([message]).map((turn) => turn.state)

describe("SessionTurn.of", () => {
  test("reports an unfinished assistant as a running turn", () => {
    expect(stateOf(assistant())).toEqual(["running"])
  })

  test("reports a settled assistant as completed", () => {
    expect(stateOf(assistant({ finish: "stop", time: { created, completed } }))).toEqual(["completed"])
  })

  test("reports a provider or tool failure as failed", () => {
    expect(
      stateOf(
        assistant({
          finish: "error",
          error: { type: "unknown", message: "Provider unavailable" },
          time: { created, completed },
        }),
      ),
    ).toEqual(["failed"])
  })

  test("reports an interrupted turn as cancelled, not failed", () => {
    expect(
      stateOf(
        assistant({
          finish: "error",
          error: { type: "unknown", message: SessionTurn.INTERRUPTED_REASON },
          time: { created, completed },
        }),
      ),
    ).toEqual(["cancelled"])
  })

  test("never reports a turn closed without a finish as completed", () => {
    // Superseded or interrupted turns are closed without a terminal finish; missing
    // completion data is not evidence of completion.
    expect(stateOf(assistant({ time: { created, completed } }))).toEqual(["failed"])
  })

  test("ignores non-assistant messages and keeps the session order", () => {
    const user = SessionMessage.User.make({
      id: SessionMessage.ID.make("msg_user"),
      type: "user",
      text: "hello",
      time: { created },
    })
    expect(
      SessionTurn.of([user, assistant({ finish: "stop", time: { created, completed } })]).map((turn) => turn.state),
    ).toEqual(["completed"])
  })

  test("counts only tools without a durable terminal", () => {
    const tool = (id: string, state: SessionMessage.AssistantTool["state"]) =>
      SessionMessage.AssistantTool.make({ type: "tool", id, name: "echo", time: { created }, state })
    const turns = SessionTurn.of([
      assistant({
        content: [
          tool("call-pending", SessionMessage.ToolStatePending.make({ status: "pending", input: "" })),
          tool("call-running", SessionMessage.ToolStateRunning.make({ status: "running", input: {}, structured: {}, content: [] })),
          tool(
            "call-done",
            SessionMessage.ToolStateCompleted.make({
              status: "completed",
              input: {},
              content: [],
              structured: {},
            }),
          ),
          tool(
            "call-failed",
            SessionMessage.ToolStateError.make({
              status: "error",
              input: {},
              error: { type: "unknown", message: "Denied" },
              content: [],
              structured: {},
            }),
          ),
        ],
      }),
    ])
    expect(turns.map((turn) => turn.unsettledTools)).toEqual([2])
  })
})
