import { expect, test } from "bun:test"
import { DateTime, Effect, Stream } from "effect"
import { LLM, LLMEvent, Message, Model } from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSchema } from "@opencode-ai/core/session/schema"

test("compaction prompt preserves detailed work state and relevant files", () => {
  const prompt = SessionCompaction.buildPrompt({ context: ["conversation history"] })

  expect(prompt).toStartWith(
    "Here is the conversation so far:\n\n<conversation>\nconversation history\n</conversation>",
  )
  expect(prompt.indexOf("</conversation>")).toBeLessThan(prompt.indexOf("Create a new anchored summary"))
  expect(prompt).toContain("conversation history in the <conversation> tags above")
  expect(prompt).toContain("## Work State\n### Completed")
  expect(prompt).toContain("### Active")
  expect(prompt).toContain("### Blocked")
  expect(prompt).toContain("## Relevant Files")
})

test("compaction prompt gives update instructions for a prior summary", () => {
  const prompt = SessionCompaction.buildPrompt({
    context: ["new conversation"],
    previousSummary: "existing summary",
  })

  expect(prompt.indexOf("<conversation>")).toBeLessThan(prompt.indexOf("<prior-summary>"))
  expect(prompt.indexOf("</prior-summary>")).toBeLessThan(prompt.indexOf("The <prior-summary> summarizes"))
  expect(prompt).toContain(
    "Carry forward objectives, constraints, user directives, decisions, and parallel workstreams from the <prior-summary>",
  )
  expect(prompt).toContain('Move completed work from "Active" to "Completed".')
  expect(prompt).toContain('Update "Objective" and "Next Move" to reflect the current work state.')
})

test("compaction describes tool media without embedding base64", () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
  const serialized = SessionCompaction.serializeToolContent([
    { type: "text", text: "Image read successfully" },
    {
      type: "file",
      uri: `data:image/png;base64,${base64}`,
      mime: "image/png",
      name: "pixel.png",
    },
  ])

  expect(serialized).toBe("Image read successfully\n[Attached image/png: pixel.png]")
  expect(serialized).not.toContain(base64)
})

const created = DateTime.makeUnsafe(0)
const id = (value: string) => SessionMessage.ID.make(`msg_${value}`)
const huge = "x".repeat(200_000)

const user = (value: string) =>
  SessionMessage.User.make({
    id: id(value),
    type: "user",
    text: value,
    time: { created },
  })

const assistantTool = (input: { id: string; name: string; output: string; executed?: boolean }) =>
  SessionMessage.Assistant.make({
    id: id(input.id),
    type: "assistant",
    agent: "build",
    model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
    content: [
      SessionMessage.AssistantTool.make({
        type: "tool",
        id: input.id,
        name: input.name,
        ...(input.executed ? { provider: { executed: true } } : {}),
        state: SessionMessage.ToolStateCompleted.make({
          status: "completed",
          input: {},
          content: [{ type: "text", text: input.output }],
          structured: {},
        }),
        time: { created, completed: created },
      }),
    ],
    time: { created, completed: created },
  })

const history = (tool: { id: string; name: string; output: string; executed?: boolean }) => [
  user("first"),
  assistantTool(tool),
  user("second"),
  user("third"),
]

test("prunes old tool output beyond the protected tail", () => {
  const pruned = SessionCompaction.pruneToolOutput(history({ id: "bash", name: "bash", output: huge }))
  expect(pruned[1]).toMatchObject({
    type: "assistant",
    content: [
      {
        type: "tool",
        id: "bash",
        state: {
          status: "completed",
          content: [{ type: "text", text: SessionCompaction.PRUNED_TOOL_RESULT }],
        },
      },
    ],
  })
})

test("keeps recent tool output and protected skill output", () => {
  const recent = [
    user("first"),
    assistantTool({ id: "recent", name: "bash", output: huge }),
    user("second"),
  ]
  expect(SessionCompaction.pruneToolOutput(recent)).toBe(recent)

  const skill = history({ id: "skill", name: "skill", output: huge })
  expect(SessionCompaction.pruneToolOutput(skill)).toBe(skill)
})

test("does not prune provider-executed tool results", () => {
  const hosted = history({ id: "hosted", name: "web_search", output: huge, executed: true })
  expect(SessionCompaction.pruneToolOutput(hosted)).toBe(hosted)
})

test("does not prune when the reclaimable output is below the minimum", () => {
  const small = history({ id: "bash", name: "bash", output: "ok" })
  expect(SessionCompaction.pruneToolOutput(small)).toBe(small)
})

// A JSON-heavy payload where the character estimator is far above the real token count.
const structural = (length: number) => "{".repeat(length)

const assistantCounted = (input: { id: string; text: string; read: number }) =>
  SessionMessage.Assistant.make({
    id: id(input.id),
    type: "assistant",
    agent: "build",
    model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
    content: [SessionMessage.AssistantText.make({ type: "text", id: `${input.id}-text`, text: input.text })],
    tokens: { input: 10, output: 20, reasoning: 0, cache: { read: input.read, write: 0 } },
    time: { created, completed: created },
  })

