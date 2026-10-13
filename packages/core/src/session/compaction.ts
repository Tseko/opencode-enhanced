export * as SessionCompaction from "./compaction"

import { LLM, LLMError, LLMEvent, Message, type LLMRequest, type Model } from "@opencode-ai/llm"
import { DateTime, Effect, Stream } from "effect"
import type { Config } from "../config"
import type { EventV2 } from "../event"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { Token } from "../util/token"

const DEFAULT_BUFFER = 20_000
const DEFAULT_OUTPUT_RESERVE = 32_000
const DEFAULT_KEEP_TOKENS = 8_000
export const TOOL_OUTPUT_MAX_CHARS = 2_000
export const PRUNE_MINIMUM = 20_000
export const PRUNE_PROTECT = 40_000
export const PRUNED_TOOL_RESULT = "[Old tool result content cleared]"
const PRUNE_PROTECTED_TOOLS = new Set(["skill"])
const SUMMARY_OUTPUT_TOKENS = 4_096
const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Important Details
- [constraints/preferences, decisions and why, important facts/assumptions, exact context needed to continue, or "(none)"]

## Work State
### Completed
- [finished work, verified facts, or changes made; otherwise "(none)"]

### Active
- [current work, partial changes, or investigation state; otherwise "(none)"]

### Blocked
- [blockers, failing commands, or unknowns; otherwise "(none)"]

