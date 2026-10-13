export * as Retry from "./retry"

export type RetryInfo = {
  readonly message: string
  readonly retryAfterMs?: number
}

// One source of truth for what counts as a transient provider failure across the
// legacy session processor and the V2 session runner. Rate limits, provider
// overload, and network failures all self-heal through the same wording.
const TRANSIENT_MESSAGE_PATTERNS = [
  /\b(?:429|5\d{2})\b/i,
  /rate increased too quickly|rate limit|rate-limit|rate_limit|too many requests/i,
  /overloaded|service unavailable|service_unavailable|service-unavailable|internal error|internal_error|internal server error|server error|server_error|server-error|provider returned error|provider_returned_error|provider-returned-error/i,
  /terminated|fetch failed|failed to fetch|network[-_\s]error|upstream connect|connection error|connection refused|connection lost|socket connection was closed|socket hang up|reset before headers|getaddrinfo|enotfound|eai_again|econnrefused|econnreset|etimedout/i,
  /^timeout$|\b(?:request|response|connection|network|stream|read) (?:timeout|timed out|time out)\b/i,
  /try your request again|retry your request|resource exhausted|resource_exhausted/i,
  /\btry again (?:later|in\b)|\b(?:currently|temporarily) at capacity\b/i,
]

const RETRY_HINT =
  /(?:try again in|retry after)\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?)/i

/** True when a provider message describes a transient, retryable failure. */
export const matchesTransient = (value: unknown) => {
  if (typeof value !== "string") return false
  return TRANSIENT_MESSAGE_PATTERNS.some((pattern) => pattern.test(value))
}

/**
 * Extracts a retry delay from provider hints embedded in free-form text such as
 * `Please try again in 4.155s` or `Retry after 539ms`. Returns milliseconds, or
 * `undefined` when no valid hint is present.
 */
export const retryHintMs = (value: unknown) => {
  if (typeof value !== "string") return undefined
  const match = RETRY_HINT.exec(value)
  if (!match) return undefined
  const amount = Number.parseFloat(match[1])
  if (!Number.isFinite(amount)) return undefined
  return Math.ceil(amount * (match[2].toLowerCase().startsWith("m") ? 1 : 1000))
}

/** Classifies a provider message for transient retry, including any embedded retry hint. */
export const retryableMessage = (message: string): RetryInfo | undefined => {
  if (!matchesTransient(message)) return undefined
  return { message, retryAfterMs: retryHintMs(message) }
}
