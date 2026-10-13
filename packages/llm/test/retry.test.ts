import { describe, expect, test } from "bun:test"
import { Retry } from "../src/retry"
import { ProviderAdmission } from "../src/route/admission"

describe("Retry classification", () => {
  test("matches transient provider messages", () => {
    expect(Retry.matchesTransient("Rate limit reached, please try again")).toBe(true)
    expect(Retry.matchesTransient("The model is overloaded")).toBe(true)
    expect(Retry.matchesTransient("Provider request failed with HTTP 503")).toBe(true)
    expect(Retry.matchesTransient("fetch failed")).toBe(true)
    expect(Retry.matchesTransient("Content policy violation")).toBe(false)
    expect(Retry.matchesTransient("You exceeded your current quota")).toBe(false)
  })

  test("extracts retry hints in seconds and milliseconds", () => {
    expect(Retry.retryHintMs("Please try again in 4.155s.")).toBe(4155)
    expect(Retry.retryHintMs("Please try again in 539ms.")).toBe(539)
    expect(Retry.retryHintMs("Retry after 1.25 seconds")).toBe(1250)
    expect(Retry.retryHintMs("No hint here")).toBeUndefined()
    expect(Retry.retryHintMs(undefined)).toBeUndefined()
  })

  test("classifies a message with its embedded retry hint", () => {
    expect(Retry.retryableMessage("Rate limit reached. Please try again in 539ms.")).toEqual({
      message: "Rate limit reached. Please try again in 539ms.",
      retryAfterMs: 539,
    })
    expect(Retry.retryableMessage("prompt is too long for requested model")).toBeUndefined()
  })

  test("fingerprints credentials without exposing them", () => {
    const one = ProviderAdmission.fingerprint("secret-key-1")
    const two = ProviderAdmission.fingerprint("secret-key-2")
    expect(one).not.toBe("secret-key-1")
    expect(one).not.toBe(two)
    expect(one).toBe(ProviderAdmission.fingerprint("secret-key-1"))
  })
})
