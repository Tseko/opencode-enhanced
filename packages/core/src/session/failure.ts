export * as SessionFailure from "./failure"

import { SessionMessage } from "./message"

/**
 * Failure fingerprints and poison accounting.
 *
 * The accounting is derived from the projected assistant turns, so it survives a restart
 * without a table of its own: retries of the same failing provider call share one signature,
 * consecutive identical failures accumulate while the input stays the same, and a new input
 * clears the streak. Nothing here re-executes provider work.
 */

/** Identical failures one input may accumulate before its retries stop. */
export const MAX_IDENTICAL_FAILURES = 3

/**
 * Volatile tokens are stripped before matching so attempts of the same failing call share one
 * signature: request ids, timestamps, durations, and byte counts change between attempts while
 * the failure class does not.
 */
const VOLATILE: ReadonlyArray<RegExp> = [
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
  /\b(?:req|request|trace|span|msg|chatcmpl|call|id)[_-][A-Za-z0-9]{6,}\b/gi,
  /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g,
  /\b\d+(?:\.\d+)?\s?(?:ms|s|m|h|secs?|seconds?|mins?|minutes?|hours?)\b/gi,
  /\b\d{3,}\b/g,
]

export const signature = (message: string) =>
  VOLATILE.reduce((value, pattern) => value.replace(pattern, "#"), message).trim().toLowerCase()

/**
 * Consecutive failed turns at the tail of the projection that carry the same fingerprint.
 * A non-assistant message is an input boundary, so the streak is scoped to one prompt, and a
 * turn that did not fail ends the streak.
 */
export const streak = (messages: ReadonlyArray<SessionMessage.Message>, message: string) => {
  const target = signature(message)
  return trailing(messages, (error) => signature(error.message) === target)
}

export interface Account {
  /** Consecutive identical failures recorded for the current input. */
  readonly failures: number
  readonly threshold: number
  /** No further retry is allowed for this input until a new one is admitted. */
  readonly quarantined: boolean
}

/** Failure accounting for the current input, derived from the durable projection. */
export const account = (messages: ReadonlyArray<SessionMessage.Message>): Account => {
  const last = trailingFailure(messages)
  const failures = last?.error === undefined ? 0 : streak(messages, last.error.message)
  return {
    failures,
    threshold: MAX_IDENTICAL_FAILURES,
    quarantined: failures >= MAX_IDENTICAL_FAILURES,
  }
}

const trailing = (
  messages: ReadonlyArray<SessionMessage.Message>,
  match: (error: SessionMessage.UnknownError) => boolean,
) => {
  let count = 0
  for (let index = messages.length - 1; index >= 0; index--) {
    const item = messages[index]!
    if (item.type !== "assistant") break
    if (item.time.completed === undefined || item.finish !== "error" || item.error === undefined) break
    if (!match(item.error)) break
    count += 1
  }
  return count
}

/** The most recent turn only when the projection still ends in a failure. */
const trailingFailure = (messages: ReadonlyArray<SessionMessage.Message>) => {
  const item = messages[messages.length - 1]
  if (item?.type !== "assistant") return undefined
  if (item.time.completed === undefined || item.finish !== "error" || item.error === undefined) return undefined
  return item
}
