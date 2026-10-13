import {
  LLM,
  LLMClient,
  LLMError,
  LLMEvent,
  Message,
  SystemPart,
  isContextOverflowFailure,
  type ProviderErrorEvent,
} from "@opencode-ai/llm"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"
import { Cause, Clock, DateTime, Duration, Effect, FiberSet, Layer, Option, Semaphore, Stream } from "effect"
import { eq } from "drizzle-orm"
import { AgentV2 } from "../../agent"
import { Config } from "../../config"
import { Database } from "../../database/database"
import { EventV2 } from "../../event"
import { Location } from "../../location"
import { ModelV2 } from "../../model"
import { PermissionV2 } from "../../permission"
import { ProviderV2 } from "../../provider"
import { QuestionV2 } from "../../question"
import { SystemContext } from "../../system-context/index"
import { SystemContextRegistry } from "../../system-context/registry"
import { SkillGuidance } from "../../skill/guidance"
import { ReferenceGuidance } from "../../reference/guidance"
import { ToolRegistry } from "../../tool/registry"
import { ToolOutputStore } from "../../tool-output-store"
import { InstructionRule } from "../../instruction-rule"
import { AbsolutePath } from "../../schema"
import { SessionV1 } from "../../v1/session"
import { WorkspaceV2 } from "../../workspace"
import { SessionContextEpoch } from "../context-epoch"
import { SessionCompaction } from "../compaction"
import { SessionEvent } from "../event"
import { SessionHistory } from "../history"
import { SessionInstructionSignals } from "../instruction-signals"
import { SessionInput } from "../input"
import { SessionInvocation } from "../invocation"
import { toV1 } from "../info"
import { SessionSchema } from "../schema"
import { SessionMessageTable, SessionTable } from "../sql"
import { SessionStore } from "../store"
import { SessionTitle } from "../title"
import { SessionUsage } from "../usage"
import { SessionTurn } from "../turn"
import { type RunError, Service } from "./index"
import { SessionRunnerModel } from "./model"
import { TurnRetry } from "./retry"
import { SessionFailure } from "../failure"
import { createLLMEventPublisher } from "./publish-llm-event"
import { toLLMMessages } from "./to-llm-message"
import { MAX_STEPS_PROMPT } from "./max-steps"
import { Snapshot } from "../../snapshot"
import { makeLocationNode } from "../../effect/app-node"
import { llmClient } from "../../effect/app-node-platform"

