export * as ProviderAdmission from "./admission"

import { Clock, Context, Duration, Effect, Layer, Ref, Semaphore } from "effect"

/**
 * Stable admission key for a shared provider resource. Rate limits are usually
 * scoped to a provider account and (for token-based limits) a model, so the key
 * carries both plus a credential fingerprint that distinguishes accounts without
 * ever holding or logging the secret itself.
 */
export interface Key {
  readonly provider: string
  readonly model?: string
  readonly credential: string
}

export interface Interface {
  /**
   * Waits through any active cooldown for `key`, then acquires a concurrency
   * permit. Returns a release effect the caller must run exactly once.
   */
  readonly acquire: (key: Key) => Effect.Effect<Effect.Effect<void>, never>
  /** Opens a shared cooldown for `key` after a retryable provider failure. */
  readonly record: (key: Key, retryAfterMs?: number) => Effect.Effect<void, never>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LLM/ProviderAdmission") {}

const DEFAULT_MAX_CONCURRENT = 8
const DEFAULT_COOLDOWN_MS = 2_000
const MAX_COOLDOWN_MS = 60_000

type Entry = {
  readonly semaphore: Semaphore.Semaphore
  cooldownUntil: number
}

const keyString = (key: Key) => `${key.provider}\u0000${key.model ?? ""}\u0000${key.credential}`

/** FNV-1a fingerprint. Stable across runs, deterministic, and never reversible to the secret. */
export const fingerprint = (value: string) => {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

export const make = (options?: { readonly maxConcurrent?: number }): Effect.Effect<Service> =>
  Effect.gen(function* () {
    const maxConcurrent = options?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT
    const entries = yield* Ref.make(new Map<string, Entry>())

    const entry = (key: Key) =>
      Ref.modify(entries, (current) => {
        const existing = current.get(keyString(key))
        if (existing) return [existing, current] as const
        const created: Entry = { semaphore: Semaphore.makeUnsafe(maxConcurrent), cooldownUntil: 0 }
        return [created, new Map(current).set(keyString(key), created)] as const
      })

    const acquire = (key: Key) =>
      Effect.gen(function* () {
        const target = yield* entry(key)
        const now = yield* Clock.currentTimeMillis
        const wait = target.cooldownUntil - now
        if (wait > 0) yield* Effect.sleep(Duration.millis(wait))
        yield* target.semaphore.take(1)
        return target.semaphore.release(1).pipe(Effect.asVoid)
      })

    const record = (key: Key, retryAfterMs?: number) =>
      Effect.gen(function* () {
        const target = yield* entry(key)
        const requested = retryAfterMs === undefined ? DEFAULT_COOLDOWN_MS : retryAfterMs
        const delay = Math.min(Math.max(0, Math.ceil(requested)), MAX_COOLDOWN_MS)
        const now = yield* Clock.currentTimeMillis
        target.cooldownUntil = Math.max(target.cooldownUntil, now + delay)
      })

    return Service.of({ acquire, record })
  })

export const layer: Layer.Layer<Service> = Layer.effect(Service, make())
