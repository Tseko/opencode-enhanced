import { describe, expect, test } from "bun:test"
import {
  LLMError,
  ProviderInternalReason,
  QuotaExceededReason,
  RateLimitReason,
  TransportReason,
  type LLMErrorReason,
} from "@opencode-ai/llm"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { TurnRetry } from "@opencode-ai/core/session/runner/retry"

const OPENAI_TPM_LIMIT =
  "Rate limit reached for gpt-5.6-luna in organization org-XsE3dvwLQGaKeFAfa01piu3D on tokens per min (TPM): " +
  "Limit 500000, Used 453487, Requested 81138. Please try again in 4.155s. " +
  "Visit https://platform.openai.com/account/rate-limits to learn more."

const llmError = (reason: LLMErrorReason) => new LLMError({ module: "test", method: "stream", reason })

describe("TurnRetry classification", () => {
  test("retries rate-limit LLM errors and honors the provider retry hint", () => {
    expect(
      TurnRetry.retryable(llmError(new RateLimitReason({ message: OPENAI_TPM_LIMIT, retryAfterMs: 4155 }))),
    ).toEqual({ message: OPENAI_TPM_LIMIT, retryAfterMs: 4155 })
    expect(
      TurnRetry.retryable(llmError(new RateLimitReason({ message: "Rate limit reached without a hint" }))),
    ).toEqual({ message: "Rate limit reached without a hint", retryAfterMs: undefined })
  })

  test("retries provider internal errors", () => {
    expect(
      TurnRetry.retryable(
        llmError(
          new ProviderInternalReason({
            message: "Provider request failed with HTTP 503",
            status: 503,
            retryAfterMs: 1200,
          }),
        ),
      ),
    ).toEqual({ message: "Provider request failed with HTTP 503", retryAfterMs: 1200 })
  })

  test("retries transient transport failures but not quota or invalid request errors", () => {
    expect(TurnRetry.retryable(llmError(new TransportReason({ message: "terminated", kind: "TransportError" })))).toEqual(
      { message: "terminated", retryAfterMs: undefined },
    )
    expect(TurnRetry.retryable(llmError(new TransportReason({ message: "fetch failed" })))).toMatchObject({
      message: "fetch failed",
    })
    expect(TurnRetry.retryable(llmError(new TransportReason({ message: "Provider unavailable" })))).toBeUndefined()
    expect(TurnRetry.retryable(llmError(new QuotaExceededReason({ message: "Insufficient quota" })))).toBeUndefined()
  })

  test("classifies transient provider stream error messages", () => {
    expect(TurnRetry.providerEvent(OPENAI_TPM_LIMIT)).toEqual({
      message: OPENAI_TPM_LIMIT,
      retryAfterMs: 4155,
    })
    expect(TurnRetry.providerEvent("Rate limit reached. Please try again in 539ms.")).toEqual({
      message: "Rate limit reached. Please try again in 539ms.",
      retryAfterMs: 539,
    })
    const capacity = TurnRetry.providerEvent(
      "The model is currently at capacity due to high demand. Please try again in a few minutes.",
    )
    expect(capacity?.retryAfterMs).toBeUndefined()
    expect(TurnRetry.providerEvent("Provider request failed with HTTP 529")?.message).toBe(
      "Provider request failed with HTTP 529",
    )
    expect(TurnRetry.providerEvent("overloaded_error: Overloaded")?.message).toBe("overloaded_error: Overloaded")
  })

  test("keeps non-transient provider messages unretryable", () => {
    expect(TurnRetry.providerEvent("summary unavailable")).toBeUndefined()
    expect(TurnRetry.providerEvent("prompt is too long for requested model")).toBeUndefined()
    expect(TurnRetry.providerEvent("Content policy violation")).toBeUndefined()
    expect(TurnRetry.providerEvent("You exceeded your current quota")).toBeUndefined()
  })

  test("retries transient model resolution failures only", () => {
    const providerID = ProviderV2.ID.make("fake")
    const modelID = ModelV2.ID.make("fake-model")
    const variant = ModelV2.VariantID.make("high")
    expect(
      TurnRetry.retryable(new SessionRunnerModel.ModelUnavailableError({ providerID, modelID })),
    ).toEqual({ message: "Model unavailable: fake/fake-model" })
    expect(
      TurnRetry.retryable(
        new SessionRunnerModel.VariantUnavailableError({ providerID, modelID, variant }),
      ),
    ).toEqual({ message: "Variant unavailable for fake/fake-model: high" })
    expect(
      TurnRetry.retryable(
        new SessionRunnerModel.ModelNotSelectedError({ sessionID: SessionV2.ID.make("ses_turn_retry") }),
      ),
    ).toEqual({ message: "No model is available for session ses_turn_retry" })
    expect(
      TurnRetry.retryable(
        new SessionRunnerModel.UnsupportedApiError({
          providerID,
          modelID,
          api: "aisdk:@ai-sdk/openai-compatible",
        }),
      ),
    ).toBeUndefined()
  })

  test("RetryableTurnError surfaces the provider message and hint", () => {
    const failure = new TurnRetry.RetryableTurnError({ message: "busy", retryAfterMs: 500 })
    expect(failure.message).toBe("busy")
    expect(failure.retryAfterMs).toBe(500)
  })
})

describe("TurnRetry delay", () => {
  test("backoffs exponentially with jitter when no retry hint exists", () => {
    expect(TurnRetry.delayMs(1, undefined, 0)).toBe(2000)
    expect(TurnRetry.delayMs(1, undefined, 1)).toBe(2500)
    expect(TurnRetry.delayMs(2, undefined, 0)).toBe(4000)
    expect(TurnRetry.delayMs(4, undefined, 0)).toBe(16000)
  })

  test("caps backoff at 30 seconds without a hint and honors explicit hints", () => {
    expect(TurnRetry.delayMs(10, undefined, 1)).toBe(TurnRetry.MAX_BACKOFF_MS)
    expect(TurnRetry.delayMs(5, undefined, 1)).toBe(TurnRetry.MAX_BACKOFF_MS)
    expect(TurnRetry.delayMs(1, 4155)).toBe(4155)
    expect(TurnRetry.delayMs(3, 0)).toBe(0)
    expect(TurnRetry.delayMs(1, 60_000)).toBe(60_000)
  })
})
