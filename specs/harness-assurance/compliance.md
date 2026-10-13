# Harness Implementation Assurance — Compliance Audit

Audit of the runtime against `HARNESS_IMPLEMENTATION_ASSURANCE.md` (the "assurance spec").
Source inspection only: no runtime tests or fault-injection suites were executed for this
report. Each section quotes the normative requirement, states a verdict, and cites source
evidence. Where a claim could not be settled by reading code, it is marked **unverified**
rather than asserted either way.

- **Repository:** `opencode-enhanced` (fork of OpenCode)
- **Baseline:** branch `cursor-sidebar`, HEAD `b0637d7a00`, plus uncommitted working-tree
  changes (noted where they matter)
- **Primary scope:** `packages/core/src` (V2 session core, `packages/llm` provider runtime)
  and its consumers in `packages/opencode/src` (V1 runtime, product server)
- **Out of scope for this pass:** product UI behavior beyond reconnect/polling evidence,
  console/billing packages, plugin ecosystem internals

> **Implementation status (2026-09-22):** P0 slice 3 has landed in part — the provider
> terminal requirement, request/idle/total deadlines, and the runner's fail-closed settlement
> guard are implemented and covered by tests. See
> [Implementation status](#implementation-status--2026-09-22-p0-slice-3-partial) at the end of
> this document for what changed, what is verified, and what remains open. The audit body
> below is the pre-implementation record.

## Verdict legend

| Verdict | Meaning |
|---|---|
| **PASS** | The invariant is enforced in runtime code and the evidence is direct |
| **PARTIAL** | Part of the invariant exists; at least one acceptance criterion fails or is unverified |
| **GAP** | The invariant is absent in code |
| **N/A** | The failure mode does not exist in this architecture (stated with reasoning) |
| **PROCESS** | A documentation/process requirement, not runtime code |

## Summary

| § | Area | Verdict |
|---|---|---|
| 1.1 | Persisted state is authoritative | PARTIAL |
| 1.2 | Every side effect has an identity | GAP |
| 1.3 | Terminal states are explicit | PARTIAL |
| 1.4 | Prompt text is not a safety boundary | PARTIAL |
| 1.5 | Recovery is deterministic | GAP |
| 2.1 | Turn lifecycle | GAP |
| 2.2 | Tool-call lifecycle | PARTIAL |
| 2.3 | Child-agent lifecycle | PARTIAL |
| 3.1 | Durable turn queue | PARTIAL |
| 3.2 | Worker readiness barrier | N/A (single process) |
| 4.1 | Versioned registry snapshot | GAP |
| 4.2 | Registration ownership | PARTIAL |
| 5.1 | Monotonic cancellation | PARTIAL |
| 6.1–6.2 | Retry classes and rules | PARTIAL |
| 7 | Poison message handling | GAP |
| 8.1 | Transport close is not completion | GAP |
| 8.2 | Semantic vs keepalive activity | GAP |
| 9 | Incremental stream parsing | PARTIAL |
| 10.1 | Fail closed | PARTIAL |
| 10.2 | Execution-time authorization | PASS |
| 10.3 | Approval single-use semantics | PARTIAL |
| 11 | Locking and concurrency | PARTIAL |
| 12 | Context accounting | GAP |
| 13 | Model capability limits | PARTIAL |
| 14 | Compaction | PARTIAL |
| 15 | Large result handling | PASS |
| 16 | Context retention policy | PARTIAL |
| 17 | Usage and billing accounting | PARTIAL |
| 18 | Prompt cache stability | PARTIAL |
| 19 | Tool schema budget | GAP |
| 20 | Identifier safety | PASS |
| 21 | Result representation | PARTIAL |
| 22 | Completion waiting and status observation | PASS |
| 23 | Execution profile inheritance | PARTIAL |
| 24 | Dependency graph safety | PARTIAL |
| 25 | Process and supervisor ownership | PARTIAL |
| 26 | Port and instance ownership | PARTIAL |
| 27 | File and directory safety | PASS |
| 28 | Replay and recovery log design | PARTIAL |
| 29 | Cleanup semantics | GAP |
| 30 | Telemetry and trace safety | PARTIAL |
| 31 | Trace cache complexity | N/A |
| 32 | WebSocket / SSE reconnect policy | PARTIAL |
| 33 | Completion integrity | GAP |
| 34 | Database / persistence invariants | PARTIAL |
| 35 | Fault-injection test matrix | GAP |
| 36 | CI assurance gates | GAP |
| 37 | Recommended implementation priority | this report's plan |
| 38 | Suggested core types | GAP |
| 39 | Required runtime metrics | GAP |
| 40 | Definition of Done | PROCESS (unadopted) |
| 41 | Master assurance rule | PROCESS (unadopted) |
| 42 | PR assurance template | GAP |
| 43 | Release assurance checklist | PROCESS (unadopted) |

The two P0 verdicts that matter most:

1. **§8.1 / §33 — a provider stream that closes without a terminal event is currently a
   normal turn end.** This is the clearest live correctness hole.
2. **§1.2 / §2.1 / §2.2 — no turn identity, no idempotency key, no execution receipt.**
   Everything built on "exactly once" assumes these and cannot be retrofitted cheaply.

---

## 1. Assurance principles

### 1.1 Persisted state is authoritative — PARTIAL

**Evidence.** V2 writes durable events through a per-aggregate event log with sequence
enforcement and duplicate rejection (`packages/core/src/event.ts`: durable publish path
lines 236–350, divergence detection lines 262–318). Session projection runs inside that
transaction through `EventV2.project` (`event.ts:137`, `session/projector.ts` step/usage
projection at `projector.ts:417`). Provider deltas are accumulated and published as single
durable fragment events (`session/runner/publish-llm-event.ts`, `fragments()` start/append/
end/flush).

**Gap.** Execution ownership, tool settlement, approvals, and background jobs are
process-local and treated as authoritative while in flight:

- `session/run-coordinator.ts` keeps active drains in an in-memory `Map`;
  `session/execution/local.ts` builds the coordinator per process and documents the drain as
  process-local (`specs/v2/session.md`: "activity is not durable across process restarts").
- Approval state is an in-memory `Map` (`core/src/permission.ts` `pending`).
- Background subagent status explicitly loses authority on restart
  (`core/src/background-job.ts:115`: "process restart or owner-scope closure loses status and
  interrupts").

UI state is not used as authority by the V2 path (events are projected before broadcast),
which is why this is PARTIAL rather than GAP. The failing half is exactly what §1.5 and §3
require.

### 1.2 Every side effect has an identity — GAP

**Evidence.** A repository-wide search for `idempotencyKey`, `idempotency_key`,
`logicalAttempt`, `logical_attempt` returns no matches. The durable identities that do exist
are `sessionID`, `assistantMessageID` (message ID), and `callID`: local settlement is keyed
by `(sessionID, agent, assistantMessageID, callID)` in `core/src/tool/registry.ts`
(`ExecuteInput`, `settleWith`). There is no `logical_attempt` component and no persisted
invocation record, so a retried local settlement cannot be recognized as the same logical
operation.

**Consequence.** §2.2's "retried tool execution uses the same logical idempotency identity"
and §6's blind-retry prohibition cannot be satisfied today.

### 1.3 Terminal states are explicit — PARTIAL

**Evidence.**

- Durable assistant/tool terminal states exist as `ToolStateCompleted` /
  `ToolStateError` writes (`session/message-updater.ts`, states defined in
  `packages/schema/src/session-message.ts:81–119`).
- Failure is explicit for steps: `SessionEvent.Step.Failed` (`publish-llm-event.ts`,
  `failAssistant`), and unsettled tools are failed with `failUnsettledTools`.
- Turn limits are explicit for the V2 provider loop: the step cap injects `MAX_STEPS_PROMPT`
  and disables tools on the last step (`session/runner/llm.ts`, `isLastStep`).

**Gaps.**

- `ToolState` has no `cancelled` and no `outcome_unknown`
  (`packages/schema/src/session-message.ts:116–119`); interrupted tools are converted to
  `error` with `metadata.interrupted` (`packages/opencode/src/session/processor.ts:602–603`).
- There is no durable turn record at all, so "turn terminal state" is not represented.
- A successful-looking stream with no provider terminal is not failed (see §8.1/§33).

### 1.4 Prompt text is not a safety boundary — PARTIAL

**Evidence that runtime code, not prompt text, enforces guarantees:**

- Permission checks run inside tool execution (`core/src/tool/*.ts`, see §10.2 below).
- Tool arguments are schema-decoded before `execute` (`core/src/tool/tool.ts`, `settle`).
- Bash execution is bounded by runtime caps: `MAX_TIMEOUT_MS = 10 * 60 * 1000`,
  `MAX_CAPTURE_BYTES = 1 MiB` (`core/src/tool/bash.ts:20–21`).
- Wait-for-completion is event-driven rather than sleep-driven; the subagent prompt text
  says "DO NOT sleep, poll" but the mechanism is `background.wait` and promotion notification
  (`packages/opencode/src/tool/task.ts`, foreground `Effect.raceFirst(background.wait,
  background.waitForPromotion)`), not the text.

**Gap.** Guarantees that exist only as prompt text do not exist in runtime code:
cancellation is not durable (§5), and completion does not require a provider terminal
(§8.1/§33). Those are the two places where a model that "usually behaves" is currently
trusted.

### 1.5 Recovery is deterministic — GAP

**Evidence.** On restart, a V2 drain does not resume: there is no durable turn record, the
coordinator is rebuilt empty, and `session_input` rows persist but are only promoted by a
new wake (`session/input.ts`, `session/execution/local.ts`). Within a process,
`failInterruptedTools` scans projected history at drain start and fails
`pending`/`running` tools (`session/runner/llm.ts:136–156`), but this is not a restart path
and cannot distinguish "never started" from "outcome unknown".

**Acceptance criteria (§1.5):** the runtime cannot currently answer "what may have
executed" after a crash; tool rows left `running` are visually indistinguishable from
in-flight work.

---

## 2. Canonical runtime state machines

### 2.1 Turn lifecycle — GAP

**Normative.** Durable lifecycle `queued → starting → running → terminal`, with durable
owner/lease, expiry reconciliation, monotonic terminals, stale-writer rejection, and
atomic/compare-and-swap terminal transitions.

**Evidence.**

- Durable tables in `core/src/session/sql.ts`: `session` (22), `message` (68), `part` (82),
  `todo` (100), `session_message` (119), `session_input` (140),
  `session_context_epoch` (168). No turn/lease/owner table.
- Execution is an in-memory coordinator (`session/run-coordinator.ts`, `active` Map;
  `session/execution/local.ts`), interrupt is fiber interruption
  (`core/src/session.ts:461–462`).
- Status is broadcast, not persisted: `SessionStatusEvent.Status` busy/idle in
  `session/execution/local.ts`.
- There is no lease, no owner epoch, no CAS-guarded terminal transition, and no
  orphan/recovery state.

**Design note (important).** The repo's own architecture rule currently forbids the
straight reading of §2.1: root `AGENTS.md` — "Keep durable prompt admission separate from
model execution" and "A drain has no durable identity"; `CONTEXT.md` — "A Session Drain has
no durable identity or transcript boundary", and continuation recovery "requires a separate
explicit design before it may retry provider work". The assurance spec's durable turn is
therefore a **deliberate architectural change**, not a missing field. The compatible path is
to derive a durable *turn* record from the already-durable `SessionEvent.Step.*` events
(projection, not a second source of truth) — see the plan.

**Acceptance criteria (§2.1):** none are met today.

### 2.2 Tool-call lifecycle — PARTIAL

**Normative.** Durable states through `declared → arguments_streaming → arguments_validated
→ authorized → executing → terminal`; settle exactly once; no execution before complete
validation; incomplete arguments never become `{}`/`null`/empty success; authorization
immediately before execution; side-effecting tools idempotent or reconcilable; no blind
duplicate after crash; dangling calls reconciled before continuing.

**Evidence (satisfied).**

- Durable tool state lives in `session_message` assistant parts with `pending`, `running`,
  `completed`, `error` (`packages/schema/src/session-message.ts:82–114`; writes in
  `core/src/session/message-updater.ts`, states at 258/278/308/331).
- Arguments are schema-decoded before execution and a decode failure becomes a tool error,
  not an execution (`core/src/tool/tool.ts`, `settle`: `Schema.decodeUnknownEffect(config.input)`
  → `ToolFailure("Invalid tool input: ...")`).
- Dangling calls are reconciled at drain start and after stream end:
  `failInterruptedTools` (`runner/llm.ts:136–156`), `failUnsettledTools`
  (`runner/publish-llm-event.ts`, call sites `runner/llm.ts:503–504`).
- Settlement is one event per call, published under a semaphore `withPublication`.

**Gaps.**

| Requirement | Evidence |
|---|---|
| `authorized`/`executing` distinct from `running` | absent; `running` is written when the call is admitted to execution (`message-updater.ts:278`) |
| `arguments_validated` state | absent; validation is in-memory inside `Tool.settle` |
| `cancelled` and `outcome_unknown` terminal states | absent from `ToolState` union |
| exactly-once settlement | no invocation record; duplicate settlement relies on in-process `tool.settled` flags in the publisher and registry identity checks |
| idempotency / execution receipt | absent (see §1.2) |
| crash after side effect, before result persistence | unhandled: a restart re-admits the turn with no record that the call may have run |

**Acceptance criteria (§2.2):**

- [ ] Crash after tool start but before result persistence is recoverable — **fails**
- [x] Duplicate tool event delivery does not duplicate the side effect — **holds in-process only**
      (publisher `settled` check + registry identity), not across restart
- [x] Invalid streamed JSON never invokes the tool — **holds** via decode before execute; see
      the `{}` caveat in §9
- [ ] Missing result is represented explicitly as unresolved/outcome-unknown — **fails**
- [ ] Retried tool execution uses the same logical idempotency identity — **fails**

### 2.3 Child-agent lifecycle — PARTIAL

**Normative.** Durable parent/child linkage; parent wait terminates on any child terminal;
out-of-band child death observable; turn-limit distinct from success; parent cancellation
propagates; child failure does not disappear.

**Evidence.**

- Parent linkage is durable: `session.parent_id` (`core/src/session/sql.ts:31`, index at 64),
  and the V1 subagent creates the child with `parentID` and derived permissions
  (`packages/opencode/src/tool/task.ts`, `sessions.create({ parentID: ctx.sessionID, ... })`).
- Parent cancels children: the foreground task installs an abort listener that calls
  `ops.cancel(nextSession.id)` and cancels the background job on interrupt
  (`task.ts`, `onAbort` / `Effect.acquireUseRelease` release path).
- Parent waits on events, not sleeps: `background.wait` / `background.waitForPromotion`.
- Child failure surfaces as a tool failure with the child ID: `"Subagent failed (task_id: ...)"`
  (`task.ts`, `runTask`).
- Resume is parent-linked in the same durable field: `task.ts` refuses a `task_id` whose
  `parentID !== ctx.sessionID`, so a caller cannot point the task tool at a session it does
  not own (test `execute rejects a task_id that is not a subagent of the calling session`).
- Turn-limit terminal: when an agent with a `steps` allowance exhausts it, `prompt.ts` writes
  `TURN_LIMIT_REASON` (`core/src/session/runner/max-steps.ts`) as the assistant message error
  and `task.ts` surfaces it as `Subagent failed (task_id: …, reason: turn_limit): …`, so a
  turn-limited child is distinct from success (tests `loop marks an exhausted step limit as a
  turn limit, not a completed turn` and `execute surfaces a child turn limit distinctly from
  success`).

**Gaps.**

- Background job status is in-memory; `core/src/background-job.ts:115` documents that a
  restart loses status and interrupts. There is no durable child terminal state and no
  `worker_lost`/`cancelled`/`turn_limit` state vocabulary.
- Turn-limit exhaustion is distinguishable only on the terminal path: `MAX_STEPS_PROMPT` is
  advisory, so a child that keeps calling tools past its allowance is neither stopped nor
  marked. The reason also travels as an `UnknownError` message rather than a typed variant
  (adding one would change the shared V1 message schema).
- V2 core has no child-agent tool at all; this section currently audits the V1 `task` path.
- Multiple terminal events: single `background.wait` per task makes double resolution
  unlikely, but there is no durable settle-once guard.

**Acceptance criteria (§2.3):**

- [x] Killing a child worker releases the parent wait — holds in-process (interrupt of the
      wait fiber), unverified across restart
- [x] Child turn-limit failure surfaces distinctly — holds for V1 subagents that stop at the
      limit (`reason: turn_limit`); a child that ignores `MAX_STEPS_PROMPT` is not stopped
- [x] Parent restart preserves child linkage — holds (`session.parent_id`, durable)
- [x] Multiple child terminal events cannot resolve the parent twice — holds in-process, not
      durable

---

## 3. Durable queue and scheduling

### 3.1 Durable turn queue — PARTIAL

**Evidence (satisfied).** `session_input` is a durable admission inbox with
`admitted_seq`, `promoted_seq`, `delivery`, and unique indexes
(`core/src/session/sql.ts:140–165`; `session/input.ts`). Admission is idempotent by message
ID and conflicting reuse fails (`input.ts:37–151`, `LifecycleConflict`). Promotion writes the
visible user message and the inbox marker in one event transaction
(`specs/v2/session.md`).

**Gaps.** No lease/visibility timeout, no persisted retry count, no ack-after-settlement
contract, no poison quarantine, no crash-before/after-claim reclaim path. Queue wakeups are
advisory (`SessionExecution.wake`), so a crashed claim is simply never retried.

**Acceptance criteria (§3.1):**

- [x] Crash before claim: turn remains pending — holds (`session_input` rows persist)
- [ ] Crash after claim: reclaimable after lease expiry — **fails** (no lease)
- [ ] Duplicate queue delivery does not duplicate execution — in-process only
- [ ] Repeatedly failing turn quarantined — **fails**
- [x] One wedged item does not block unrelated sessions — holds; the coordinator is keyed by
      session ID (`run-coordinator.ts`)

### 3.2 Worker readiness barrier — N/A (single process)

There is no worker dispatch: `SessionExecutionLocal` is process-global and Location-scoped
services are initialized by the layer graph before requests are served
(`core/src/effect/layer-node.ts`, `location-services.ts`). A `READY` record with
`worker_epoch`/`registry_epoch` has no consumer today.

**Residual risk.** If the dispatch model changes (the assurance spec's premise), the
readiness gate must be introduced with it. The nearest current equivalent is the empty
`initProjectors()` hook (`packages/opencode/src/server/projectors.ts:1`) — an intentional
no-op.

---

## 4. Tool and hook registration

### 4.1 Versioned registry snapshot — GAP

**Evidence.** `core/src/tool/registry.ts`: registrations live in an in-memory
`Map<string, Array<{token, registration}>>`; `materialize()` captures registration
identities for stale-call detection (`registry.ts:106–124`); `register()` appends per name
and removes by scope finalizer (`registry.ts:84–104`). Application tools are stored in
`State` (`core/src/tool/application-tools.ts`). There is no `registry_epoch`,
`registry_hash`, `handler_owner`, or replay after reconnect.

**Acceptance criteria (§4.1):**

- [x] Reconnecting 1,000 times does not increase hook count — **not guaranteed**: each
      `register()` pushes another entry; cleanup depends on the registering scope closing.
      MCP republish replaces the snapshot wholesale (`packages/opencode/src/mcp/tool-snapshot.ts`,
      `publish` → `snapshot.set`), which is closer to the required behavior but is still
      in-memory.
- [ ] Stop/approval commands survive reconnect — **unverified** (V1 plugin/hook paths not
      audited in this pass; V2 approvals are in-memory, so they do not survive restart)
- [ ] Runtime reload does not lose tool ownership — **fails** (no persisted ownership)
- [x] Different workers cannot silently flap one tool — N/A single process

### 4.2 Registration ownership — PARTIAL

**Evidence.** Stale-owner rejection exists per materialization: `settleWith` compares
`registration.identity !== advertised` and returns `"Stale tool call"` (`registry.ts:50–60`).
MCP tools are keyed by canonical directory and republished atomically
(`mcp/tool-snapshot.ts`, `key`/`publish`/`invalidate`).

**Gaps.** No owner epoch, no persisted ownership record, no handoff protocol; the MCP
snapshot is process-global module state shared across Effect graphs (documented intentionally
in `tool-snapshot.ts`). A reconnecting MCP client replaces tools without a version to detect
that the set changed semantically.

---

## 5. Cancellation and stop semantics

### 5.1 Monotonic cancellation — PARTIAL

**Evidence.** Interrupt exists and is wired end to end for the running process:
`V2Session.interrupt` → `SessionExecution.interrupt` → coordinator interrupt + prompt
dismissal (`core/src/session.ts:461–462`, `session/execution/local.ts`), pending permission
and question prompts are rejected (`core/src/permission.ts:302–303`, `core/src/question.ts`,
both `uninterruptible`), and the coordinator sets `stopping`, clears `pendingWake`, and
interrupts the owner fiber (`run-coordinator.ts`, `interrupt`).

**Gaps (all from the spec's required invariants).**

- No durable cancellation state: stop is a fiber interrupt, not a persisted transition.
- No epoch/CAS guard: a terminal event published by a worker that lost the race is not
  rejected because there is no owner epoch on any row.
- Provider abort: V1 passes `abortSignal` into the AI SDK (`packages/opencode/src/session/llm.ts:187`,
  `:379`); V2 relies on fiber interruption of `llm.stream`. Subprocess termination exists
  (`core/src/shell.ts` SIGTERM→SIGKILL, `core/src/pty.ts:121`), but its coupling to
  cancellation of a *tool* fiber is **unverified**.
- No descendant cancellation for V2 (V2 has no children); V1 propagates via abort listeners.

**Acceptance criteria (§5.1):**

- [ ] Stop concurrent with completion yields one legal terminal state — **fails** as a
      durable guarantee (last writer wins in process)
- [ ] Old worker writes cannot overwrite cancellation — **fails** (no epoch)
- [ ] Cancelled subprocesses do not continue silently — **unverified**
- [x] Cancellation propagates to descendants — holds for V1 foreground tasks

---

## 6. Retry and recovery policy

### 6.1–6.2 Retry classes and rules — PARTIAL

**Evidence (satisfied).**

- Provider-turn retry is a distinct class with bounded attempts, exponential backoff, and
  jitter: `MAX_RETRIES = 5`, `INITIAL_DELAY_MS = 2000`, `BACKOFF_FACTOR = 2`,
  `JITTER_FACTOR = 0.25`, `MAX_BACKOFF_MS = 30000` (`core/src/session/runner/retry.ts`).
- Retry hints (rate limit / retry-after) are honored and capped
  (`retry.ts`, `delayMs`; `MAX_HINT_MS` guard).
- Only pre-assistant-start failures retry; the last allowed attempt settles directly so the
  budget is not burned on an extra billable call (`runner/llm.ts:511–546` and the comment at
  `:539–540`).
- Transport-level retry is separate: `retryStatusFailures` in `packages/llm/src/route/executor.ts`.
- Context overflow is handled by a distinct path, not the retry counter
  (`runner/llm.ts`, `ContinueAfterOverflowCompaction`, bounded to one post-compaction
  attempt).

**Gaps.**

- Retry attempt count is an in-memory recursion parameter (`runAttempts(retries)`), not
  persisted; restart does not resume or account for it.
- No total deadline per operation (only per-attempt backoff caps).
- No tool-retry class; no queue-retry class; no `worker recovery`/`reconciliation retry`
  classes (they have nothing to attach to yet).
- Deterministic failures are not fingerprinted (no poison store, §7).

**Acceptance criteria (§6.2):**

- [x] A one-attempt budget cannot kill nearly complete work without explicit state — holds
      via the `settle` flag
- [ ] Deterministic poison stops after a policy threshold — **fails** (§7)
- [ ~ ] Restart does not rerun a doomed call forever — trivially true today because restart
      reruns nothing; this becomes a real requirement once recovery exists
- [ ] Retry metadata survives restart — **fails**

---

## 7. Poison message handling — GAP

No failure fingerprint store exists. Searches for `failure_fingerprint`,
`poison`, `quarantine` find nothing in runtime code (only `orphaned` in unrelated UI/test
strings). There is no attempt counter, no first/last failure time, no input hash, and no
operator clear path. The nearest construct is `session_input` conflict detection, which
prevents duplicate admission but does not classify or bound repeated failure.

Acceptance criteria (§7): all fail.

---

## 8. Provider stream semantics

### 8.1 Transport close is not completion — GAP

**This is the highest-severity finding in this audit.**

**Evidence.**

1. The OpenAI Chat protocol only emits a finish when a `finish_reason` was observed:
   `finishEvents(state)` → `if (reason) Lifecycle.finish(...)`, wired as `onHalt`
   (`packages/llm/src/protocols/openai-chat.ts:462–471`, `:491`). `onHalt` runs when the upstream
   frame stream ends (`packages/llm/src/route/client.ts:291`), so a socket close mid-stream
   produces a normal stream end with **no** finish event.
2. The V2 runner treats that as a normal end: `stepSettlement` is only set by a `step-finish`
   event (`publish-llm-event.ts:396–400`), and the post-stream block publishes `Step.Ended`
   only `if (stepSettlement && !hasProviderError())`, then returns
   `needsContinuation = !hasProviderError() && needsContinuation`
   (`runner/llm.ts:483–504`). With no finish event and no tool calls, the turn drains as if
   it had completed.
3. Nothing validates that the stream yielded at least one terminal event. There is no
   corresponding check in `route/executor.ts`; errors are only produced for HTTP status and
   transport failures (`executor.ts:328–329` is error *classification*, not a deadline).

**Effect.** A truncated response can leave an assistant message without `Step.Ended`, a
`busy → idle` status transition, and no retry — violating §8.1, §1.3, and §33.

### 8.2 Semantic activity vs keepalive activity — GAP

There are no timeouts in the provider runtime. A search for `timeout|deadline` in
`packages/llm/src` matches only the retryable-message matcher (`llm/src/retry.ts:16`) and
timeout *error classification* (`route/executor.ts:328–329`). No connect, first-byte,
semantic read-idle, or total request deadline is configured. `last_transport_activity_at`
and `last_semantic_activity_at` do not exist.

**Acceptance criteria (§8.2):**

- [ ] Endless keepalive frames eventually time out — **fails**
- [ ] Mid-delta disconnect is not reported as success — **fails** (§8.1)
- [ ] Socket close during tool arguments creates an incomplete-call failure — **fails**
      (the tool call is simply never emitted; see §9)
- [ ] No upstream client waits forever without a deadline — **fails** in the LLM runtime

---

## 9. Incremental stream parsing — PARTIAL

**Evidence (satisfied).**

- Tool argument accumulation is explicit and structured (`packages/llm/src/protocols/utils/tool-stream.ts`,
  used by all protocol adapters); malformed JSON fails the stream at the boundary rather than
  at halt (`openai-chat.ts:440–444`, eager `finishAll` when `finish_reason` arrives).
- No partial JSON is ever executed: arguments are parsed before `LLMEvent.toolCall` is
  emitted, and `Tool.settle` decodes again before `execute`.

**Gaps.**

- Empty streamed input is normalized to `{}`: `parseToolInput` (`packages/llm/src/protocols/shared.ts:149–157`)
  doc-comments "Treats an empty string as `\"{}\"` — providers occasionally finish a tool
  call without ever emitting input deltas". This is precisely the pattern §2.2 forbids. The
  follow-on schema decode catches most cases, but a zero-argument tool invoked after a
  truncated stream would execute.
- Truncation at halt is not represented: `toolCallEvents` are only emitted at finish, so a
  call cut mid-arguments vanishes without an explicit `truncated`/incomplete marker.
- No incremental size limit on streamed arguments (the spec's `partial/complete_valid/
  complete_invalid/truncated` vocabulary does not exist as a type).
- The spec's "600-character notification limit" criterion is not present in this codebase;
  the nearest arbitrary-offset truncation is `truncateOutput` at 2000 chars used as
  summarization input (`core/src/session/compaction.ts:84–85`).

**Acceptance criteria (§9):**

- [x] Cut a JSON payload at every byte position; no prefix is accepted as complete — holds
      for non-empty payloads (parse-before-emit), **not proven by a test matrix**
- [ ] The notification limit cannot produce malformed JSON — N/A in this codebase
- [ ] Large arguments fail with a specific size error — **fails** (no argument size bound)

---

## 10. Permission and approval enforcement

### 10.1 Fail closed — PARTIAL

**Evidence.**

- Unknown action/resource defaults to `ask`, not `allow`
  (`core/src/permission.ts`, `evaluate`: fallback `{ action, resource: "*", effect: "ask" }`).
- A missing/unresolvable agent gets `missingAgentPermissions = [{ action: "*",
  resource: "*", effect: "deny" }]` (`permission.ts`, top of file; `configured`).
- `deny` wins over `ask` over `allow` when multiple resources are evaluated
  (`evaluateInput`).
- Rules and requests are Effect Schemas (`Permission.Ruleset`, `Permission.Request`), so
  structurally invalid rules fail decode rather than degrade to a permissive value.

**Gap.** There is no test or runtime guard asserting that *malformed deny configuration*
blocks execution (the spec's explicit criterion), and the interaction between config load
failure and server startup has not been traced in this audit (**unverified**). The `default:
ask` behavior is fail-closed for unknown verbs, which is the important half.

### 10.2 Execution-time authorization — PASS

**Evidence.** Every V2 local tool calls `permission.assert` inside its `execute` body,
immediately before the side effect:

- `write.ts:73,79`, `edit.ts:142,152`, `apply-patch.ts:109,116`, `bash.ts:132,142`,
  `read.ts:63,72`, `glob.ts:69`, `grep.ts:88`, `webfetch.ts:138`, `websearch.ts:209`,
  `todowrite.ts:41`, `skill.ts:76`.

Catalog omission is defense in depth only: `whollyDisabled` removes deny-`*` tools from the
advertised definitions (`registry.ts:106–124`), and `materialize` is recalculated per step.
The authorization boundary is the assert at execution, which is what the spec requires.

### 10.3 Approval single-use semantics — PARTIAL

**Evidence.** `pending` is an in-memory `Map<ID, Pending>` with a `Deferred` per request
(`core/src/permission.ts`). `reply` runs `uninterruptible`, rejects or resolves the deferred,
and deletes the pending entry (`permission.ts:222–288`); `interrupt` rejects all pending
requests for a session (`:302–303`). Because a `Deferred` resolves once, a second approval
cannot resume a second execution — the spec's "two simultaneous approvals cannot execute one
shell command twice" holds at the execution boundary.

**Gaps.**

- No explicit `expired` state; approval lifetime is the process lifetime.
- Pending approvals do not survive restart, and nothing consumes a nonce/token durably.
- Concurrent replies can publish duplicate `Event.Replied` events (both callers can observe
  `existing` before either deletes), even though execution happens once.
- `"always"` grants persist to `PermissionTable` (`core/src/permission/sql.ts`,
  `PermissionSaved`), which is the one durable piece.

---

## 11. Locking and concurrency — PARTIAL

**Evidence.**

- File mutations serialize per canonical target with a keyed mutex and run the compare/write
  under the lock (`core/src/file-mutation.ts`, `KeyedMutex.makeUnsafe`, and
  `file-mutation.ts:82` `locks.withLock(target.canonical)(Effect.uninterruptible(effect))`).
- Database transactions are built with `uninterruptibleMask` in both drivers
  (`core/src/database/sqlite.bun.ts:123`, `sqlite.node.ts:117`).
- The run coordinator avoids holding a lock across a drain: the `active` map is only touched
  synchronously; `drain` runs outside it (`run-coordinator.ts`).
- Background jobs and PTYs are scope-owned (`background-job.ts:203,257`).

**Gaps.** There is no documented lock-order contract, no CI test that deliberately exercises
opposite interleavings (parent retask vs child finish; cancel vs complete), and replay is not
performed under a lock at all today, so the spec's specific replay deadlock is absent rather
than prevented.

---

## 12. Context accounting — GAP

There is no context ledger. `ContextEntry`-style identity (`entry_id`, `source_type`,
`content_hash`, `token_count`, `retained`, `epoch`) does not exist. Context is recomputed ad
hoc per turn: `SessionHistory.entriesForRunner` → `prune` → token estimation with
`Token.estimate` (`core/src/util/token`, used in `session/compaction.ts` and history
projection). The durable `session_context_epoch` table stores the baseline and snapshot
(`core/src/session/sql.ts:168`, `session/context-epoch.ts`) but no per-contribution ledger.

Acceptance criteria (§12): all fail. Duplicate-source rejection and reconstructable token
totals are not carried as invariants anywhere.

---

## 13. Model capability limits — PARTIAL

**Evidence.**

- Catalog limits flow into the route: `limits: { context: model.limit.context, output:
  model.limit.output }` (`core/src/session/runner/model.ts:105`).
- Unknown limits are `0`, not 8192: `packages/schema/src/model.ts:82–85` defines
  `limit: { context: Int, output: Int }` and the default entry sets
  `limit: { context: 0, output: 0 }` (`schema/model.ts:104`). Capabilities default to
  `{ tools: false, input: [], output: [] }` (`schema/model.ts:97`).
- Compaction refuses to act when context is unknown: `if (context === undefined || context
  <= 0) return false` (`session/compaction.ts:245–247`, `:300–302`).

**Gaps.** The spec's options are (1) verified metadata, (2) explicit conservative override,
(3) an actionable capability error. Choosing "silently disable compaction" is none of them:
the user gets no signal that context management is off, and there is no documented override
path or versioned/auditable limit update. Capability fields exist (`supports_tools` analog
`capabilities`, `capabilities.reasoning`) but are not surfaced as execution errors.

---

## 14. Compaction — PARTIAL

**Evidence (satisfied).**

- Candidate summary is computed before replacing live context: `compactAfterOverflow`
  streams the summary, then publishes `SessionEvent.Compaction.Ended`
  (`session/compaction.ts`).
- Validity gate: empty/whitespace output is rejected (`if (!summarized || failed ||
  !summary.trim()) return false`), and the prompt is refused if it would not fit
  (`if (Token.estimate(summaryPrompt) > context - summaryOutput) return false`).
- Pruning operates on copies and preserves tool parts structurally
  (`pruneToolOutput`, `pruneEntries`).
- Overflow recursion is bounded: a second post-compaction overflow is a die, not another
  compaction (`runner/llm.ts`, `runAfterOverflowCompaction`).

**Gaps.**

- No verification of *meaningful reduction*: the candidate is not measured against the input
  before `Compaction.Ended` commits, so "success" is a return value, not a measured delta.
- No convergence controls: no `max_consecutive_compactions`, no minimum absolute/percentage
  reduction, no hysteresis. `compactIfNeeded` can fire on every turn if the request stays
  over budget. **Partly addressed in the 2026-09-23 pass:** a compaction with nothing outside
  the retained tail is skipped with a warning instead of re-summarizing the prior summary, and
  the newest turn is retained whole, so a firing compaction always removes the summarized head.
  An explicit reduction measurement and hysteresis are still absent.
- `Compaction.Started` is published before the summary is known to succeed; on failure there
  is no `Compaction.Failed` event, so started-without-ended is an observable state. **Partly
  addressed in the 2026-09-23 pass:** every failure path now logs `Compaction summary failed`
  with a reason and the `messageID` of the dangling `Started`; the durable event is still
  deferred because it would change the public session event schema.
- Summarization input truncates tool content at 2000 chars (`truncateOutput`), which is a
  lossy heuristic, not structurally validated dropping.
- **Auto-compaction fires far below the model window — measured defect, reported by the user
  on 2026-09-23.** `compactIfNeeded` compares `Token.estimate(request)` with
  `context - max(requested output, buffer)` (`session/compaction.ts:300–302`). The runner never
  sets `request.generation.maxTokens` (`runner/llm.ts` builds `LLM.request({...})` with no
  `generation`), so `output` falls back to the catalog's *maximum* output: for
  `deepseek/deepseek-flash` (1,000,000 context / 384,000 output in
  `~/.cache/opencode/models.json`, refreshed 2026-09-23) the budget is 616,000 estimate units
  instead of the 968,000 that reserving a real output allowance would give. `Token.estimate`
  (`core/src/util/token`) then spends that budget ~2.5x too fast because it charges one token
  per JSON structural character: measured over `ses_f36d85835ffesG3sKZegqW32nz` (125 messages,
  1,386,762 chars of stored JSON) it returned 736,527 for a turn the provider billed at
  297,583 tokens (2.48x). Together they trigger compaction at ~250–300k real tokens, ~30 % of
  the advertised window. Four proactive compactions were observed in that session
  (`deepseek-flash`, variant `max`) — each one after a normal `finish: "tool-calls"` /
  `"stop"` turn with `error: null`, at reported context counts of 297,583 / 292,940 / 297,742 /
  281,157 — so none of them was overflow recovery. **Fixed in the 2026-09-23 pass** (see the
  compaction + readiness section below): `reserve()` bounds the output reserve and
  `requestTokens()` anchors the measurement on the provider-reported usage of the last counted
  turn.
- V1 and V2 disagree on the same model: `session/overflow.ts` triggers on *reported* usage
  (`tokens.total || input + output + cache.read + cache.write`) and reserves
  `min(COMPACTION_BUFFER = 20_000, maxOutputTokens(model))`, i.e. ~968k reported tokens for
  that model, so the effective window changes ~3.5x depending on which runtime the session
  runs on. Fix direction: reserve the *requested* output (or a bounded default such as
  `ProviderTransform.OUTPUT_TOKEN_MAX = 32_000`) rather than the catalog maximum, and calibrate
  the budget comparison — compare reported usage where a previous turn exposes it (the V1
  approach) or apply a measured correction factor to `Token.estimate`.

**Acceptance criteria (§14):**

- [x] Empty compaction output cannot replace context — holds
- [x] Auto-compaction fires at the advertised window — **fixed 2026-09-23** (reported-usage
  measurement plus a bounded output reserve; see the compaction + readiness section)
- [ ] Sixteen nonproductive compactions terminate with an explicit error — **partial
  (2026-09-23)**: an unproductive compaction is skipped with a warning instead of repeating;
  there is still no explicit error event
- [x] A 5 MB hook result is not injected verbatim — holds via the output store (§15)
- [ ] Compaction success means measurable reduction — **fails**

---

## 15. Large result handling — PASS

**Evidence.** `core/src/tool-output-store.ts`: outputs over `MAX_LINES = 2000` or
`MAX_BYTES = 50 KiB` are written to a managed file under the global data dir, and the model
receives a bounded head/tail preview plus a `... full content saved to <path> ...` marker
(`bound`, `preview`, `boundedPreview`). Limits are configurable through
`tool_output.max_lines/max_bytes`. Full content is retrievable, including by `grep` which
accepts an absolute managed tool-output file path. Files are retained 7 days and swept hourly
(`RETENTION`, `cleanup`, `cleanupLayer`). The store is applied at the registry boundary
(`tool/registry.ts`, `settleWith` → `resources.bound`), so hook/tool output cannot bypass it.

**Minor gap vs the spec's metadata list.** The reference is a path marker, not a structured
record with `content_type`, `byte_length`, `content_hash`, `reference_id`, or a `truncated`
boolean. `structured` output is preserved unmodified (not truncated), which is good for
correctness and bad for accounting.

---

## 16. Context retention policy — PARTIAL

**Evidence.** Retention is not size-only: tool pruning keeps the most recent two turns and
protects 40k tokens, pruning only past a 20k minimum and never pruning `skill` results or
provider-executed tools (`compaction.ts:13–18`, `selectPrunedToolIDs`). Tool-output files
carry a 7-day retention with hourly cleanup (`tool-output-store.ts`).

**Gaps.** There is no global context budget tying retention to the ledger (there is no
ledger), and cache reads are not tracked as a retention input, so the spec's
"repeated cache reads do not force a permanent high token floor" is unaddressed.

---

## 17. Usage and billing accounting — PARTIAL

**Evidence (satisfied).**

- Per-step tokens carry a non-overlapping breakdown: `input`, `output`, `reasoning`,
  `cache: { read, write }` (`core/src/session/usage.ts`, `Tokens`), mapped from provider
  semantics at the adapter boundary (`packages/llm/src/protocols/*`, e.g. `openai-chat.ts`
  `mapUsage`, `anthropic-messages.ts` `mapUsage`, which subtract cached tokens).
- Cost math is centralized (`SessionUsage.stepCost`), including cache rates and context
  pricing tiers.
- Roll-up is derived, not accumulated: after every `Step.Ended` projection the session
  aggregate columns are recomputed from assistant rows (`session/projector.ts`,
  `rollSessionUsage`; migration `20260907120000_roll_v2_session_usage.ts` backfills the same
  way). The event log rejects duplicate sequences (`event.ts:262–313`), so a duplicate
  `Step.Ended` cannot double-count.
- Raw provider payloads are retained on the step message (`providerMetadata` from the
  adapters), so provider totals are traceable to the response.

**Gaps.** No `provider_response_id` or `raw_usage_payload_hash` field, so reconciliation
cannot be rerun idempotently against a provider response; there is no separate usage ledger
table (usage is embedded in assistant message JSON and re-derived by JSON extraction), which
makes "cache reads and writes are distinct" true per step but not queryable as a ledger.

---

## 18. Prompt cache stability — PARTIAL

**Evidence.**

- The Context Epoch baseline is immutable for the life of the epoch; changes are admitted as
  chronological system updates, not by rewriting the prefix (`CONTEXT.md`; `session/context-epoch.ts`;
  `SessionContextEpochTable`).
- Tool definitions are sorted deterministically before advertisement:
  `[...registrations].toSorted(([left], [right]) => left.localeCompare(right))`
  (`tool/registry.ts:116`), so tool order does not drift with registration order.
- A stable prompt cache key is derived from the session ID (`runner/llm.ts`, `promptCacheKey`).

**Gaps.** No prefix hash observability, and no test asserting that two semantically identical
sessions produce identical stable-prefix hashes. Determinism of the baseline renderer
(`system-context`) was not verified in this pass (**unverified**); any per-session timestamp
or nonce in a baseline renderer would silently destroy cache efficiency, which is exactly the
failure mode the spec asks to make observable.

---

## 19. Tool schema budget — GAP

No token measurement or budget exists for tool schemas or descriptions. Definitions are built
per materialization (`tool/registry.ts`, `definition(name, tool)`), descriptions are inline
strings in each tool module, and there is no CI check for `max_tool_description_tokens`,
`max_single_tool_schema_tokens`, `max_total_schema_tokens`, or `max_prose_percentage`.
Acceptance criteria (§19): all fail.

---

## 20. Identifier safety — PASS

**Evidence.**

- Authoritative IDs are generated with a fixed prefix plus timestamp-bearing identifier
  (`core/src/id/id.ts`, `create` → `@opencode-ai/schema/identifier`), used as opaque strings
  in equality, joins, and lookups.
- Uniqueness is enforced in the database for every authoritative identity: primary keys on
  `session`, `message`, `part`, `session_message`, `session_input`, and unique indexes on
  `session_message(session_id, seq)` (`session/sql.ts:133`) and
  `session_input(session_id, admitted_seq|promoted_seq)` (`sql.ts:163–164`).
- No truncation-based or case-folded identity comparison was found. The one prefix check
  (`generateID`: given ID must start with its prefix) is validation that throws, not a
  shortened comparison.
- Human-facing display strings (slugs/titles) are separate columns from IDs.

---

## 21. Result representation — PARTIAL

**Evidence.** Tool results are a tagged union, but a narrower one than the spec:
`ToolResultValue = json | text | error | content` (`packages/llm/src/schema/messages.ts:50–78`)
and durable tool state `pending | running | completed | error`
(`packages/schema/src/session-message.ts:116–119`).

**Gaps.**

- No `empty`, `cancelled`, or `outcome_unknown` kinds.
- `ToolOutput.toResultValue` maps an empty-content output to `{ type: "json", value:
  output.structured }` (`messages.ts:104`), so JSON `null` remains `null` (good) but an
  empty *successful* output is not distinguishable from a JSON `null` value.
- SDK-boundary `undefined` handling: the V2 runner never yields undefined tool results
  (settlement always returns a tagged result); the infinite-unresolved-loop criterion could
  not be triggered from this path (**unverified** for V1/SDK boundaries).

---

## 22. Completion waiting and status observation — PASS

**Evidence.**

- Waits are event-driven: `Deferred`/fibers in the coordinator, `background.wait` +
  `waitForPromotion` for children, `Deferred.await` for permission replies.
- Status is a control-plane event stream (`SessionStatusEvent.Status` busy/idle/retry,
  published from `session/execution/local.ts` and `runner/llm.ts`), not a model turn.
- The only periodic poll found is client health at 10s with a bounded retry count
  (`packages/app/src/utils/server-health.ts:164`, `:76–99`). No `sleep`-based completion wait
  exists in the runtime; the subagent prompt text that says "DO NOT sleep, poll" is backed by
  event delivery, not just instruction.

**Caveat.** Polling coalescing/rate-limiting for status reads in the app was not audited in
depth; the criterion "generated clients cannot poll at 140 Hz indefinitely" is unverified.

---

## 23. Execution profile inheritance — PARTIAL

**Evidence.**

- Child sessions inherit parent linkage and permissions: `sessions.create({ parentID,
  permission: [...childPermission, ...childToolDenies] })`, with permission derivation from
  the parent session (`packages/opencode/src/tool/task.ts`, `deriveSubagentSessionPermission`).
- Model/variant inheritance is explicit: the child uses `next.model` when the agent defines
  one, otherwise the parent assistant message's model, and the parent's variant is inherited
  only when the agent has no explicit model (`task.ts`, `model`/`variant` selection).
- Tool denials are applied to the child permission set (todowrite, nested task, primary tools).

**Gaps.** There is no `ExecutionProfile` record and no telemetry comparing parent and child
budgets; `context_limit`/`output_limit` are resolved from the model at run time, not carried
with the child; `tool_registry_epoch` does not exist (§4). The criteria "child budget
differences are visible in telemetry" and "settings can be compared deterministically" fail.

---

## 24. Dependency graph safety — PARTIAL

**Evidence.** Plugin load cycles are detected and fatal:
`if (loading.has(id)) return yield* Effect.die(\`Plugin load cycle detected for ${id}\`)`
(`core/src/plugin.ts:44`).

**Gap.** The spec's resource-limit semantics do not exist because no graph-size limit exists:
there is no documented/configurable size cap, so the failure mode of "a valid graph is
mysteriously uninstallable because of a magic number" is absent but the actionable
oversize-error behavior is also absent. Whether this section maps to npm dependency
installation in `core/src/npm.ts` is **unverified**.

---

## 25. Process and supervisor ownership — PARTIAL

**Evidence.**

- The agent runtime exposes no self-restart capability: a search for `restart` across
  `packages/opencode/src` finds only shell permission arity entries and a UI string
  ("until OpenCode is restarted"). There is no endpoint or tool that replaces the process.
- The desktop shell supervises the sidecar as a child process
  (`packages/desktop/src/main/server.ts` → `utilityProcess.fork`); the sidecar closes with a
  graceful shutdown timeout of 1 second (`packages/opencode/src/server/server.ts:214`).
- `bash` can of course run arbitrary host commands once authorized — that is user-authorized
  shell, not an implicit supervisor capability.

**Gaps.** No persisted process identity/epoch is observable, and there is no drain-then-
replace protocol in the runtime (replacement is the desktop's concern). The acceptance
"restart cannot orphan active state without reconciliation" fails for the same reason as §3:
there is no reconciliation.

---

## 26. Port and instance ownership — PARTIAL

**Evidence.** One Node HTTP listener is created per server start with a configured
host/port and a 1s graceful shutdown (`server.ts:199–214`, `:87–92`). Binding exclusivity is
delegated to the OS, so two runtimes cannot both own the same port; a bind failure fails the
server layer (fatal).

**Gaps.** No instance ID or process epoch is persisted or exposed, and stale-owner reclaim
logic does not exist, so service discovery cannot distinguish a restarted instance from the
previous one.

---

## 27. File and directory safety — PASS

**Evidence.**

- File reads: `MAX_READ_LINES = 2000`, `MAX_READ_BYTES = 50 KiB`, per-line truncation at 2000
  chars, media ingest cap `20 MiB` (`core/src/tool/read-filesystem.ts:11–15`, `:74`, `:189–200`).
- Directory/file search: default result limit 100 with an explicit model-visible notice when
  the limit was reached (`core/src/tool/glob.ts:17,33–38`, `grep.ts:18,39–44`;
  test coverage in `packages/core/test/tool-glob-grep-limit.test.ts`).
- Shell: 10-minute max timeout, 1 MiB capture cap with an explicit truncation marker
  (`core/src/tool/bash.ts:20–21`, `:170`, `:188`).
- Oversized tool output is externalized with a bounded preview (§15).

**Minor gap.** There is no explicit `max_directory_entries`/`max_total_listing_bytes` for a
naive directory listing path outside glob (glob's limit covers the advertised tool).

---

## 28. Replay and recovery log design — PARTIAL

**Evidence (satisfied).**

- The durable log is append-only per aggregate with sequence, owner, duplicate rejection, and
  divergence detection (`core/src/event.ts:236–350`, `:441–508` `replay`/`replayAll`).
- Session state loads from the projection (`session_message`), not by replaying the whole
  event log on every read (`session/history.ts` → `entriesForRunner`), so the spec's
  "full synchronous replay under a global mutex" failure mode is not present.
- Replay is test-covered for contiguous chunks and later batches
  (`packages/core/test/event.test.ts:700–750`).

**Gaps.** No periodic snapshot/checkpoint; no bounded replay batches; no replay progress
reporting; no corrupted-event detection beyond divergence/sequence errors; startup does not
replay at all (`packages/opencode/src/server/projectors.ts:1` is an empty `initProjectors`).
Recovery time is therefore "whatever a caller does", not a designed property.

---

## 29. Cleanup semantics — GAP

The only cleanup with a defined contract is the tool-output sweep, and it is best-effort:
`ToolOutputStore.cleanup` returns `void`, swallows directory/stat/remove failures with
`Effect.catch(() => ...)`, and is scheduled hourly
(`core/src/tool-output-store.ts`, `cleanup` and `cleanupLayer`). There is no
`cleanup_succeeded/failed/timed_out/skipped/not_required` result, no bounded retry, and a
failed cleanup is indistinguishable from an empty one. PTY removal emits an event
(`core/src/pty.ts:57`) but cleanup failure there is likewise not modeled as a result.

Acceptance criteria (§29): fail.

---

## 30. Telemetry and trace safety — PARTIAL

**Evidence (satisfied).**

- Token deltas are coalesced: text/reasoning/tool-input fragments accumulate in memory and
  publish a single `*.Ended` durable event per fragment
  (`session/runner/publish-llm-event.ts`, `fragments()` with start/append/end/flush).
- Tracing is an opt-in OTLP layer (`core/src/observability.ts`), not per-token spans by
  construction of the coalescing above.

**Gaps.** No trace byte/event/span budgets, no sampling policy, no dropped-event counters. A
search for `Metric`/`counter`/`histogram` in `packages/core/src` returns nothing, and no
`max_trace_bytes_*`/`max_span_count` tuning exists. Acceptance criteria (§30.3): fail.

---

## 31. Trace cache complexity — N/A

No trace/cache eviction structure exists in the hot path. The durable event log is database-
backed (append + indexed queries), and the only ring-buffer-like structure is the PTY output
buffer with absolute cursors and replay (`core/src/pty.ts:53–67`), which is cursor-based, not
a quadratic eviction scan. If a trace cache is added (§30 work), this section becomes
applicable and should be benchmarked then.

---

## 32. WebSocket / SSE reconnect policy — PARTIAL

**Evidence.** The found reconnect logic is HTTP health probing with a bounded retry count and
linear delay: `retryDelayMs * (count + 1)` with a timeout signal
(`packages/app/src/utils/server-health.ts:76–99`), plus a 10-second poll
(`server-health.ts:164`). It distinguishes abort/timeout (non-retryable) from transport
errors (`retryable`).

**Gaps.** No jitter, no health-state-driven backoff reset, and the event-stream (SSE) client's
own reconnect/registration-replay behavior was not located in this pass (**unverified**).
Acceptance criteria (§32): "reconnect storms are bounded" is plausible for health polling;
"registrations are restored before work resumes" cannot hold because registration is not
durable (§4).

---

## 33. Completion integrity — GAP

**Normative predicate.** `provider_terminal_received AND no_unresolved_tool_calls AND
no_required_child_waits AND output_valid AND durable_result_persisted AND
terminal_transition_committed`.

**Evidence against each term.**

| Term | Status |
|---|---|
| `provider_terminal_received` | **Not enforced** — see §8.1; no finish event is required for the turn to end |
| `no_unresolved_tool_calls` | Enforced for tools observed in-process: `failUnsettledTools` after stream end and at drain start (`runner/llm.ts:136–156`, `:503–504`) |
| `no_required_child_waits` | N/A in V2; V1 foreground tasks block on `background.wait` |
| `output_valid` | Not checked; no validation that any assistant content or finish reason exists |
| `durable_result_persisted` | Partially: assistant parts are projected as events arrive; there is no separate "result committed" marker |
| `terminal_transition_committed` | No turn record, so no transition to commit |

**Acceptance criteria (§33):**

- [ ] Provider close alone cannot satisfy completion — **fails**
- [x] Five subagents hitting a turn limit cannot all report completed — holds for V1 subagents
      that stop at the limit, which now carry a distinct `reason: turn_limit` terminal (§2.3);
      V2 core has no child-agent tool
- [x] An unfinished tool call prevents successful turn completion — holds in-process

---

## 34. Database / persistence invariants — PARTIAL

**Evidence (satisfied).**

- Uniqueness: primary keys throughout; `session_message(session_id, seq)` unique
  (`session/sql.ts:133`); `session_input(session_id, admitted_seq)` and
  `(session_id, promoted_seq)` unique (`sql.ts:163–164`).
- Event integrity: per-aggregate sequence with divergence detection and an "already exists"
  guard, plus `owner_id` bookkeeping (`event.ts:262–350`).
- `NOT NULL` terminal-ish fields: message `data`/`type`, event sequence numbers; session
  counters default 0.

**Gaps.** No `CHECK(valid_state_transition)`; no `version`/`epoch`/`revision` optimistic
concurrency column on messages, parts, or inbox rows (projectors write by primary key with
last-write-wins within the event transaction); no parent-turn FK because there is no turn
table. The spec's "concurrent stale writers detect conflicts" holds for the event log only.

---

## 35. Fault-injection test matrix — GAP

**Evidence.** Test suites exist and are substantive (`packages/core/test/session-runner*.test.ts`,
`session-run-coordinator.test.ts`, `event.test.ts`, `tool-output-store.test.ts`,
`permission.test.ts`, `tool-glob-grep-limit.test.ts`, plus recorded provider fixtures under
`test/fixtures/recordings/`). Duplicate-event behavior has some coverage through the event
log tests (`event.test.ts` replay/dedupe cases).

**Gaps.** There is no crash-point suite (queue claim, mid-stream, post-side-effect,
pre-terminal), no stream-truncation sweep (`for n in 0..len`), no duplicate-delivery matrix
for tool results/approvals/child completions, no cancel-vs-complete race tests, no provider
fault simulator beyond recorded fixtures, and no scale suite (large listing, huge tool output
beyond the store, trace flood, high-frequency polling).

Acceptance criteria (§35): fail.

---

## 36. CI assurance gates — GAP

CI runs tests and typecheck (`.github/workflows/test.yml`, `.github/workflows/typecheck.yml`)
but no gate maps to the assurance spec's P0/P1/P2 lists (terminal-state completeness,
exactly-once settlement, monotonic cancellation, fail-closed parsing, readiness, registration
replay, provider timeouts, quarantine, propagation, crash recovery, truncation, retry
budgets, compaction convergence, ledger consistency, trace budgets, eviction benchmarks).
The PR template (`.github/pull_request_template.md`) has no assurance section.

---

## 37. Recommended implementation priority

See "P0 implementation plan" below.

## 38. Suggested core types — GAP

`TurnRecord`, `ToolInvocation`, `InvocationResult` (with `empty`/`cancelled`/
`outcome_unknown`), and `WorkerReadiness` do not exist. The nearest shapes are
`ToolState` (`packages/schema/src/session-message.ts:81–119`) and `ToolResultValue`
(`packages/llm/src/schema/messages.ts:50–78`).

## 39. Required runtime metrics — GAP

No metrics registry exists (`Metric`/`counter`/`histogram` searches in `packages/core/src`
are empty). The listed counters (`turns_orphaned`, `tool_duplicate_execution_prevented`,
`provider_semantic_idle_timeouts`, `compaction_nonconvergent`, `trace_events_dropped`,
`poison_items_quarantined`, stale-worker write rejections, …) have no emission points, and
the alerting list has no backing signals. Logging exists (`core/src/observability/logging.ts`),
but counts are not exposed.

## 40. Definition of Done — PROCESS (unadopted)

Not adopted in any template or documentation found in the repo.

## 41. Master assurance rule — PROCESS (unadopted)

The rule is consistent with parts of the existing architecture (durable event log,
execution-time permission), but it is not stated anywhere in the repo. Adopting it should be
paired with the §36 gates so it is enforceable rather than aspirational.

## 42. PR assurance template — GAP

`.github/pull_request_template.md` exists and contains no assurance section. Adding the
spec's §42 block is a zero-risk change that can land independently of the runtime work.

## 43. Release assurance checklist — PROCESS (unadopted)

No release checklist exists in the repo.

---

# P0 implementation plan

The spec's §37 P0 list, sequenced against this codebase's architecture rules. Each slice
names the invariant, the enforcement point, and the acceptance test that must land with it.
The repo rule "tests cannot run from repo root; run from package dirs" applies
(`packages/core`, `packages/llm`).

## Blocker decisions (resolve before writing code)

1. **Durable turn identity vs the current "drain has no durable identity" rule.**
   Root `AGENTS.md` and `CONTEXT.md` state that a Session Drain has no durable identity and
   that crash continuation recovery requires a separate explicit design. The assurance spec
   requires durable turn records with ownership. The compatible resolution is to project a
   **turn record from already-durable `SessionEvent.Step.*`** (Started/Ended/Failed) plus, if
   cancellation needs it, one new `SessionEvent.Turn.Cancelled` — i.e. the event log stays the
   single source of truth and the turn table is derived, never independently written.
   This decision must be recorded in `AGENTS.md`/`CONTEXT.md` before implementation, because
   it changes a stated architectural invariant.
2. **Whether "recovery" may re-execute provider work.** The current rule says post-crash
   continuation "requires a separate explicit design before it may retry provider work".
   Until that design exists, the P0 turn machine should recover to `orphaned`/`failed` with a
   reconciliation requirement, never to an automatic provider retry.
3. **Test execution permission.** All P0 slices require tests (crash matrix, truncation
   matrix). Confirm the repo test commands may be run in `packages/core` and `packages/llm`.

## Slice order

| Order | Spec items | Work | Primary files |
|---|---|---|---|
| 1 | §37-1, §37-5, §33, §2.1 | Durable turn record projected from Step events; terminal monotonicity via event-sequence CAS; explicit `cancelled` | `packages/core/src/session/{event,projector,runner,sql}.ts` |
| 2 | §37-2, §37-3, §37-4, §2.2 | Tool invocation record keyed `(sessionID, assistantMessageID, callID, logicalAttempt)`; state vocabulary `authorized/executing/succeeded/failed/cancelled/outcome_unknown`; execution receipt | `packages/schema/src/session-message.ts`, `core/src/tool/{tool,registry}.ts`, `core/src/session/{message-updater,runner/*}.ts` |
| 3 | §37-10, §8.1, §8.2, §9 | Provider terminal requirement + connect/first-byte/semantic-idle/total deadlines; incomplete-tool-argument = explicit failure, remove the empty→`{}` shortcut or gate it on a declared zero-arg schema | `packages/llm/src/route/{client,executor}.ts`, `packages/llm/src/protocols/*`, `core/src/session/runner/llm.ts` |
| 4 | §37-6, §37-7, §10 | Fail-closed tests for malformed permission config; approval nonce/expiry; duplicate `Replied` coalescing | `core/src/{permission.ts,permission/sql.ts}`, `packages/core/test/permission.test.ts` |
| 5 | §37-11, §6, §7 | Failure fingerprints, bounded retry per class, quarantine state + operator clear; persist retry metadata | new `core/src/session/failure.ts` (+ migration), `core/src/session/{input,runner/retry}.ts` |
| 6 | §37-9, §4 | Registry epoch/hash snapshot, replay on reconnect, stale-owner rejection, duplicate-registration coalescing | `core/src/tool/registry.ts`, MCP `tool-snapshot.ts`/`dynamic-tools.ts` |
| 7 | §37-8, §3.2 | Readiness gate: Location-scoped registries complete before first drain; readiness record exposed (even in-process, so a future worker model inherits it) | `core/src/{location-services.ts,session/execution/local.ts}` |
| 8 | §37-12, §2.3 | Child terminal vocabulary (`turn_limit`, `cancelled`, `worker_lost`), durable parent linkage check, descendant cancellation in V2 when children arrive. Partial: resume linkage check + `turn_limit` terminal landed (see the continuation status at the end of this file); `worker_lost`/`cancelled` vocabulary and V2 child agents remain | `packages/opencode/src/tool/task.ts`, `core/src/background-job.ts` |

Slices 1–3 are the critical path: they unblock §33 completion integrity and every
"exactly once" claim in the spec.

## P1 / P2 (after P0)

- P1: context ledger (§12), transactional compaction with measured reduction and convergence
  guards (§14), large-result metadata (§15), model capability override/error surfacing (§13),
  snapshot + incremental replay (§28), execution profile record (§23), result union (§21).
- ~~P1 (measured 2026-09-23, user-reported): auto-compaction triggers at ~30 % of the advertised
  model window for large-output models — the V2 budget reserves the catalog's *maximum* output
  and spends it with a ~2.5x-overcounting character estimator. Details and fix direction in
  §14.~~ **Fixed in the 2026-09-23 pass** (bounded output reserve plus a reported-usage anchored
  measurement; see the compaction + readiness section at the end).
- P2: usage ledger normalization/traceability (§17), prompt-prefix hash observability (§18),
  tool schema budgets in CI (§19), status subscription hardening (§22), telemetry aggregation
  and budgets (§30), efficient eviction if a trace cache appears (§31), reconnect tuning (§32).
- Process, can land immediately and independently: adopt the §42 PR template block, the §40
  DoD checklist, and §36 gates as CI jobs once tests exist; adopt §41 in `AGENTS.md`.

## Definition of done for any P0 slice

A slice is not complete until it has: durable state with documented transitions and explicit
terminal states; stale-writer rejection; defined crash/retry/timeout/cancel/poison behavior;
an idempotency identity with a durable receipt where a side effect occurs; authorization at
the side-effect boundary; and fault-injection tests for restart, duplicate delivery, partial
stream, and the relevant race, with resource bounds and inspectable state/metrics.

---

# Verification notes

- Claims were checked against source at the stated paths. Where a line number is given it
  came from a tool result in this audit; symbol names are used when no exact line was
  captured.
- **Not verified in this pass (should be checked before the plan is finalized):**
  - V1 plugin/hook registration durability and stop-command replay (§4).
  - Subprocess termination coupling to V2 tool cancellation (§5).
  - SSE event-stream reconnect behavior and registration replay in `packages/app` (§32).
  - Determinism of `system-context` baseline renderers (§18).
  - Malformed-permission-config startup behavior end to end (§10.1).
  - npm dependency-install failure semantics (§24).
- **Working-tree caveat:** the repository has substantial uncommitted work, including new
  files directly relevant to this audit (`core/src/session/runner/retry.ts`,
  `core/src/session/usage.ts`, `opencode/src/mcp/{dynamic-tools,tool-snapshot}.ts`,
  `llm/src/{retry,route/admission}.ts`). Verdicts reflect the working tree as found, not
  HEAD alone.

---

# Implementation status — 2026-09-22 (P0 slice 3, partial)

Scope of this pass: **§8.1 / §8.2 / §9 / §33 — a provider turn must not be reported as
success unless the provider terminal arrived, and no upstream call may wait forever.** This
is the critical-path part of slice 3 in the plan above. Nothing is committed.

## Changed

| File | Change |
|---|---|
| `packages/llm/src/route/timeouts.ts` (new) | `Timeouts`/`Resolved` plus defaults: request `120_000 ms`, stream semantic-idle `90_000 ms`, stream total `30 min`; `resolveTimeouts()` |
| `packages/llm/src/route/client.ts` | `RouteDefaults.timeouts`; `enforceStreamContract()` wraps every route stream with the terminal requirement, the semantic-idle deadline, and the total deadline; wired into `streamRequestWith` |
| `packages/llm/src/route/transport/http.ts` | request/connect deadline: `Effect.timeoutOrElse(timeouts.requestMs)` around `runtime.http.execute` |
| `packages/core/src/session/runner/llm.ts` | runner guard: a successful stream that published assistant output but never settled a step fails the assistant (`Provider stream ended without a step settlement`); continuation now requires a settled step |
| `packages/llm/test/stream-contract.test.ts` (new) | 4 `it.live` contract tests: terminal accepted; no-terminal fails; idle fails; total deadline fails |
| `packages/llm/test/provider/openai-chat.test.ts` | the "no finish reason" test now asserts partial events stay observable **and** that draining the truncated stream fails |
| `packages/core/test/session-runner.test.ts` | new test: a stream that publishes text and then ends without a settlement fails the assistant and keeps the delivered content, before and after projection replay |

Behavior details that matter:

- The terminal requirement is enforced in the **LLM client** (`@opencode-ai/llm/route`), which
  is the service the session runner consumes (`core/src/session/runner/llm.ts:113`,
  `llm = yield* LLMClient.Service`). A transport close without `finish`/`providerError` now
  fails the stream instead of ending it successfully.
- **Consumer cancellation is not truncation.** A consumer that stops early (`Stream.take`)
  never pulls the contract tail, so early-stop paths keep working; only reading a stream to
  its end is checked.
- Keepalive traffic that never decodes into a semantic event cannot hold a stream open: the
  idle deadline is applied to decoded events.
- The runner guard is deliberately scoped to `publisher.hasAssistantStarted()`: a turn that
  published partial output and never settled must fail, while a producer that emits nothing
  at all stays a no-op (the LLM client path cannot reach that state — it fails with the
  terminal error first).

## Acceptance criteria that now hold

- §8.2 "Endless keepalive frames eventually time out" — idle deadline + test.
- §8.2 "Mid-delta disconnect is not reported as success" — LLM-client terminal requirement,
  runner settlement guard, provider test.
- §8.2 "Socket close during tool arguments creates an incomplete-call failure" — the stream
  now fails, so a truncated call can no longer be finalized from a successful stream (the
  remaining inference caveat is below).
- §8.2 "No upstream client waits forever without a deadline" — request, idle, and total
  deadlines.
- §8.1 "truncated provider stream ends as success" — closed at both layers.

## Verified

- `packages/llm`: `bun test` → 340 tests, 310 pass, 0 fail (30 skipped recorded tests).
- `packages/core`: `bun test` over `session-runner*.test.ts` (6 files) → 139 tests, 138 pass,
  1 fail. The single failure ("automatically compacts into a completed summary and retained
  recent turn", compaction retention) is **pre-existing**: with both runner hunks from this
  pass disabled, the same assertion fails identically.
- Typecheck (`bun run typecheck`, package dirs): no errors in any file changed by this pass.

## Open (same slice, deliberately not implemented)

1. **Empty streamed tool input is still normalized to `{}`** —
   `packages/llm/src/protocols/shared.ts` (`parseToolInput`) keeps the documented
   `raw || "{}"` behavior: providers legitimately encode a zero-argument call as an empty
   argument string (OpenAI Chat sends `arguments: ""`), and the parse site has no declared
   schema to gate on. The spec allows "gate it on a declared zero-arg schema"; that needs the
   request's tool schemas plumbed into protocol parser state (cross-protocol change) or an
   explicit "input was inferred" marker on the event. Fail-closed state today: `Tool.settle`
   (`packages/core/src/tool/tool.ts:97-98`) decodes `call.input` against the declared schema
   at the execution boundary, so tools with required parameters already fail; only
   all-optional/zero-argument schemas accept an inferred `{}`.
2. **Eager tool execution precedes the terminal.** `tool-call` events are settled as they
   arrive (`packages/core/src/session/runner/llm.ts:391-404`), so a call cut mid-arguments can
   execute before the stream is known to be truncated. Closing this needs a decision between
   deferring execution to the terminal boundary and marking inferred/partial inputs; it is an
   architectural change, not a local fix.
   With this pass, the *turn* still fails (`failAssistant`), so the failure is at least not
   silent, but the side effect may already exist.

---

# Implementation status — 2026-09-22 (P0 slice 1)

Scope of this pass: **§37-1 / §37-5 / §33 / §2.1 — durable turn lifecycle and completion
integrity.** The turn record is a read model over the durable event projection; no table and
no new event type were added. Blocker decisions #1/#2 above are honored: the event log stays
the single source of truth and recovery never re-executes provider work.

## Changed

| File | Change |
|---|---|
| `packages/core/src/session/turn.ts` (new) | `SessionTurn`: `States = ["running","completed","failed","cancelled"]`, `Turn` read model (`state`, `finish`, `error`, `unsettledTools`, `time`), `of(messages)` classifier, `INTERRUPTED_REASON`, `ORPHANED_REASON` |
| `packages/core/src/session/store.ts` | `SessionStore.Interface.turns(sessionID)` — projects `SessionHistory.load` through `SessionTurn.of` |
| `packages/core/src/session/message-updater.ts` | terminal monotonicity: `step.ended`/`step.failed` return early when the assistant already has `time.completed`, so the first durable terminal wins |
| `packages/core/src/session/runner/llm.ts` | both interruption sites publish `SessionTurn.INTERRUPTED_REASON`; `failOrphanedTurns(sessionID, turns)` reconciles turns left running by a previous process |
| `packages/core/test/session-turn.test.ts` (new) | 7 pure classifier tests incl. `unsettledTools` counting |
| `packages/core/test/session-projector.test.ts` | "keeps the first durable terminal for an assistant turn" (both event orderings) |
| `packages/core/test/session-runner.test.ts` | "records an interrupted provider turn as a cancelled turn"; "fails a turn left without a terminal by a previous process"; the hosted-tool recovery test now also asserts the continued turn is terminalized after the drain |

Behavior details that matter:

- **Classification is derived, never written.** `running` = no `time.completed`; `cancelled` =
  terminal whose error message is `INTERRUPTED_REASON`; `failed` = `finish` absent or
  `"error"` (fail-closed: missing completion data is never completion); otherwise `completed`.
  `queued`/`starting` stay absent on purpose: durable admission is `session_input`, and the
  drain that will run a turn has no durable identity until clustered ownership lands.
- **Orphan reconciliation order.** At drain start the running turns are classified *before*
  `failInterruptedTools` runs. A turn that still owns unsettled tools is **continued inline**:
  its tools are failed, its history is replayed so the provider can finish the step, and it is
  terminalized only after the drain consumed that history. This ordering exists because a
  failed assistant turn replays **without** its provider-native continuation metadata
  (`to-llm-message.ts` `reuseProviderMetadata = sameModel && message.error === undefined`), and
  a provider-executed call needs that metadata to be recognizable in the next request. A turn
  with nothing left to settle is failed immediately.
- **No provider retry.** An orphan becomes a terminal failure; the drain never re-runs the
  provider work of the interrupted turn. If the drain that continued an orphan dies itself,
  the turn is left running and the next drain re-classifies it.
- `Step.Failed`/`Step.Ended` are the only terminal writers, so monotonicity is enforced where
  the projection happens rather than by a second state machine.

## Acceptance criteria that now hold

- §33 "complete only with a provider terminal" — a turn is `completed` only when a durable
  terminal with a non-error finish is projected; `finish` missing or `"error"` classifies as
  `failed`.
- §2.1 "monotonic terminals" — projection-time monotonicity, tested in both orderings.
- §2.1 "orphan/recovery state" — running turns of a dead process are reconciled to a durable
  terminal at the next drain; interrupted turns are durably `cancelled`.

## Verified

- `packages/core`: 11 session test files → 185 tests, 184 pass, 1 fail. The single failure
  ("automatically compacts into a completed summary and retained recent turn") is pre-existing
  (compaction retention; A/B-proven with this pass disabled).
- Typecheck (`bun run typecheck`, `packages/core`): no errors in any file changed by this pass
  (the one `llm.ts` error is the pre-existing uncommitted `runAttempts` annotation; the
  `packages/llm` errors are the pre-existing uncommitted admission/executor WIP).

## Open (same slice, deliberately not implemented)

1. **`cancelled` is derived, not first-class.** A dedicated durable cancellation event
   (`Step.Cancelled` or a `Turn.*` family) requires regenerating `packages/client`
   (`bun run generate`) and the legacy SDK, so it is deferred; the reason string keeps
   `cancelled` distinct in the read model in the meantime.
2. **No owner/lease/epoch, so terminals are not CAS-guarded.** Monotonicity is a
   projection-time check. The spec's stronger form — event-sequence CAS and stale-writer
   rejection — needs the registry epoch work (slice 6) and the durable ownership design from
   blocker decision #1; until then a stale writer can still publish a late terminal event,
   which the projection then refuses to apply.
3. **A continued orphan stays `running` for the duration of the drain that continues it** (by
   design, see ordering above). If the caller wants it terminal earlier, the trade is dropping
   its provider metadata from the replay.
4. **No consumer yet.** `SessionStore.turns` is the surface for later slices (retry/quarantine
   and status reporting); the UI still reads projected messages directly.
3. **No streamed-argument size bound** (§9 "large arguments fail with a specific size
   error"); `partial/complete_valid/complete_invalid/truncated` still has no type.

## Pre-existing breakage observed while verifying (not touched)

- `packages/llm` typecheck: `src/route/admission.ts(51,3)`, `(85,66)`,
  `src/route/executor.ts(393,17)`, `(396,29)`, `(398,43)`, `test/admission.test.ts`.
- `packages/core` typecheck: `src/session/runner/llm.ts(528,9)` — `Effect<…, Scope>` assigned
  to an `Effect<…, RunError>` annotation at the uncommitted retry helper
  (`FiberSet.make` inside `runAttempt`).
- `packages/core` test: the compaction-retention failure named above.
- The uncommitted retry refactor in this file also changes when a turn retries; it is not part
  of this pass and was left as found.

---

# Implementation status — 2026-09-22 (P0 slice 4)

Scope of this pass: **§37-6 / §37-7 / §10 — fail-closed permission configuration, approval
single-use semantics, and approval lifetime.**

## Changed

| File | Change |
|---|---|
| `packages/core/src/permission.ts` | `APPROVAL_TTL_MS` (30 min) plus `expiresAt` per pending prompt; expiry sweeper (`Schedule.spaced(1 min)`); `reply`/`interrupt` sweep first; the request ID is consumed before the first yield; expired entries are filtered out of `get`/`list`/`forSession` |
| `packages/core/test/permission.test.ts` | 5 new tests: malformed ruleset/agent config never decodes; an unresolvable agent blocks execution with deny-*; approval is single use; concurrent replies coalesce to one `Replied`; expiry releases the waiting tool |

Behavior details that matter:

- The request ID *is* the approval token (it is already the protocol's only handle). It is now
  consumed atomically (synchronous `pending.delete` immediately after the lookup) before any
  `events.publish` yield, so a repeated or concurrent reply cannot observe the same request.
  A/B-verified: with the delete left after the publish, the new concurrency test sees two
  `Replied` events and two successful replies; with it, exactly one.
- Expiry reuses the reject vocabulary (`Replied { reply: "reject" }` + `DeclinedError`): the
  durable reply schema has no `expired` value, so adding one is a protocol change (client and
  legacy SDK regeneration). The prompt stops being applicable and the waiting tool is released
  instead of parked forever.
- Read accessors filter expired entries and never mutate, so a prompt that outlived its window
  is not reported as applicable even before the sweeper runs.

## Acceptance criteria that now hold

- §10.1 fail-closed: a malformed permission config drops the agent at decode, and a session
  whose agent cannot be resolved is denied (`BlockedError`, deny-*) rather than falling back to
  a permissive default — tested at both the schema and the assert boundary.
- §10.3 single-use: one approval, one `Replied` event, one execution; a second reply is
  `NotFoundError`.
- §10.3 expiry: an unanswered prompt stops being applicable after `APPROVAL_TTL_MS` and is
  rejected; nothing hangs on it.

## Verified

- `packages/core`: `bun test test/permission.test.ts` → 17 pass / 0 fail (5 new).
- Typecheck: no errors in any file changed by this pass.

## Open (same slice)

1. **Approvals still do not survive restart.** The TTL bounds an in-process window; durable
   approval records (and a durably consumed nonce) need the migration path that is broken on
   Windows (`packages/core/script/migration.ts`), so this is deferred with the rest of the
   durable-state work.
2. **`expired` is not a first-class reply reason.** The protocol has no such value; expiry is
   published as `reject`. A distinct reason needs `Permission.Reply` extended and the client +
   legacy SDK regenerated.
3. **`"always"` propagation is not atomic per entry.** The propagation loop re-checks each
   pending request and deletes before publishing, but concurrent replies to *different*
   prompts in the same session can still interleave; the single-request guarantee the spec
   asks for is atomic.

---

# Implementation status — 2026-09-22 (P0 slice 5)

Scope of this pass: **§37-11 / §6 / §7 — failure fingerprints, bounded retry per class, and
poison/quarantine accounting.** The accounting is derived from the durable projection instead
of a new table, so it survives a restart without the migration path that is broken on Windows.

## Changed

| File | Change |
|---|---|
| `packages/core/src/session/failure.ts` (new) | `signature()` normalizes volatile tokens (uuids, request ids, timestamps, durations, long numbers) so attempts of one failing call share a fingerprint; `streak()` counts consecutive identical failures at the tail of the projection; `account()` reports `{ failures, threshold, quarantined }`; `MAX_IDENTICAL_FAILURES = 3` |
| `packages/core/src/session/store.ts` | `failures(sessionID)` read model over the same projection |
| `packages/core/src/session/runner/llm.ts` | retry budget: `limit = quarantined ? 0 : max(0, MAX_RETRIES - prior)` where `prior` is the durable streak; `runAttempts(retries, limit)` carries the limit instead of the constant, and the quarantine transition is logged |
| `packages/core/test/session-failure.test.ts` (new) | 3 tests: fingerprint normalization, streak scoping, quarantine threshold |
| `packages/core/test/session-runner.test.ts` | "quarantines a repeated provider failure instead of retrying it again" |

Behavior details that matter:

- **Durable accounting, not durable attempts.** The in-process attempt counter stays an
  in-process parameter; what survives a restart is the *streak* derived from the projected
  turns. Each identical failure this input already produced consumes one retry from the
  in-process budget, and at `MAX_IDENTICAL_FAILURES` the budget is zero.
- **A quarantined input still gets one provider attempt.** The drain that was explicitly asked
  for always tries the provider once; what stops is the automatic retry fan-out. That keeps a
  manual resume meaningful while removing the repeat cost.
- **The clear path is a new input.** The streak stops at any non-assistant message, so the
  accounting is scoped to one prompt: sending a new message (or promoting a queued or steered
  one) clears it. There is no separate quarantine flag to clear.
- **Attempts of one failing call share a fingerprint** even though request ids, timestamps,
  durations, and byte counts differ between attempts.

## Acceptance criteria that now hold

- §6.2 "deterministic poison stops after a policy threshold" — a repeated identical failure
  stops retrying. A/B-verified: with the accounting disabled the same test issues
  `MAX_RETRIES + 1 = 6` provider requests, with it 1.
- §6.2 "retry metadata survives restart" — the accounting is derived from durable events, so a
  restarted process sees the same streak and the same reduced budget ("restart does not rerun
  a doomed call forever").
- §6.1 "bounded retry per class" — the existing per-class classification (rate limit, provider
  internal, transient transport, model resolution) is unchanged; the durable streak now bounds
  it.
- §7 operator visibility — `SessionStore.failures(sessionID)` exposes the accounting and the
  quarantine transition is logged.

## Verified

- `packages/core`: `bun test test/session-failure.test.ts` → 3 pass / 0 fail; the 12-file
  session set → 189 tests, 188 pass, 1 fail (the pre-existing compaction retention failure).
- Typecheck: no errors in any file changed by this pass.

## Open (same slice)

1. **No separate quarantine record and no durable operator-clear marker.** Quarantine is a
   derived predicate, so "clear" means "admit a new input". A durable `quarantined` record with
   an explicit clear (and a `turns_orphaned`-style counter) needs the failure/quarantine table
   from the P0 plan, blocked on the migration generator.
2. **Poison accounting is per session input, not per tool or per compaction loop.** Tool-level
   fingerprints and repeated-identical-tool-call bounding (§6) attach to slice 2's tool
   invocation records.
3. **The accounting adds one projection read per provider turn.** It shares the same
   `SessionHistory` shape the runner already loads, so it is not an extra query shape, but it
   is an extra read per drain turn.
4. **A quarantined input is reported, not surfaced.** Nothing in the UI explains why retries
   stopped; the log line and `SessionStore.failures` are the only signals today.

---

# Status after the 2026-09-22 pass — installer and remaining slices

## Installer

- Built with the repo's own flow (`packages/desktop`: `bun scripts/pack-test-installer.ts`,
  prod channel, `OPENCODE_ISOLATE_INSTALL=1`), which rebuilds
  `packages/opencode/dist/node/node.js` through `prepare` → `prebuild` before electron-builder
  runs.
- Artifact: `packages/desktop/dist/opencode-desktop-win-x64-0.0.0-cursor-202609221534.exe`
  (128,999,278 bytes). Installs as "OpenCode Cursor" into
  `%LOCALAPPDATA%\Programs\opencode-cursor`; production OpenCode is untouched.
- Verified inside `dist/win-unpacked/resources/app.asar` (189,730,357 bytes), i.e. the code the
  installed app actually runs: `Turn was orphaned by a previous process`,
  `provider failure quarantined`, `Provider turn interrupted`, `PermissionV2.sweep`, and
  `Without a step settlement` (the slice-3 runner guard) are all present.
- `packages/desktop/package.json` is restored by the packing script (verified clean after the
  build).

## Slices implemented in this pass

| Slice | Spec items | Status | Evidence |
|---|---|---|---|
| 1 — durable turn lifecycle | §37-1, §37-5, §33, §2.1 | done (read model + monotonic terminals + cancelled + orphan reconciliation) | 189 tests across 12 session files, 188 pass; A/B for orphan ordering |
| 3 — provider terminal + deadlines | §37-10, §8.1, §8.2, §9 | done (LLM-client contract + deadlines + runner guard) | `packages/llm` 310 pass / 0 fail; runner guard tests |
| 4 — permission fail-closed, single use, expiry | §37-6, §37-7, §10 | done | `permission.test.ts` 17 pass / 0 fail, 5 new |
| 5 — fingerprints, bounded retry, poison accounting | §37-11, §6, §7 | done (derived accounting, no new table) | `session-failure.test.ts` 3 pass; runner quarantine test A/B (6 → 1 requests) |

## Slices not implemented in the first pass

Slices 2, 6, and 7 were completed in the continuation pass documented at the end of this file;
slice 8 remains deferred for the reason given below.

| Slice | Why it was deferred |
|---|---|
| 2 — tool invocation record + execution receipt | Needs a durable per-invocation record keyed `(sessionID, assistantMessageID, callID, logicalAttempt)` with a new state vocabulary. That is a schema/migration change, and the generator (`packages/core/script/migration.ts`) is broken on Windows (Bun.Glob path separators), so it was explicitly out of scope for this pass. Doing it as a read model cannot express an *execution receipt*. |
| 6 — registry epoch/hash snapshot, replay, stale-owner rejection | Requires changing `ToolRegistry` (the registration map and materialization identity) and the MCP tool snapshot. The registry is on the hot path of every tool call and is covered by many tool tests, so it needs its own pass with the tool suite available; the design (owner epoch persisted where?) also overlaps slice 2's durable record. |
| 7 — readiness gate | The gate already holds implicitly: `LayerMap` builds the Location services before `locations.get(ref)` returns, so a drain cannot run against a half-built registry. What remains is the *readiness record* itself (an in-process status surface for a future worker model) — additive but with no consumer today. |
| 8 — child terminal vocabulary | Partially landed in the continuation pass: the durable resume linkage check and the `turn_limit` terminal now exist (see the final status section). `cancelled` / `worker_lost` and V2 child agents stay deferred: `core/src/background-job.ts` keeps status in memory (`:115`), so there is still no durable child terminal to write them to, and V2 core has no child-agent tool to produce them. |

## Pre-existing failures observed while verifying (not caused by this pass)

1. `SessionRunnerLLM > automatically compacts into a completed summary and retained recent
   turn` (compaction retention). A/B-proven pre-existing.
2. `SessionV2.create > omits legacy creation rows from the V2 Session event stream`
   (`packages/core/test/session-create.test.ts:193`). The V2 stream now skips a durable legacy
   row published between `prompt.admitted` and `prompted`, so the second V2 event carries
   `seq: 3` while the test expects `seq: 2`. A/B-verified pre-existing: with this pass's two
   behavioral files (`session/message-updater.ts`, `permission.ts`) stashed, the same assertion
   fails identically.
3. `packages/llm` typecheck errors in the uncommitted `route/admission.ts` /
   `route/executor.ts`, and the `packages/core` `llm.ts` `Scope` annotation error in the
   uncommitted retry helper (line number moves with this pass's edits).
4. The full `packages/core` suite cannot be run end to end in this environment: it aborts in
   native watcher/git tests (bun crash report, `watcher.node` frames) unrelated to this pass.
   The session, permission, prompt, create, coordinator, title, todo, usage, background-job and
   application-tools files were run instead.

---

# Status after the 2026-09-22 continuation — slices 2 (increment), 6, 7

## Slice 2 increment — durable tool-invocation ledger (§37-2, §37-3, §1.2, §2.2)

- New read model `packages/core/src/session/invocation.ts`, exposed as
  `SessionStore.invocations(sessionID)`: one record per tool call whose identity is
  `(sessionID, assistantMessageID, callID, logicalAttempt)` with `SessionInvocation.key(...)`.
  Like the turn record, it is derived from the durable projection so the event log stays the
  single source of truth.
- Durable states: `arguments_streaming`, `arguments_complete`, `authorized`, `executing`,
  `succeeded`, `failed`, `cancelled`, `outcome_unknown`.
  - `arguments_validated` from the assurance vocabulary is enforced inside the execution
    boundary (`Tool.settle` decodes before executing) and settles as `failed`; the ledger names
    the durable state `arguments_complete` rather than claim a validation it cannot observe.
  - `declared` collapses into `arguments_streaming` because argument deltas are live-only.
- Reconciliation reasons are single-sourced (`SessionInvocation.INTERRUPTED_REASON`,
  `HOSTED_UNRESOLVED_REASON`, `EXECUTION_FAILED_PREFIX`) and the runner now uses them.
- `outcome_unknown` needs all of: a reconciled terminal (reason authored by the runner, not the
  tool), admission evidence (`time.ran`), and an owning turn that was not cancelled. A call
  refused before admission stays `failed`; a reconciled call from a cancelled turn is
  `cancelled`.
- Verified: `test/session-invocation.test.ts` 9 pass (unit) plus an end-to-end assertion added
  to `test/session-runner.test.ts` ("durably fails local tools left running by a prior
  process"): after a real drain the interrupted call reports `outcome_unknown` with attempt 1.
- Still absent (deliberately): a durable per-invocation *row* keyed by the identity, an
  in-flight execution marker, and automatic recovery. Adding a row/state needs a protocol and
  migration change, and recovery still never re-executes provider or tool work.

## Slice 6 — registry snapshot version (§37-9, §4)

- `ToolRegistry.Materialization` now carries `epoch` (monotonic; advances only when the hash
  changes) and `hash` (content fingerprint of registered names, descriptions, schemas, and
  permission actions). `ToolRegistry.stats()` exposes `{ registrations, epoch, hash }`, and the
  runner logs epoch/hash for every materialization.
- The snapshot identity is computed before one agent's permission filter, so hiding tools from
  one agent does not version the registry.
- Repeated registrations from one owner scope coalesce instead of appending; the scope is the
  single owner, so a refresh cannot grow the entry list and its finalizer removes exactly its
  entries. Stale-owner rejection is unchanged (registration identity comparison at settlement).
- Verified: `test/tool-registry-version.test.ts` 4 pass (stable hash across reconnects; epoch
  advance on a changed definition and on scope close; permission filter does not version;
  coalescing plus scope cleanup), and the existing registry/tool suites stay green
  (`session-runner-tool-registry`, `application-tools`, 11 `tool-*` files).

## Slice 7 — readiness record and gate (§37-8, §3.2)

- New `packages/core/src/readiness.ts`: bounded (128 entries) process-level records with
  `state: building | ready | failed`, `registryEpoch`, `registryHash`, `error`, and
  `updatedAt`. Reads refresh recency, so eviction takes the least-recently read record rather
  than the oldest written one (2026-09-23: the original oldest-first policy could evict a live
  Location's record and fail its next drain).
- `buildLocationServiceMap` marks a Location `building` when its layer is created, `ready` from
  inside the built graph (so a record can only describe services that actually built, and it
  carries the tool registry snapshot), and `failed` from `Layer.tapCause` placed after
  `provide`, so a failure on either side of the build barrier is recorded while interruption is
  not treated as failure.
- `SessionExecutionLocal.drain` asserts readiness before running, so the drain cannot start
  against a half-built graph; the structural barrier is now a checked invariant with an
  inspectable record. An absent record is an observability gap (warning) rather than a defect,
  because records are bounded and written only when a graph is built; a present `building` or
  `failed` record still dies (2026-09-23).
- Verified: `test/readiness.test.ts` 4 pass — a built Location is `ready` with a positive epoch
  and an 8-hex hash, a replaced failing `ToolRegistry` layer records `failed` with the cause
  while `assertReady` fails, a Location with no record passes `assertReady`, and a record that
  keeps being read survives 256 later writes.

## Slice 8 — partial

Landed in this pass, without a protocol or schema change:

- Durable resume linkage: `packages/opencode/src/tool/task.ts` refuses a `task_id` whose
  `parentID !== ctx.sessionID` (the durable `session.parent_id` field), so the task tool can no
  longer be pointed at a session the caller does not own.
- `turn_limit` terminal: `prompt.ts` writes `TURN_LIMIT_REASON` on the assistant message when an
  agent with a `steps` allowance stops at the exhausted limit, and `task.ts` maps that message
  to `Subagent failed (task_id: …, reason: turn_limit): …`. Agents without an explicit `steps`
  keep `maxSteps = Infinity`, so the default path is unchanged.

Still deferred: `worker_lost` / `cancelled` have no durable home (`background-job.ts:115` keeps
status in memory) and V2 core has no child-agent tool, so those vocabulary entries would have no
honest producer. `MAX_STEPS_PROMPT` also remains advisory — tools are not actually withdrawn on
the last step, so a child that ignores the prompt is not stopped, it is only not reported as
successful.

## Verification summary for this continuation

- `packages/core`: session + permission + registry + readiness + tool suites green except the
  two pre-existing failures documented above.
- `packages/opencode`: `test/mcp/dynamic-tools.test.ts` + `test/mcp/lifecycle.test.ts`
  31 pass / 0 fail (the registry change is on the MCP registration path).
- Typecheck: no new errors. The remaining errors are the pre-existing ones (the `llm.ts` retry
  helper `Scope` annotation and the `packages/llm` WIP `route/admission.ts` /
  `route/executor.ts`).

---

# Status after the 2026-09-22 slice-8 pass — resume linkage + `turn_limit`

## What landed

- **Durable resume linkage.** `packages/opencode/src/tool/task.ts` rejects a `task_id` whose
  `parentID !== ctx.sessionID` before any prompt is issued, so the task tool can only resume a
  subagent it owns (the field is durable: `session.parent_id`, §2.3). Previously an agent could
  pass an arbitrary session ID and drive that session with its own prompt, inheriting its
  transcript and permissions.
- **`turn_limit` terminal.** `packages/core/src/session/runner/max-steps.ts` now exports
  `TURN_LIMIT_REASON` alongside the existing `MAX_STEPS_PROMPT`. `prompt.ts` writes it as the
  assistant-message error when a step finishes with the agent's step allowance exhausted, and
  `task.ts` maps it to `Subagent failed (task_id: …, reason: turn_limit): …`. A turn-limited
  child is therefore no longer reported as completed (§2.3, §33). Agents without an explicit
  `steps` keep `maxSteps = Infinity`, so default behaviour is unchanged; the reason travels as
  an `UnknownError` message because adding a typed variant would change the shared V1 message
  schema.
- No public Protocol or `HttpApi` change: the existing `Assistant.error` union already carries
  `UnknownError`, so no client regeneration was needed.

## Verification for this pass

- `packages/opencode/test/tool/task.test.ts`: 24 pass / 0 fail, including two new tests —
  `execute rejects a task_id that is not a subagent of the calling session` (asserts both
  parents' children are unchanged) and `execute surfaces a child turn limit distinctly from
  success`.
- `packages/opencode/test/session/prompt.test.ts` `-t "exhausted step limit"`: 1 pass — a real
  prompt loop with `agent: { build: { steps: 1 } }` stores and returns
  `{ name: "UnknownError", data: { message: TURN_LIMIT_REASON } }`. The test carries a 30 s
  timeout because the prompt harness needs 6–8 s per turn in this environment.
- `packages/core`: `test/session-invocation.test.ts` + `test/session-runner-tool-registry.test.ts`
  28 pass / 0 fail.
- `bun typecheck` in `packages/opencode`: no new errors (only the pre-existing ones above).
- Environment note: several long-standing tests in `test/session/prompt.test.ts` keep the
  default 5 s bun timeout and need 5–6 s per turn on this machine, so they time out regardless
  of this pass (verified: `loop surfaces content-filter finishes as session errors` times out
  identically without touching the changed code).

## Installer built for this pass

`bun scripts/pack-test-installer.ts` from `packages/desktop` (prod channel, no DEV badge,
installs as "OpenCode Cursor" into `%LOCALAPPDATA%\Programs\opencode-cursor`) rebuilt
`packages/opencode/dist/node/node.js` first, so the bundle carries this pass's changes:

- `packages/desktop/dist/opencode-desktop-win-x64-0.0.0-cursor-202609221945.exe`
  (128,993,135 bytes).
- `packages/desktop/dist/win-unpacked/resources/app.asar` (189,783,455 bytes) and the rebuilt
  `node.js` both contain `Maximum agent steps reached`, `is not a subagent of this session`,
  `reason: turn_limit`, and (from the previous pass) `materialized tools` and
  `Location is not ready`.

---

# Status after the 2026-09-23 compaction + readiness pass

**Verdict on V2 as the general stack.** The V2 runner path (`SessionV2` + `SessionExecution` +
the durable projection) is fit to be the general stack. The defects this review found are fixed
in this pass — the auto-compaction budget and measurement (§14's measured defect), the
nonproductive-compaction loop, the silent failure paths, the compaction retention loss, and the
readiness gate's false negative for a live Location. The V2 runner suite is green
(`packages/core/test/session-runner.test.ts` 97 pass / 0 fail, including the retention test the
assessment had recorded as pre-existing). Nothing here needed a public Protocol or `HttpApi`
change, so no client regeneration was required. What remains for V2 is the already-documented
work: a durable `Compaction.Failed` event (deferred only because it changes the session event
schema), an explicit reduction measurement with hysteresis (§14), and the child-agent vocabulary
of slice 8 (`worker_lost` / `cancelled`).

## What landed

- **Auto-compaction fires at the advertised window again (§14 measured defect).**
  `session/compaction.ts` now reserves a real output allowance — `reserve()` returns the
  requested `maxTokens` when the runner sets one, otherwise the smaller of the catalog maximum
  and `DEFAULT_OUTPUT_RESERVE = 32_000` — and measures the request with `requestTokens()`: the
  last assistant turn's provider-reported usage anchors the count, and `Token.estimate` is
  applied only to what was added after that turn (its tool results, newer messages) instead of
  to the whole request. A request with no reported usage still falls back to the whole-request
  estimate. For `deepseek/deepseek-flash` (1,000,000 / 384,000) the trigger moved from
  `context - 384,000` measured at ~2.5x to `context - 32,000` measured at reported cost, so a
  297,583-token turn (30 % of the window) no longer compacts.
- **Nonproductive compaction terminates instead of repeating.** `compactAfterOverflow` returns
  false with a warning when the only content outside the retained tail is a prior compaction
  message: re-summarizing the prior summary cannot reduce the request, and it was the loop that
  could re-enter the runner's `ContinueAfterCompaction` transition without a provider turn.
- **Compaction failures are logged with a reason.** The three silent `return false` paths
  (summary prompt does not fit, LLM/stream failure, empty summary) now emit
  `Effect.logWarning("Compaction summary failed", { reason })` with `llm_error` /
  `provider_error` / `empty_summary`, carrying the `messageID` of the published
  `Compaction.Started`, so a started-without-ended compaction is diagnosable from the log. A
  durable `Compaction.Failed` event remains deferred: it would change the public session event
  schema (§14 gap, unchanged).
- **Retention: the newest turn survives compaction.** This fixes the failure the assessment
  recorded as pre-existing, `SessionRunnerLLM > automatically compacts into a completed summary
  and retained recent turn`. `select()` retains complete entries; when the newest entry alone
  exceeds `keep.tokens` it is kept whole rather than moved into the summary, so the model still
  answers the request it was given. `test/session-runner.test.ts`'s "summarizes an oversized
  newest message without retaining a fragment" asserted the opposite rule and was rewritten to
  the retained-whole behaviour ("retains an oversized newest message whole instead of a
  fragment").
- **The readiness gate cannot fail a live Location (§37-8).** `assertReady` treats an absent
  record as an observability gap (warning) instead of dying, because records are capacity-bounded
  and only written when a Location's graph is built; a present `building` or `failed` record is
  still a defect. `read()` refreshes recency, so the bounded (128) cache evicts Locations nobody
  consults instead of a live Location that was merely built early.

## Verification for this pass

- `packages/core/test/session-runner.test.ts`: 97 pass / 0 fail (95 pass / 2 fail earlier in
  the pass, before the retention fix and the two fixture updates below).
- `packages/core/test/session-compaction.test.ts`: 13 pass / 0 fail, including
  `request tokens anchor on reported usage instead of the whole-request estimate`,
  `auto-compaction does not fire while reported usage is inside the window` (300,030 reported
  tokens against a 1,000,000 window), `auto-compaction fires once reported usage passes the
  reserved window`, `auto-compaction does not re-summarize a conversation that only has the
  retained tail`, and the newest-turn retention assertion.
- `packages/core/test/readiness.test.ts`: 4 pass / 0 fail — a built Location is ready with a
  positive epoch and an 8-hex hash, a replaced failing `ToolRegistry` records `failed` with the
  cause while `assertReady` fails, a Location with no record passes, and a record that keeps
  being read survives 256 later writes.
- `bun typecheck` in `packages/core`: no new errors; only the pre-existing `runner/llm.ts:560`
  `Scope` and `packages/llm` `route/admission.ts` / `route/executor.ts` errors.
- Fixture note: two compaction runner tests now use `compactWindowModel` (`context: 3_600`)
  because they exercise the retention split, not the trigger, and the accurate reported-usage
  measurement no longer fires at the shared fixture's `context: 4_000` with `buffer: 3_000`.

## Installer built for this pass

`bun scripts/pack-test-installer.ts` from `packages/desktop` (prod channel, no DEV badge,
installs as "OpenCode Cursor" into `%LOCALAPPDATA%\Programs\opencode-cursor`) rebuilt
`packages/opencode/dist/node/node.js` (33,773,865 bytes) first, so the bundle carries this pass:

- `packages/desktop/dist/opencode-desktop-win-x64-0.0.0-cursor-202609222157.exe`
  (128,995,729 bytes).
- `packages/desktop/dist/win-unpacked/resources/app.asar` (189,796,285 bytes); both it and the
  rebuilt `node.js` contain `Compaction skipped: no conversation content outside the retained
  tail`, `Compaction summary failed`, and `Location has no readiness record`, alongside the
  earlier pass's `Maximum agent steps reached`.

