export * as SessionInvocation from "./invocation"

import { DateTime } from "effect"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionTurn } from "./turn"

/**
 * Durable tool-invocation lifecycle.
 *
 * An invocation is one logical attempt at one tool call. Its identity is
 * `(sessionID, assistantMessageID, callID, logicalAttempt)` and its state is derived from the
 * durable assistant-message projection plus the owning turn terminal, never written
 * independently: the event log stays the single source of truth and this module is the read
 * model over it (same decision as `session/turn.ts`).
 *
 * Only states that a durable row can support are listed. `declared` collapses into
 * `arguments_streaming` because argument deltas are live-only, and `arguments_validated` is
 * enforced inside the execution boundary (`Tool.settle` decodes before executing), so a
 * complete-but-invalid call is durably `arguments_complete` and settles as `failed` when
 * admission rejects it. `authorized` means the runner admitted the call to settlement; the
 * permission decision is enforced immediately inside that boundary (see §10.2), so a denial
 * settles as `failed` without executing.
 *
 * `outcome_unknown` is the terminal for a call whose own execution never settled and whose
 * terminal was written by reconciliation, not by the tool: the side effect may or may not
 * have happened, so the call must never be blindly replayed. `cancelled` is the same
 * reconciliation with an explicitly cancelled owning turn (interrupt or declined approval).
 */
export const States = [
  "arguments_streaming",
  "arguments_complete",
  "authorized",
  "executing",
  "succeeded",
  "failed",
  "cancelled",
  "outcome_unknown",
] as const
export type State = (typeof States)[number]

/** A terminal state is settled: no later terminal may rewrite it and no attempt may replay it. */
export const Terminals: ReadonlySet<State> = new Set(["succeeded", "failed", "cancelled", "outcome_unknown"])

/**
 * Durable reasons written by the runner when it reconciles a call whose execution never
 * settled. A tool error carrying one of these was authored by reconciliation rather than by
 * the tool, so the recorded error does not prove the side effect failed.
 */
export const INTERRUPTED_REASON = "Tool execution interrupted"
export const HOSTED_UNRESOLVED_REASON = "Provider did not return a tool result"
export const EXECUTION_FAILED_PREFIX = "Tool execution failed: "

const reconciled = (message: string) =>
  message === INTERRUPTED_REASON || message === HOSTED_UNRESOLVED_REASON || message.startsWith(EXECUTION_FAILED_PREFIX)

export interface Identity {
  readonly sessionID: SessionSchema.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly callID: string
  /**
   * 1-based execution admission count for this call. The runner admits a call at most once
   * per drain (`Tool.Called` is durably projected before settlement and the publisher
   * rejects duplicate calls), so the projection reports the first attempt. A future retry
   * must reuse this identity with `logicalAttempt + 1`, and must never re-execute an attempt
   * that is already terminal.
   */
  readonly logicalAttempt: number
}

export interface Invocation {
  readonly identity: Identity
  readonly tool: string
  readonly state: State
  /** Raw argument text while streaming, the parsed record once `Tool.Called` projected. */
  readonly input: string | Readonly<Record<string, unknown>>
  readonly error: SessionMessage.UnknownError | undefined
  readonly provider: { readonly executed: boolean } | undefined
  readonly time: {
    readonly created: number
    readonly ran: number | undefined
    readonly completed: number | undefined
  }
}

/** Stable key for the identity tuple, suitable for logs and idempotency maps. */
export const key = (identity: Identity) =>
  `${identity.sessionID}:${identity.assistantMessageID}:${identity.callID}:${identity.logicalAttempt}`

const stateOf = (tool: SessionMessage.AssistantTool, turn: SessionTurn.Turn | undefined): State => {
  const state = tool.state
  if (state.status === "pending") return state.input.length === 0 ? "arguments_streaming" : "arguments_complete"
  if (state.status === "running")
    return state.content.length > 0 || Object.keys(state.structured).length > 0 ? "executing" : "authorized"
  if (state.status === "completed") return "succeeded"
  // An error terminal that was never admitted to execution cannot have run: the runner
  // refuses calls before settlement (step limit, permission, invalid input), and those
  // failures are known.
  if (tool.time.ran === undefined) return "failed"
  if (!reconciled(state.error.message)) return "failed"
  return turn?.state === "cancelled" ? "cancelled" : "outcome_unknown"
}

export const of = (
  sessionID: SessionSchema.ID,
  messages: ReadonlyArray<SessionMessage.Message>,
): ReadonlyArray<Invocation> => {
  const turns = new Map(SessionTurn.of(messages).map((turn) => [turn.id, turn]))
  return messages.flatMap((message) =>
    message.type === "assistant"
      ? message.content.flatMap((item) =>
          item.type === "tool"
            ? [
                {
                  identity: {
                    sessionID,
                    assistantMessageID: message.id,
                    callID: item.id,
                    logicalAttempt: 1,
                  },
                  tool: item.name,
                  state: stateOf(item, turns.get(message.id)),
                  input: item.state.input,
                  error: item.state.status === "error" ? item.state.error : undefined,
                  provider: item.provider ? { executed: item.provider.executed } : undefined,
                  time: {
                    created: DateTime.toEpochMillis(item.time.created),
                    ran: item.time.ran === undefined ? undefined : DateTime.toEpochMillis(item.time.ran),
                    completed: item.time.completed === undefined ? undefined : DateTime.toEpochMillis(item.time.completed),
                  },
                },
              ]
            : [],
        )
      : [],
  )
}