/**
 * Runs one durable coding-agent Session until it settles.
 *
 * Keep this as orchestration over smaller collaborators rather than rebuilding the legacy
 * `SessionPrompt` monolith. Implement the unchecked items in small reviewed slices:
 *
 * - Session ownership and controls
 *   - [x] Coordinate one local active drain per Session; explicit resumes join and prompt wakeups coalesce.
 *   - [ ] Replace local ownership with durable multi-node ownership when clustered.
 *   - [ ] Mark busy, retrying, idle, interrupted, or terminal-failure status durably.
 *   - [x] Honor interruption: fail unsettled tools and the assistant, then exit
 *     without waiting for in-flight tool fibers.
 *   - [x] Honor optional agent step limits.
 *   - [x] Bound provider retries: transient failures before assistant content are
 *     retried with backoff (rate limits, overload, transport, model resolution).
 *   - [ ] Bound repeated identical tool calls.
 *
 * - Runtime context assembly
 *   - Track V1 runtime-context parity canonically in `specs/v2/session.md`.
 *
 * - One provider turn
 *   - [x] Translate every projected V2 Session message variant into canonical
 *     `@opencode-ai/llm` messages.
 *   - [ ] Resolve policy-filtered built-in, MCP, plugin, and structured-output tool definitions.
 *   - [x] Stream exactly one `llm.stream(request)` provider turn.
 *   - [x] Persist assistant text and usage events incrementally as they arrive.
 *   - [ ] Persist snapshots, patches, and retry notices incrementally as they arrive.
 *   - [x] Persist reasoning, provider errors, and tool-call events incrementally as they arrive.
 *
 * - Tool settlement and continuation
 *   - [x] Durably record each tool call before side effects begin.
 *   - [x] Authorize and execute recorded local calls through a core-owned registry hook.
 *   - [x] Persist typed success, failure, and provider-executed tool outcomes.
 *   - [x] Start each recorded local call eagerly and await all settlements before continuation.
 *   - [ ] Add scoped runtime context, progress updates, attachment normalization,
 *     plugins, and cancellation settlement.
 *   - [x] Reload projected history and start the next explicit provider turn after local tool results.
 *   - [x] Continue for durable user steering accepted during an active provider turn.
 *   - [ ] Continue for compaction or another continuation condition when required.
 *
 * - Post-run maintenance
 *   - [ ] Settle final status and expose durable output events to replayable consumers.
 *   - [ ] Coalesce streamed deltas and add covering projected-history indexes.
 *   - [x] Name new conversations from their first prompt via the title agent while the first drain runs.
 *   - [ ] Update summaries, compaction state, and cleanup in bounded background work.
 *
 * Use `llm.stream(request)` for each provider turn. Keep tool execution and continuation here.
 * Durable continuation recovery remains a separate future slice with an explicit retry policy.
 *
 * The current slice loads V2 history, translates it, resolves a model through a core service, and persists one
 * provider turn. Registry definitions are advertised, local tool calls are settled durably, and an
 * explicit loop starts the next provider turn after local settlement. Configured agent step limits bound the loop.
 */

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const llm = yield* LLMClient.Service
    const agents = yield* AgentV2.Service
    const tools = yield* ToolRegistry.Service
    const models = yield* SessionRunnerModel.Service
    const store = yield* SessionStore.Service
    const location = yield* Location.Service
    const systemContext = yield* SystemContextRegistry.Service
    const skillGuidance = yield* SkillGuidance.Service
    const referenceGuidance = yield* ReferenceGuidance.Service
    const config = yield* Config.Service
    const snapshots = yield* Snapshot.Service
    const db = (yield* Database.Service).db
    const compaction = SessionCompaction.make({ events, llm, config: yield* config.entries() })
    const getSession = Effect.fn("SessionRunner.getSession")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
      return session
    })

    const getContext = Effect.fn("SessionRunner.getContext")(function* (sessionID: SessionSchema.ID) {
      return yield* store.context(sessionID)
    })
    const failInterruptedTools = Effect.fn("SessionRunner.failInterruptedTools")(function* (
      sessionID: SessionSchema.ID,
    ) {
      for (const message of yield* getContext(sessionID)) {
        if (message.type !== "assistant") continue
        for (const tool of message.content) {
          if (tool.type !== "tool" || (tool.state.status !== "pending" && tool.state.status !== "running")) continue
          yield* events.publish(SessionEvent.Tool.Failed, {
            sessionID,
            timestamp: yield* DateTime.now,
            assistantMessageID: message.id,
            callID: tool.id,
            error: { type: "unknown", message: SessionInvocation.INTERRUPTED_REASON },
            provider: {
              executed: tool.provider?.executed === true,
              ...(tool.provider?.metadata === undefined ? {} : { metadata: tool.provider.metadata }),
            },
          })
        }
      }
    })

    // A turn left without a terminal by a previous process is orphaned: this drain can
    // never resume it, so it is durably failed. Recovery never re-executes provider work
    // (see the post-crash continuation rule), which is why an orphan becomes a terminal
    // failure instead of a retry. Callers pass the turns to fail: a turn that still owns
    // unsettled tools is continued inline first, and only failed once the drain has
    // consumed its history, because a failed assistant turn replays without the
    // provider-native continuation metadata its tool calls need (`runner/to-llm-message`).
    const failOrphanedTurns = Effect.fn("SessionRunner.failOrphanedTurns")(function* (
      sessionID: SessionSchema.ID,
      turns: ReadonlyArray<SessionTurn.Turn>,
    ) {
      for (const turn of turns) {
        yield* events.publish(SessionEvent.Step.Failed, {
          sessionID,
          timestamp: yield* DateTime.now,
          assistantMessageID: turn.id,
          error: { type: "unknown", message: SessionTurn.ORPHANED_REASON },
        })
      }
    })

    // A conversation can still be named from its first prompt only while it is new: it must
    // not be a fork, its title must still be the synchronous admission placeholder (or the
    // default when the prompt produced no placeholder), and no message may be projected yet
    // (older placeholder sessions keep their titles).
    const canNameFromFirstPrompt = Effect.fn("SessionRunner.canNameFromFirstPrompt")(function* (
      sessionID: SessionSchema.ID,
    ) {
      const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
      if (!row || row.parent_id) return false
      const first = (yield* SessionInput.list(db, sessionID))[0]
      if (!first) return false
      const placeholder = SessionTitle.fromPrompt(first.prompt.text)
      if (!SessionTitle.isDefault(row.title) && row.title !== placeholder) return false
      const projected = yield* db
        .select({ id: SessionMessageTable.id })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      return !projected
    })

    // Generates the session name from the first prompt while the first drain answers, the
    // Cursor-style naming. Runs detached so the drain never waits for it, and only replaces
    // the title when the user has not renamed the session in the meantime.
    const ensureTitle = Effect.fn("SessionRunner.ensureTitle")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session || session.parentID) return
      const titleAgent = yield* agents.select(AgentV2.ID.make("title"))
      if (!titleAgent.info?.system) return
      const first = (yield* SessionInput.list(db, sessionID))[0]
      if (!first) return
      const { model } = yield* models.resolve(
        titleAgent.info.model ? { ...session, model: titleAgent.info.model } : session,
      )
      const chunks: string[] = []
      const streamed = yield* llm
        .stream(
          LLM.request({
            model,
            system: [SystemPart.make(titleAgent.info.system)],
            messages: [Message.user(`Generate a title for this conversation:\n\n${first.prompt.text}`)],
            tools: [],
          }),
        )
        .pipe(
          Stream.runForEach((event) => {
            if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
            return Effect.void
          }),
          Effect.as(true),
          Effect.catchTag("LLM.Error", () => Effect.succeed(false)),
        )
      if (!streamed) return
      const title = SessionTitle.clean(chunks.join(""))
      if (!title) return
      // Re-read so the full-row Updated snapshot does not clobber concurrent changes and the
      // user's rename (or another title) wins over the generated one.
      const current = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
      if (!current || current.parent_id) return
      const placeholder = SessionTitle.fromPrompt(first.prompt.text)
      if (!SessionTitle.isDefault(current.title) && current.title !== placeholder) return
      yield* events.publish(
        SessionV1.Event.Updated,
        {
          sessionID,
          info: toV1({ ...current, title, time_updated: DateTime.toEpochMillis(yield* DateTime.now) }),
        },
        {
          location: Location.Ref.make({
            directory: AbsolutePath.make(current.directory),
            workspaceID: current.workspace_id ? WorkspaceV2.ID.make(current.workspace_id) : undefined,
          }),
        },
      )
    })

    const awaitToolFibers = (fibers: FiberSet.FiberSet<void, ToolOutputStore.Error>) =>
      Effect.raceFirst(FiberSet.join(fibers), FiberSet.awaitEmpty(fibers))

    // Match V1: declining a user prompt halts the loop instead of becoming model-facing tool output.
    const isUserDeclined = (cause: Cause.Cause<unknown>) =>
      cause.reasons.some(
        (reason) =>
          Cause.isDieReason(reason) &&
          (reason.defect instanceof PermissionV2.DeclinedError || reason.defect instanceof QuestionV2.RejectedError),
      )

    type TurnTransition =
      // Automatic compaction completed; rebuild the request from compacted history.
      | { readonly _tag: "ContinueAfterCompaction"; readonly step: number }
      // Overflow compaction completed; rebuild once through the path without overflow recovery.
      | { readonly _tag: "ContinueAfterOverflowCompaction"; readonly step: number }

    class TurnTransitionError extends Error {
      constructor(readonly transition: TurnTransition) {
        super()
      }
    }

    const continueAfterCompaction = (step: number) => new TurnTransitionError({ _tag: "ContinueAfterCompaction", step })
    const continueAfterOverflowCompaction = (step: number) =>
      new TurnTransitionError({ _tag: "ContinueAfterOverflowCompaction", step })

    const sessionSignals = Effect.fn("SessionRunner.sessionSignals")(function* (sessionID: SessionSchema.ID) {
      const [inputs, messages] = yield* Effect.all(
        [SessionInput.list(db, sessionID), getContext(sessionID)],
        { concurrency: "unbounded" },
      )
      return InstructionRule.merge(
        SessionInstructionSignals.fromPrompts(inputs.map((input) => input.prompt)),
        SessionInstructionSignals.fromMessages(messages),
      )
    })

    const loadSystemContext = (agent: AgentV2.Selection, sessionID: SessionSchema.ID) =>
      sessionSignals(sessionID).pipe(
        Effect.flatMap((signals) =>
          Effect.all([systemContext.load(), skillGuidance.load(agent), referenceGuidance.load()], {
            concurrency: "unbounded",
          }).pipe(
            Effect.map(SystemContext.combine),
            Effect.provideService(InstructionRule.SignalsService, InstructionRule.SignalsService.of(signals)),
          ),
        ),
      )

    const runTurnAttempt = Effect.fn("SessionRunner.runTurn")(function* (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
      recoverOverflow?: typeof compaction.compactAfterOverflow,
    ) {
      const session = yield* getSession(sessionID)
      if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
        return yield* Effect.interrupt
      const agent = yield* agents.select(session.agent)
      const initialized = yield* SessionContextEpoch.initialize(db, loadSystemContext(agent, session.id), session.id)
      let needsContinuation = false
      let currentStep = step
      if (promotion) {
        const cutoff = yield* EventV2.latestSequence(db, session.id)
        let promoted = 0
        if (promotion === "steer") promoted = yield* SessionInput.promoteSteers(db, events, session.id, cutoff)
        if (promotion === "queue") {
          promoted += Number(yield* SessionInput.promoteNextQueued(db, events, session.id))
          promoted += yield* SessionInput.promoteSteers(db, events, session.id, cutoff)
        }
        if (promoted > 0) currentStep = 1
      }
      const system =
        initialized ?? (yield* SessionContextEpoch.prepare(db, events, loadSystemContext(agent, session.id), session.id))

      // One provider-turn attempt. Only failures that arrive before any assistant
      // content is published are retried by the loop below; nothing durable exists
      // to roll back in that case. `settle` restores the original failure handling
      // once retries are exhausted.
      const runAttempt = (settle: boolean) =>
        Effect.gen(function* () {
          const toolFibers = yield* FiberSet.make<void, ToolOutputStore.Error>()
          const { info, model } = yield* models.resolve(session).pipe(
            Effect.mapError((error) => {
              const retry = !settle ? TurnRetry.retryable(error) : undefined
              return retry ? new TurnRetry.RetryableTurnError(retry) : error
            }),
          )
      const entries = compaction.prune(yield* SessionHistory.entriesForRunner(db, session.id, system.baselineSeq))
      const context = entries.map((entry) => entry.message)
      const isLastStep = agent.info?.steps !== undefined && currentStep >= agent.info.steps
      const toolMaterialization = isLastStep ? undefined : yield* tools.materialize(agent.info?.permissions)
      if (toolMaterialization)
        yield* Effect.logDebug("materialized tools", {
          registryEpoch: toolMaterialization.epoch,
          registryHash: toolMaterialization.hash,
          definitions: toolMaterialization.definitions.length,
        })
      const promptCacheKey = /^ses_[0-9a-f]{64}$/.test(session.id) ? session.id.slice(4) : session.id
      const request = LLM.request({
        model,
        http: {
          headers: {
            "x-session-affinity": session.id,
            "X-Session-Id": session.id,
            ...(session.parentID ? { "x-parent-session-id": session.parentID } : {}),
          },
        },
        providerOptions: { openai: { promptCacheKey } },
        system: [agent.info?.system, system.baseline]
          .filter((part): part is string => part !== undefined && part.length > 0)
          .map(SystemPart.make),
        messages: [
          ...toLLMMessages(context, model, info.capabilities.input),
          ...(isLastStep ? [Message.assistant(MAX_STEPS_PROMPT)] : []),
        ],
        tools: toolMaterialization?.definitions ?? [],
        toolChoice: isLastStep ? "none" : undefined,
      })
      if (yield* compaction.compactIfNeeded({ sessionID: session.id, entries, model, request }))
        return yield* Effect.die(continueAfterCompaction(currentStep))
      const startSnapshot = yield* snapshots.capture()
      const publisher = createLLMEventPublisher(events, {
        sessionID: session.id,
        agent: agent.id,
        model: {
          id: ModelV2.ID.make(model.id),
          providerID: ProviderV2.ID.make(model.provider),
          ...(session.model?.variant === undefined ? {} : { variant: session.model.variant }),
        },
        snapshot: startSnapshot,
      })
      const withPublication = Semaphore.makeUnsafe(1).withPermit
      const publish = (event: LLMEvent, outputPaths: ReadonlyArray<string> = []) =>
        withPublication(publisher.publish(event, outputPaths))
      let overflowFailure: ProviderErrorEvent | undefined
      let retryableFailure: TurnRetry.RetryInfo | undefined
      const providerStream = llm.stream(request).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (overflowFailure || publisher.hasProviderError()) return
            if (LLMEvent.is.providerError(event)) {
              if (isContextOverflowFailure(event) && !publisher.hasAssistantStarted()) {
                overflowFailure = event
                return
              }
              // Defer transient provider errors that arrive before any assistant content so
              // the turn can retry instead of immediately failing an empty assistant step.
              const retry =
                !settle && !publisher.hasAssistantStarted() ? TurnRetry.providerEvent(event.message) : undefined
              if (retry) {
                retryableFailure = retry
                return
              }
            }
            yield* publish(event)
            if (event.type !== "tool-call" || event.providerExecuted) return
            if (!toolMaterialization) {
              yield* withPublication(publisher.failUnsettledTools("Tools are disabled after the maximum agent steps"))
              return
            }
            needsContinuation = true
            const assistantMessageID = yield* publisher.assistantMessageID(event.id)
            yield* Effect.uninterruptibleMask((restore) =>
              restore(
                toolMaterialization.settle({
                  sessionID: session.id,
                  agent: agent.id,
                  assistantMessageID,
                  call: event,
                }),
              ).pipe(
                Effect.flatMap((settlement) =>
                  publish(
                    LLMEvent.toolResult({
                      id: event.id,
                      name: event.name,
                      result: settlement.result,
                      output: settlement.output,
                    }),
                    settlement.outputPaths ?? [],
                  ),
                ),
              ),
            ).pipe(FiberSet.run(toolFibers))
          }),
        ),
        Effect.ensuring(withPublication(publisher.flush())),
      )

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const stream = yield* restore(providerStream).pipe(Effect.exit)
          if (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) {
            yield* FiberSet.clear(toolFibers)
            yield* withPublication(publisher.failUnsettledTools(SessionInvocation.INTERRUPTED_REASON))
            if (publisher.hasActiveAssistant())
              yield* withPublication(publisher.failAssistant(SessionTurn.INTERRUPTED_REASON))
            return yield* Effect.failCause(stream.cause)
          }
          const failure =
            stream._tag === "Failure" ? Option.getOrUndefined(Cause.findErrorOption(stream.cause)) : undefined
          if (
            recoverOverflow &&
            !publisher.hasAssistantStarted() &&
            isContextOverflowFailure(overflowFailure ?? failure) &&
            (yield* restore(recoverOverflow({ sessionID: session.id, entries, model, request })))
          )
            return yield* Effect.die(continueAfterOverflowCompaction(currentStep))
          if (overflowFailure) yield* publish(overflowFailure)
          if (retryableFailure && !publisher.hasAssistantStarted()) {
            if (stream._tag === "Success" || !Cause.hasInterrupts(stream.cause))
              return yield* Effect.fail(new TurnRetry.RetryableTurnError(retryableFailure))
          }
          const llmFailure = failure instanceof LLMError ? failure : undefined
          if (llmFailure && !publisher.hasProviderError()) {
            const retry =
              !settle &&
              stream._tag === "Failure" &&
              !publisher.hasAssistantStarted() &&
              !Cause.hasInterrupts(stream.cause)
                ? TurnRetry.retryable(llmFailure)
                : undefined
            if (retry) return yield* Effect.fail(new TurnRetry.RetryableTurnError(retry))
            yield* withPublication(publisher.failUnsettledTools(SessionInvocation.HOSTED_UNRESOLVED_REASON, true))
            yield* withPublication(publisher.failAssistant(llmFailure.reason.message))
          }
          const settled = yield* restore(awaitToolFibers(toolFibers)).pipe(Effect.exit)
          if (settled._tag === "Failure" && isUserDeclined(settled.cause)) {
            yield* FiberSet.clear(toolFibers)
            yield* withPublication(publisher.failUnsettledTools(SessionInvocation.INTERRUPTED_REASON))
            return yield* Effect.interrupt
          }
          if (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause)) {
            yield* FiberSet.clear(toolFibers)
            yield* withPublication(publisher.failUnsettledTools(SessionInvocation.INTERRUPTED_REASON))
            if (publisher.hasActiveAssistant())
              yield* withPublication(publisher.failAssistant(SessionTurn.INTERRUPTED_REASON))
            return yield* Effect.failCause(settled.cause)
          }
          if (settled._tag === "Failure" && !Cause.hasInterrupts(settled.cause)) {
            const failure = Cause.squash(settled.cause)
            const message = failure instanceof Error ? failure.message : String(failure)
            yield* withPublication(
              publisher.failUnsettledTools(`${SessionInvocation.EXECUTION_FAILED_PREFIX}${message}`),
            )
          }
          const stepSettlement = publisher.stepSettlement()
          if (stepSettlement && !publisher.hasProviderError()) {
            const endSnapshot = yield* snapshots.capture()
            const files =
              startSnapshot && endSnapshot
                ? yield* snapshots
                    .files({ from: startSnapshot, to: endSnapshot })
                    .pipe(Effect.catch(() => Effect.succeed(undefined)))
                : undefined
            yield* withPublication(
              events.publish(SessionEvent.Step.Ended, {
                sessionID: session.id,
                timestamp: yield* DateTime.now,
                assistantMessageID: yield* publisher.startAssistant(),
                finish: stepSettlement.finish,
                cost: SessionUsage.stepCost(info.cost, stepSettlement.tokens),
                tokens: stepSettlement.tokens,
                snapshot: endSnapshot,
                files,
              }),
            )
          }
          if (publisher.hasProviderError())
            yield* withPublication(publisher.failUnsettledTools(SessionInvocation.INTERRUPTED_REASON))
          if (stream._tag === "Success" && !publisher.hasProviderError())
            yield* withPublication(publisher.failUnsettledTools(SessionInvocation.HOSTED_UNRESOLVED_REASON, true))
          // The LLM client requires a terminal finish before a stream can end
          // successfully, so a settled step is the only valid completion. If a
          // producer bypasses that contract, keep the runner honest whenever the
          // turn already published assistant output: a partially delivered turn
          // must fail instead of ending as if it had completed.
          if (
            stream._tag === "Success" &&
            !publisher.hasProviderError() &&
            stepSettlement === undefined &&
            publisher.hasAssistantStarted()
          )
            yield* withPublication(publisher.failAssistant("Provider stream ended without a step settlement"))
          if (stream._tag === "Failure") return yield* Effect.failCause(stream.cause)
          return {
            // A turn continues only after a settled step; a stream that ended
            // without one is a failure, never a reason to call the provider again.
            needsContinuation: stepSettlement !== undefined && !publisher.hasProviderError() && needsContinuation,
            step: currentStep,
          }
        }),
      )
      })

      const runAttempts: (retries: number, limit: number) => Effect.Effect<
        { readonly needsContinuation: boolean; readonly step: number },
        RunError
      > = (retries, limit) =>
        runAttempt(retries === limit).pipe(
          Effect.catch((failure) => {
            if (!(failure instanceof TurnRetry.RetryableTurnError)) return Effect.fail(failure)
            if (retries >= limit)
              return Effect.die("Retryable provider failure escaped the settling attempt")
            const attempt = retries + 1
            const wait = TurnRetry.delayMs(attempt, failure.retryAfterMs)
            return Effect.gen(function* () {
              yield* Effect.logWarning("retrying provider turn", {
                "session.id": session.id,
                attempt,
                "retry.delay_ms": wait,
                "retry.message": failure.message,
              })
              yield* events.publish(
                SessionStatusEvent.Status,
                {
                  sessionID: session.id,
                  status: {
                    type: "retry",
                    attempt,
                    message: failure.message,
                    next: (yield* Clock.currentTimeMillis) + wait,
                  },
                },
                { location: session.location },
              )
              yield* Effect.sleep(Duration.millis(wait))
              // The last allowed retry settles directly. Retrying once more only to
              // persist the same terminal provider failure would issue an unexpected
              // extra billable request after the retry budget was already exhausted.
              return yield* runAttempts(attempt, limit)
            })
          }),
        )
      // Poison accounting: the retry budget shrinks with the durable streak of identical
      // failures this input already produced, and stops entirely at the quarantine threshold.
      // The accounting therefore survives drains and restarts, the drain still attempts the
      // provider once, and admitting a new input is the clear path because the streak is
      // scoped to one prompt.
      const prior = SessionFailure.account(yield* getContext(session.id)).failures
      const quarantined = prior >= SessionFailure.MAX_IDENTICAL_FAILURES
      if (quarantined)
        yield* Effect.logWarning("provider failure quarantined", { "session.id": session.id, failures: prior })
      const limit = quarantined ? 0 : Math.max(0, TurnRetry.MAX_RETRIES - prior)
      return yield* runAttempts(0, limit)
    }, Effect.scoped)
    type RunTurn = (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
    ) => Effect.Effect<{ readonly needsContinuation: boolean; readonly step: number }, RunError>

    const runAfterOverflowCompaction: RunTurn = Effect.fnUntraced(function* (sessionID, promotion, step) {
      return yield* runTurnAttempt(sessionID, promotion, step).pipe(
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            if (defect.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* Effect.die("Post-compaction provider attempt cannot recover another overflow")
            yield* Effect.yieldNow
            return yield* runAfterOverflowCompaction(sessionID, undefined, defect.transition.step)
          }),
        ),
      )
    })

    const runTurn: RunTurn = Effect.fnUntraced(function* (sessionID, promotion, step) {
      return yield* runTurnAttempt(sessionID, promotion, step, compaction.compactAfterOverflow).pipe(
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            yield* Effect.yieldNow
            if (defect.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* runAfterOverflowCompaction(sessionID, undefined, defect.transition.step)
            return yield* runTurn(sessionID, undefined, defect.transition.step)
          }),
        ),
      )
    })

    const run = Effect.fn("SessionRunner.run")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly force: boolean
    }) {
      const hasSteer = yield* SessionInput.hasPending(db, input.sessionID, "steer")
      const hasQueue = hasSteer ? false : yield* SessionInput.hasPending(db, input.sessionID, "queue")
      if (!input.force && !hasSteer && !hasQueue) return
      // Classified before tool reconciliation: a running turn whose tools are still
      // unsettled is continued inline by this drain (those tools are failed and its
      // history is replayed for the provider to finish), so only a turn with nothing left
      // to settle is failed up front.
      const running = (yield* store.turns(input.sessionID)).filter((turn) => turn.state === "running")
      const abandoned = running.filter((turn) => turn.unsettledTools === 0)
      const continued = running.filter((turn) => turn.unsettledTools > 0)
      yield* failInterruptedTools(input.sessionID)
      yield* failOrphanedTurns(input.sessionID, abandoned)
      if (yield* canNameFromFirstPrompt(input.sessionID))
        yield* ensureTitle(input.sessionID).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to generate session title", cause).pipe(
              Effect.annotateLogs({ sessionID: input.sessionID }),
            ),
          ),
          Effect.forkDetach,
        )
      let promotion: SessionInput.Delivery | undefined = hasSteer ? "steer" : hasQueue ? "queue" : undefined
      let shouldRun = input.force || hasSteer || hasQueue
      while (shouldRun) {
        let needsContinuation = true
        let step = 1
        while (needsContinuation) {
          const result = yield* runTurn(input.sessionID, promotion, step)
          needsContinuation = result.needsContinuation
          step = result.step + 1
          promotion = "steer"
          if (!needsContinuation) needsContinuation = yield* SessionInput.hasPending(db, input.sessionID, "steer")
        }
        shouldRun = yield* SessionInput.hasPending(db, input.sessionID, "queue")
        promotion = shouldRun ? "queue" : undefined
      }
      // The continued turns were replayed with their provider-native continuation metadata
      // while this drain ran, so they are terminalized only now, after every request that
      // needed that metadata was built.
      yield* failOrphanedTurns(input.sessionID, continued)
    })

    return Service.of({
      run,
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    EventV2.node,
    llmClient,
    AgentV2.node,
    ToolRegistry.node,
    SessionRunnerModel.node,
    SessionStore.node,
    Location.node,
    SystemContextRegistry.node,
    SkillGuidance.node,
    ReferenceGuidance.node,
    Config.node,
    Snapshot.node,
    Database.node,
  ],
})
