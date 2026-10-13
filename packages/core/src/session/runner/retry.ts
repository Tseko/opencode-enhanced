export * as TurnRetry from "./retry"

import { LLMError, Retry } from "@opencode-ai/llm"
import { SessionRunnerModel } from "./model"

export const MAX_RETRIES = 5
export const INITIAL_DELAY_MS = 2_000
export const BACKOFF_FACTOR = 2
export const JITTER_FACTOR = 0.25
/** Cap for exponential backoff when the provider error carries no retry hint. */
export const MAX_BACKOFF_MS = 30_000
/** setTimeout upper bound for explicit provider hints (for example retry-after). */
export const MAX_HINT_MS = 2_147_483_647

export type RetryInfo = {
  readonly message: string
  readonly retryAfterMs?: number
}

export class RetryableTurnError extends Error {
  constructor(readonly info: RetryInfo) {
    super(info.message)
    this.name = "RetryableTurnError"
  }

  get retryAfterMs() {
    return this.info.retryAfterMs
  }
}

export function providerEvent(message: string): RetryInfo | undefined {
  return Retry.retryableMessage(message)
}

export function retryable(error: unknown): RetryInfo | undefined {
  if (error instanceof LLMError) return llmError(error)
  // Model resolution can fail transiently while a provider catalog is refreshing.
  if (
    error instanceof SessionRunnerModel.ModelNotSelectedError ||
    error instanceof SessionRunnerModel.ModelUnavailableError ||
    error instanceof SessionRunnerModel.VariantUnavailableError
  )
    return { message: error.message }
  return undefined
}

function llmError(error: LLMError) {
  switch (error.reason._tag) {
    case "RateLimit":
    case "ProviderInternal":
      return {
        message: error.reason.message,
        retryAfterMs: error.retryAfterMs ?? Retry.retryHintMs(error.reason.message),
      }
    case "Transport": {
      const reason = error.reason
      if (!Retry.matchesTransient(`${reason.kind ?? ""} ${reason.message}`)) return undefined
      return { message: reason.message, retryAfterMs: Retry.retryHintMs(reason.message) }
    }
    default:
      return undefined
  }
}

export function delayMs(attempt: number, retryAfterMs?: number, random = Math.random()) {
  if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 0)
    return Math.min(Math.max(0, Math.ceil(retryAfterMs)), MAX_HINT_MS)
  const base = INITIAL_DELAY_MS * Math.pow(BACKOFF_FACTOR, attempt - 1) * (1 + JITTER_FACTOR * random)
  return Math.min(MAX_BACKOFF_MS, Math.ceil(base))
}
