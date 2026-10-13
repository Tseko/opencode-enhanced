export * as SessionUsage from "./usage"

import { ModelV2 } from "../model"

/** Token accounting for one provider step (`SessionEvent.Step.Ended.tokens`). */
export interface Tokens {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cache: { readonly read: number; readonly write: number }
}

/**
 * Cost of one provider step in USD from the model price list
 * (`ModelV2.Info.cost`, per-1M-token `input`/`output` plus cache rates).
 * Mirrors the legacy `Session.getUsage` math: non-cached input at the input
 * rate, cache reads/writes at their own rates, reasoning at its own rate
 * (falling back to the output rate when the model does not price it
 * separately), and the largest context tier the request exceeds wins over the
 * untiered default price.
 */
export const stepCost = (cost: readonly ModelV2.Cost[], tokens: Tokens) => {
  const contextTokens = tokens.input + tokens.cache.read + tokens.cache.write
  const price =
    cost
      .filter(
        (item): item is ModelV2.Cost & { readonly tier: { readonly type: "context"; readonly size: number } } =>
          item.tier?.type === "context" && contextTokens > item.tier.size,
      )
      .sort((a, b) => b.tier.size - a.tier.size)[0] ?? cost.find((item) => item.tier === undefined)
  if (!price) return 0
  return Math.max(
    0,
    (tokens.input * price.input) / 1_000_000 +
      (tokens.output * price.output) / 1_000_000 +
      (tokens.cache.read * price.cache.read) / 1_000_000 +
      (tokens.cache.write * price.cache.write) / 1_000_000 +
      (tokens.reasoning * (price.reasoning ?? price.output)) / 1_000_000,
  )
}
