import { describe, expect } from "bun:test"
import { Effect, Fiber } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { ProviderAdmission } from "../src/route/admission"
import { it } from "./lib/effect"

const key = { provider: "openai", model: "gpt-5.6-luna", credential: "account-1" }

describe("ProviderAdmission", () => {
  it.effect("delays acquisition until a recorded cooldown expires", () =>
    Effect.gen(function* () {
      const admission = yield* ProviderAdmission.make()
      yield* admission.record(key, 4155)

      let started = false
      const fiber = yield* Effect.gen(function* () {
        const release = yield* admission.acquire(key)
        started = true
        yield* release
      }).pipe(Effect.forkChild)

      yield* TestClock.adjust(4154)
      yield* Effect.yieldNow
      expect(started).toBe(false)

      yield* TestClock.adjust(1)
      yield* Fiber.join(fiber)
      expect(started).toBe(true)
    }),
  )

  it.effect("applies a default cooldown when no retry hint is available", () =>
    Effect.gen(function* () {
      const admission = yield* ProviderAdmission.make()
      yield* admission.record(key)

      let started = false
      const fiber = yield* Effect.gen(function* () {
        const release = yield* admission.acquire(key)
        started = true
        yield* release
      }).pipe(Effect.forkChild)

      yield* TestClock.adjust(1999)
      yield* Effect.yieldNow
      expect(started).toBe(false)

      yield* TestClock.adjust(1)
      yield* Fiber.join(fiber)
      expect(started).toBe(true)
    }),
  )

  it.effect("isolates cooldowns by key", () =>
    Effect.gen(function* () {
      const admission = yield* ProviderAdmission.make()
      yield* admission.record(key, 4155)

      const release = yield* admission.acquire({ ...key, model: "another-model" })
      yield* release
    }),
  )

  it.effect("returns a release that restores a permit", () =>
    Effect.gen(function* () {
      const admission = yield* ProviderAdmission.make({ maxConcurrent: 1 })
      const release = yield* admission.acquire(key)

      let second = false
      const fiber = yield* Effect.gen(function* () {
        const inner = yield* admission.acquire(key)
        second = true
        yield* inner
      }).pipe(Effect.forkChild)

      yield* Effect.yieldNow
      expect(second).toBe(false)

      yield* release
      yield* Fiber.join(fiber)
      expect(second).toBe(true)
    }),
  )
})
