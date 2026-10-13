export * as SessionTurn from "./turn"

import { DateTime } from "effect"
import { SessionMessage } from "./message"

/**
 * Durable turn lifecycle.
 *
 * A turn is one provider turn of one session. Its identity and terminal state are
 * derived from the durable assistant-message projection (`session_message` rows written
 * by `session.next.step.*` events), never written independently: the event log stays the
 * single source of truth and this module is the read model over it.
 *
 * `queued` and `starting` are intentionally absent. Durable prompt admission lives in
 * `session_input` and the drain that will run a turn has no durable identity until
 * clustered ownership lands, so there is no durable turn to name before the step starts.
 */
export const States = ["running", "completed", "failed", "cancelled"] as const
export type State = (typeof States)[number]

export interface Turn {
  readonly id: SessionMessage.ID
  readonly agent: string
  readonly model: SessionMessage.Assistant["model"]
  readonly state: State
  readonly finish: string | undefined
  readonly error: SessionMessage.UnknownError | undefined
  /**
   * Tool calls without a durable terminal. A running turn that still owns one is continued
   * inline (its tools are failed and its history is replayed), not abandoned.
   */
  readonly unsettledTools: number
  readonly time: {
    readonly created: number
    readonly completed: number | undefined
  }
}

/**
 * Durable reason recorded when a drain is interrupted before its turn settles. The
 * message projection records the ordinary failure terminal, so this reason is what keeps
 * `cancelled` distinct from a provider or tool failure in the turn read model.
 */
export const INTERRUPTED_REASON = "Provider turn interrupted"

/**
 * Durable reason recorded when a previous process left a turn without a terminal.
 * Recovery never re-executes provider work, so the orphan is failed and the session may
 * start a new turn.
 */
export const ORPHANED_REASON = "Turn was orphaned by a previous process"

/**
 * A turn is terminal only when the durable terminal event was projected. A message that
 * was closed without a finish (superseded by a newer turn, or interrupted before the
 * runner published a terminal) is `failed`, never `completed`: missing completion data is
 * not evidence of completion.
 */
const stateOf = (assistant: SessionMessage.Assistant): State => {
  if (!assistant.time.completed) return "running"
  if (assistant.error?.message === INTERRUPTED_REASON) return "cancelled"
  if (assistant.finish === undefined || assistant.finish === "error") return "failed"
  return "completed"
}

const unsettledToolsOf = (assistant: SessionMessage.Assistant) =>
  assistant.content.filter(
    (item) => item.type === "tool" && (item.state.status === "pending" || item.state.status === "running"),
  ).length

export const of = (messages: ReadonlyArray<SessionMessage.Message>): ReadonlyArray<Turn> =>
  messages.flatMap((message) =>
    message.type === "assistant"
      ? [
          {
            id: message.id,
            agent: message.agent,
            model: message.model,
            state: stateOf(message),
            finish: message.finish,
            error: message.error,
            unsettledTools: unsettledToolsOf(message),
            time: {
              created: DateTime.toEpochMillis(message.time.created),
              completed:
                message.time.completed === undefined ? undefined : DateTime.toEpochMillis(message.time.completed),
            },
          },
        ]
      : [],
  )