test("compaction reserves a bounded output window, not the catalog maximum", () => {
  expect(SessionCompaction.reserve({ limits: { output: 384_000 } })).toBe(32_000)
  expect(SessionCompaction.reserve({ limits: { output: 8_192 } })).toBe(8_192)
  expect(SessionCompaction.reserve({ limits: { output: 384_000 }, requested: 4_096 })).toBe(4_096)
  expect(SessionCompaction.reserve({})).toBe(32_000)
})

test("request tokens anchor on reported usage instead of the whole-request estimate", () => {
  const entries = [
    { seq: 1, message: user("first") },
    { seq: 2, message: assistantCounted({ id: "counted", text: structural(700_000), read: 300_000 }) },
  ]
  const request = { system: [], messages: [Message.user(structural(700_000))], tools: [] }

  // 300,030 counted tokens; the raw estimator over the same content is > 700,000.
  expect(SessionCompaction.requestTokens({ entries, request })).toBe(300_030)
})

test("request tokens fall back to the estimator before any turn is counted", () => {
  const entries = [{ seq: 1, message: user("first") }]
  const request = { system: [], messages: [Message.user(structural(700_000))], tools: [] }

  expect(SessionCompaction.requestTokens({ entries, request })).toBeGreaterThan(700_000)
})

const deepseek = Model.make({
  id: "deepseek-flash",
  provider: "deepseek",
  route: OpenAIChat.route.with({ limits: { context: 1_000_000, output: 384_000 } }),
})

const compactionService = (state: { starts: number; published: unknown[] }) =>
  SessionCompaction.make({
    events: {
      publish: (_schema: unknown, event: unknown) =>
        Effect.sync(() => {
          state.published.push(event)
        }),
    } as unknown as EventV2.Interface,
    llm: {
      stream: () => {
        state.starts++
        return Stream.fromIterable([LLMEvent.textDelta({ id: "summary", text: "## Objective\n- summary" })])
      },
    },
    config: [],
  })

const compactionInput = (input: { read: number }) => ({
  sessionID: SessionSchema.ID.make("ses_budget"),
  entries: [
    { seq: 1, message: user("first") },
    { seq: 2, message: assistantCounted({ id: "counted", text: structural(700_000), read: input.read }) },
  ],
  model: deepseek,
  request: LLM.request({
    model: deepseek,
    messages: [Message.user(structural(700_000))],
    tools: [],
  }),
})

test("auto-compaction does not fire while reported usage is inside the window", async () => {
  const state = { starts: 0, published: [] as unknown[] }

  const compacted = await Effect.runPromise(compactionService(state).compactIfNeeded(compactionInput({ read: 300_000 })))

  // 300,030 reported tokens against a 1,000,000 window minus a 32,000 reserve. The old
  // budget (context minus the catalog's 384,000 max output, measured with the raw estimator)
  // compacted here even though only 30 % of the window was in use.
  expect(compacted).toBe(false)
  expect(state.starts).toBe(0)
})

test("auto-compaction fires once reported usage passes the reserved window", async () => {
  const state = { starts: 0, published: [] as unknown[] }

  const compacted = await Effect.runPromise(compactionService(state).compactIfNeeded(compactionInput({ read: 980_000 })))

  expect(compacted).toBe(true)
  expect(state.starts).toBe(1)
  expect(state.published).toEqual([
    expect.objectContaining({ reason: "auto" }),
    expect.objectContaining({ reason: "auto", text: "## Objective\n- summary" }),
  ])
  // The newest turn alone exceeds the keep budget and is retained whole rather than summarized
  // away: dropping it would lose the request the model is about to answer.
  expect(state.published[1]).toMatchObject({ recent: expect.stringContaining(structural(700_000)) })
})

const compactionEntry = (input: { summary: string; recent: string }) =>
  SessionMessage.Compaction.make({
    id: id("prior-compaction"),
    type: "compaction",
    reason: "auto",
    summary: input.summary,
    recent: input.recent,
    time: { created },
  })

test("auto-compaction does not re-summarize a conversation that only has the retained tail", async () => {
  const state = { starts: 0, published: [] as unknown[] }

  // Reported usage is over budget, but the whole conversation already sits inside the retained
  // tail, so the over-budget part is system/tool content that compaction cannot shrink. Firing
  // here would re-summarize the prior summary on every turn without reducing the request.
  const compacted = await Effect.runPromise(
    compactionService(state).compactIfNeeded({
      sessionID: SessionSchema.ID.make("ses_tail_only"),
      entries: [
        { seq: 1, message: compactionEntry({ summary: "## Objective\n- earlier", recent: "prior recent" }) },
        { seq: 2, message: user("continue") },
        { seq: 3, message: assistantCounted({ id: "counted", text: "recent reply", read: 980_000 }) },
      ],
      model: deepseek,
      request: LLM.request({ model: deepseek, messages: [Message.user("continue")], tools: [] }),
    }),
  )

  expect(compacted).toBe(false)
  expect(state.starts).toBe(0)
  expect(state.published).toEqual([])
})
