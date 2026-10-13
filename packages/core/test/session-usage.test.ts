import { describe, expect, test } from "bun:test"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionUsage } from "@opencode-ai/core/session/usage"

const base: ModelV2.Cost = { input: 1, output: 2, cache: { read: 0.5, write: 0.25 } }
const tier100k: ModelV2.Cost = {
  tier: { type: "context", size: 100_000 },
  input: 0.5,
  output: 1,
  cache: { read: 0.2, write: 0.1 },
}
const tier200k: ModelV2.Cost = {
  tier: { type: "context", size: 200_000 },
  input: 0.25,
  output: 0.5,
  cache: { read: 0.1, write: 0.05 },
}

describe("SessionUsage.stepCost", () => {
  test("charges the untiered price per 1M tokens with reasoning at the output rate", () => {
    const cost = SessionUsage.stepCost([base], {
      input: 2_000_000,
      output: 1_000_000,
      reasoning: 500_000,
      cache: { read: 4_000_000, write: 1_000_000 },
    })
    expect(cost).toBeCloseTo(7.25, 12)
  })

  test("charges reasoning at its own rate when the model prices it separately", () => {
    const cost = SessionUsage.stepCost(
      [{ input: 1, output: 2, reasoning: 5, cache: { read: 0, write: 0 } }],
      {
        input: 1_000_000,
        output: 1_000_000,
        reasoning: 1_000_000,
        cache: { read: 0, write: 0 },
      },
    )
    expect(cost).toBeCloseTo(8, 12)
  })

  test("prefers the largest context tier the request exceeds", () => {
    const cost = SessionUsage.stepCost([base, tier100k, tier200k], {
      input: 400_000,
      output: 20_000,
      reasoning: 30_000,
      cache: { read: 50_000, write: 10_000 },
    })
    expect(cost).toBeCloseTo(0.1305, 12)
  })

  test("falls back to the untiered price when no tier applies", () => {
    const cost = SessionUsage.stepCost([base, tier100k, tier200k], {
      input: 50_000,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    })
    expect(cost).toBeCloseTo(0.05, 12)
  })

  test("returns zero when the model has no price list or usage", () => {
    expect(
      SessionUsage.stepCost([], {
        input: 2_000_000,
        output: 1_000_000,
        reasoning: 500_000,
        cache: { read: 4_000_000, write: 1_000_000 },
      }),
    ).toBe(0)
    expect(
      SessionUsage.stepCost([base], {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      }),
    ).toBe(0)
  })
})