## Next Move
1. [immediate concrete action, or "(none)"]
2. [next action if known, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers when known.
- Do not mention the summary process or that context was compacted.`
const SUMMARY_UPDATE_INSTRUCTIONS = `The <prior-summary> summarizes everything that happened before the <conversation>. Construct a new summary that combines both. The <prior-summary> is discarded after this: anything you do not carry into the new summary is lost.

When combining:
- Carry forward objectives, constraints, user directives, decisions, and parallel workstreams from the <prior-summary> even when the <conversation> does not mention them. Drop only what is finished and no longer needed.
- The <conversation> is more recent than the <prior-summary>. Where they conflict, the conversation wins: state the corrected fact and drop the old claim.
- Add new progress, decisions, constraints, and context from the conversation.
- Move completed work from "Active" to "Completed".
- If a blocker has been resolved, update the summary to reflect that while keeping any details still needed to continue the work.
- Update "Objective" and "Next Move" to reflect the current work state.`

type Entry = {
  readonly seq: number
  readonly message: SessionMessage.Message
}

type Settings = {
  readonly auto: boolean
  readonly prune: boolean
  readonly buffer: number
  readonly tokens: number
}

type Dependencies = {
  readonly events: EventV2.Interface
  readonly llm: {
    readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>
  }
  readonly config: readonly Config.Entry[]
}

type Input = {
  readonly sessionID: SessionSchema.ID
  readonly entries: readonly Entry[]
  readonly model: Model
  readonly request: LLMRequest
}

const estimate = (value: unknown) => Token.estimate(JSON.stringify(value))

export const truncateOutput = (value: string) =>
  value.length <= TOOL_OUTPUT_MAX_CHARS ? value : `${value.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n[truncated]`

export const serializeToolContent = (content: SessionMessage.ToolStateCompleted["content"]) =>
  content
    .map((item) =>
      item.type === "text" ? item.text : `[Attached ${item.mime}${item.name === undefined ? "" : `: ${item.name}`}]`,
    )
    .join("\n")

const serialize = (message: SessionMessage.Message) => {
  if (message.type === "user") {
    const files = message.files?.map((file) => `[Attached ${file.mime}: ${file.name ?? file.uri}]`) ?? []
    return [`[User]: ${message.text}`, ...files].join("\n")
  }
  if (message.type === "assistant") {
    return message.content
      .flatMap((part) => {
        if (part.type === "text") return [`[Assistant]: ${part.text}`]
        if (part.type === "reasoning") return part.text ? [`[Assistant reasoning]: ${part.text}`] : []
        const input = typeof part.state.input === "string" ? part.state.input : JSON.stringify(part.state.input)
        if (part.state.status === "completed")
          return [
            `[Assistant tool call]: ${part.name}(${input})`,
            `[Tool result]: ${part.time.pruned ? PRUNED_TOOL_RESULT : truncateOutput(serializeToolContent(part.state.content))}`,
          ]
        if (part.state.status === "error")
          return [`[Assistant tool call]: ${part.name}(${input})`, `[Tool error]: ${part.state.error.message}`]
        return [`[Assistant tool call]: ${part.name}(${input})`]
      })
      .join("\n")
  }
  if (message.type === "system") return `[System update]: ${message.text}`
  if (message.type === "synthetic") return `[Synthetic context]: ${message.text}`
  if (message.type === "shell") return `[Shell]: ${message.command}\n${truncateOutput(message.output)}`
  return ""
}

const settings = (documents: readonly Config.Entry[]) => {
  const configured = documents
    .filter((entry): entry is Config.Document => entry.type === "document")
    .flatMap((entry) => (entry.info.compaction ? [entry.info.compaction] : []))
  return configured.reduce<Settings>(
    (result, current) => ({
      auto: current.auto ?? result.auto,
      prune: current.prune ?? result.prune,
      buffer: current.buffer ?? result.buffer,
      tokens: current.keep?.tokens ?? result.tokens,
    }),
    { auto: true, prune: false, buffer: DEFAULT_BUFFER, tokens: DEFAULT_KEEP_TOKENS },
  )
}

/**
 * Tokens to leave free for the response.
 *
 * The runner does not request a generation budget, so the catalog's *maximum* output is not a
 * real reserve: reserving it (384k for `deepseek/deepseek-flash`, 38 % of a 1M window) discards
 * most of the advertised context. Reserve the requested budget when there is one, otherwise the
 * smaller of the catalog maximum and a bounded default.
 */
export const reserve = (input: { readonly limits?: { readonly output?: number }; readonly requested?: number }) => {
  const bounded = Math.min(input.limits?.output ?? DEFAULT_OUTPUT_RESERVE, DEFAULT_OUTPUT_RESERVE)
  return input.requested !== undefined && input.requested > 0 ? input.requested : bounded
}

const counted = (message: SessionMessage.Message) =>
  message.type !== "assistant" || message.tokens === undefined
    ? undefined
    : message.tokens.input + message.tokens.output + message.tokens.cache.read + message.tokens.cache.write

/**
 * Tokens the request is expected to occupy.
 *
 * A reported usage count from the last assistant turn anchors the measurement: `Token.estimate`
 * charges one token per JSON structural character and over-counts real message JSON by ~2.5x
 * (measured against a live session), so it is applied only to what was added after that
 * counted turn — tool results and newer messages. The result stays conservative on the growth
 * while no longer being ~2.5x pessimistic on the dominant part of the request. A turn whose
 * response the provider did not count falls back to estimating the whole request.
 */
export const requestTokens = (input: {
  readonly entries: readonly { readonly seq: number; readonly message: SessionMessage.Message }[]
  readonly request: Pick<LLMRequest, "system" | "messages" | "tools">
}) => {
  const anchor = input.entries.findLast((entry) => counted(entry.message) !== undefined)
  if (anchor === undefined)
    return estimate({ system: input.request.system, messages: input.request.messages, tools: input.request.tools })
  const growth = input.entries
    .filter((entry) => entry.seq >= anchor.seq)
    .flatMap((entry) => {
      const message = entry.message
      if (message.type !== "assistant") return [serialize(message)]
      if (entry === anchor) return toolResults(message)
      return [serialize(message)]
    })
    .join("\n")
  return counted(anchor.message)! + Token.estimate(growth)
}

const toolResults = (message: SessionMessage.Assistant) =>
  message.content.flatMap((part) =>
    part.type === "tool" && part.state.status === "completed" ? [serializeToolContent(part.state.content)] : [],
  )

export const pruneToolOutput = (messages: readonly SessionMessage.Message[]) => {
  const toPrune = selectPrunedToolIDs(messages)
  if (toPrune.size === 0) return messages
  return messages.map((message) => {
    if (message.type !== "assistant") return message
    if (!message.content.some((part) => part.type === "tool" && toPrune.has(part.id))) return message
    return SessionMessage.Assistant.make({
      ...message,
      content: message.content.map((part) => {
        if (part.type !== "tool" || !toPrune.has(part.id) || part.state.status !== "completed") return part
        return SessionMessage.AssistantTool.make({
          ...part,
          time: { ...part.time, pruned: part.time.pruned ?? part.time.completed ?? part.time.created },
          state: SessionMessage.ToolStateCompleted.make({
            status: "completed",
            input: part.state.input,
            content: [{ type: "text", text: PRUNED_TOOL_RESULT }],
            structured: {},
          }),
        })
      }),
    })
  })
}

const selectPrunedToolIDs = (messages: readonly SessionMessage.Message[]) => {
  let total = 0
  let pruned = 0
  const toPrune: string[] = []
  let turns = 0
  loop: for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.type === "user") turns++
    if (turns < 2) continue
    if (message.type !== "assistant") continue
    for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex--) {
      const part = message.content[partIndex]
      if (part.type !== "tool") continue
      if (part.state.status !== "completed") continue
      if (PRUNE_PROTECTED_TOOLS.has(part.name)) continue
      if (part.provider?.executed === true) continue
      if (part.time.pruned) break loop
      const estimate = Token.estimate(serializeToolContent(part.state.content))
      total += estimate
      if (total <= PRUNE_PROTECT) continue
      pruned += estimate
      toPrune.push(part.id)
    }
  }
  if (pruned <= PRUNE_MINIMUM) return new Set<string>()
  return new Set(toPrune)
}

const pruneEntries = (entries: readonly Entry[]) => {
  const messages = entries.map((entry) => entry.message)
  const pruned = pruneToolOutput(messages)
  if (pruned === messages) return entries
  return entries.map((entry, index) => ({ seq: entry.seq, message: pruned[index] }))
}

const select = (
  entries: readonly Entry[],
  tokens: number,
): { readonly head: string; readonly recent: string } | undefined => {
  const conversation = entries
    .filter((entry) => entry.message.type !== "compaction")
    .map((entry) => serialize(entry.message))
    .filter(Boolean)
  if (conversation.length === 0) return
  let total = 0
  let split = conversation.length
  for (let index = conversation.length - 1; index >= 0; index--) {
    const next = total + Token.estimate(conversation[index])
    if (next > tokens) {
      // The newest entry is always kept: dropping it would leave the most recent request
      // neither summarized nor retained, so the compacted context would continue without it.
      if (split === conversation.length) split = index
      break
    }
    total = next
    split = index
  }
  return {
    head: conversation.slice(0, split).join("\n\n"),
    recent: conversation.slice(split).join("\n\n"),
  }
}

export const buildPrompt = (input: { readonly previousSummary?: string; readonly context: readonly string[] }) => {
  const conversation = `Here is the conversation so far:\n\n<conversation>\n${input.context.join("\n\n")}\n</conversation>`
  if (!input.previousSummary)
    return [
      conversation,
      "Create a new anchored summary from the conversation history in the <conversation> tags above so another coding agent can continue the work.",
      SUMMARY_TEMPLATE,
    ].join("\n\n")
  return [
    conversation,
    `Here is the summary of the conversation before the <conversation> above:\n\n<prior-summary>\n${input.previousSummary}\n</prior-summary>`,
    SUMMARY_UPDATE_INSTRUCTIONS,
    SUMMARY_TEMPLATE,
  ].join("\n\n")
}

export const make = (dependencies: Dependencies) => {
  const config = settings(dependencies.config)
  const compactAfterOverflow = Effect.fn("SessionCompaction.compactAfterOverflow")(function* (input: Input) {
    const context = input.model.route.defaults.limits?.context
    if (context === undefined || context <= 0) return false
    const output = reserve({ limits: input.model.route.defaults.limits, requested: input.request.generation?.maxTokens })
    const selected = select(input.entries, config.tokens)
    const previousSummary = input.entries.find((entry) => entry.message.type === "compaction")?.message
    // A conversation with nothing but compaction messages has nothing to summarize; that is the
    // normal state of the turn directly after a compaction, so it is not worth a signal.
    if (!selected) return false
    // Everything outside the retained tail is a compaction message, so there is nothing left to
    // summarize. Only system and tool content can still be over budget and compaction cannot
    // shrink those; firing anyway would re-summarize the prior summary on every turn without
    // ever reducing the request.
    if (selected.head.length === 0) {
      yield* Effect.logWarning("Compaction skipped: no conversation content outside the retained tail", {
        sessionID: input.sessionID,
      })
      return false
    }
    const summaryPrompt = buildPrompt({
      previousSummary: previousSummary?.type === "compaction" ? previousSummary.summary : undefined,
      // The prior compaction's retained tail is no longer in the history, so the summarizer has
      // to see it here to carry it forward into the combined summary.
      context: [previousSummary?.type === "compaction" ? previousSummary.recent : "", selected.head].filter(Boolean),
    })
    const summaryOutput = Math.min(output || SUMMARY_OUTPUT_TOKENS, SUMMARY_OUTPUT_TOKENS)
    if (Token.estimate(summaryPrompt) > context - summaryOutput) {
      yield* Effect.logWarning("Compaction skipped: the summary prompt does not fit the model window", {
        sessionID: input.sessionID,
        context,
        summaryOutput,
      })
      return false
    }
    const messageID = SessionMessage.ID.create()
    yield* dependencies.events.publish(SessionEvent.Compaction.Started, {
      sessionID: input.sessionID,
      messageID,
      timestamp: yield* DateTime.now,
      reason: "auto",
    })

    const chunks: string[] = []
    let failed = false
    const summarized = yield* dependencies.llm
      .stream(
        LLM.request({
          model: input.model,
          http: input.request.http,
          messages: [Message.user(summaryPrompt)],
          tools: [],
          generation: { maxTokens: summaryOutput },
        }),
      )
      .pipe(
        Stream.runForEach((event) => {
          if (LLMEvent.is.providerError(event)) failed = true
          if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
          return Effect.void
        }),
        Effect.as(true),
        Effect.catchTag("LLM.Error", () => Effect.succeed(false)),
      )
    const summary = chunks.join("")
    if (!summarized || failed || !summary.trim()) {
      yield* Effect.logWarning("Compaction summary failed", {
        sessionID: input.sessionID,
        messageID,
        reason: !summarized ? "llm_error" : failed ? "provider_error" : "empty_summary",
      })
      return false
    }
    yield* dependencies.events.publish(SessionEvent.Compaction.Ended, {
      sessionID: input.sessionID,
      messageID,
      timestamp: yield* DateTime.now,
      reason: "auto",
      text: summary,
      recent: selected.recent,
    })
    return true
  })
  const compactIfNeeded = Effect.fn("SessionCompaction.compactIfNeeded")(function* (input: Input) {
    if (!config.auto) return false
    const context = input.model.route.defaults.limits?.context
    if (context === undefined || context <= 0) return false
    const output = reserve({ limits: input.model.route.defaults.limits, requested: input.request.generation?.maxTokens })
    if (requestTokens(input) <= context - Math.max(output, config.buffer)) return false
    return yield* compactAfterOverflow(input)
  })
  return {
    compactIfNeeded,
    compactAfterOverflow,
    prune: (entries: readonly Entry[]) => (config.prune ? pruneEntries(entries) : entries),
  }
}
