export * as Readiness from "./readiness"

import { Effect } from "effect"
import type { Location } from "./location"

/**
 * Location readiness record.
 *
 * A Location's registries, tools, agents, and config are built by its layer graph, and
 * `LocationServiceMap` builds that graph before a drain can use it. This record makes the
 * barrier observable instead of implicit: the map marks a Location ready (with the tool
 * registry snapshot it built) or failed as it boots, a drain asserts the record before
 * running, and a future worker model can gate dispatch on the same record rather than
 * re-deriving the wiring from the layer code.
 *
 * State is module-level on purpose, for the same reason as `McpToolSnapshot`: maps are built
 * by different Effect graphs, so no layer-scoped value can be shared between the builder and
 * the drain that reads it. Records are bounded and least-recently-read entries are evicted
 * once the capacity is reached, so a long-lived process with many directories cannot grow
 * without bound; because the cache is bounded, an absent record is an observability gap
 * rather than a verdict about the Location.
 */
export const States = ["building", "ready", "failed"] as const
export type State = (typeof States)[number]

export interface Info {
  readonly directory: string
  readonly workspaceID: string | undefined
  readonly state: State
  /** Registry snapshot version of the built Location, for traceability and stale-worker checks. */
  readonly registryEpoch: number | undefined
  readonly registryHash: string | undefined
  readonly error: string | undefined
  readonly updatedAt: number
}

const CAPACITY = 128
const records = new Map<string, Info>()

const keyOf = (ref: Location.Ref) => `${ref.directory}\u0000${ref.workspaceID ?? ""}`

const write = (
  ref: Location.Ref,
  next: Pick<Info, "state" | "registryEpoch" | "registryHash" | "error">,
) => {
  const key = keyOf(ref)
  records.delete(key)
  records.set(key, {
    directory: ref.directory,
    workspaceID: ref.workspaceID,
    ...next,
    updatedAt: Date.now(),
  })
  if (records.size > CAPACITY) {
    const oldest = records.keys().next().value
    if (oldest !== undefined && oldest !== key) records.delete(oldest)
  }
}

/** Recorded when the map starts building a Location's graph. */
export const building = (ref: Location.Ref) =>
  write(ref, { state: "building", registryEpoch: undefined, registryHash: undefined, error: undefined })

/** Recorded from inside the built graph, so it can only describe services that actually built. */
export const ready = (ref: Location.Ref, version: { readonly registryEpoch: number; readonly registryHash: string }) =>
  write(ref, {
    state: "ready",
    registryEpoch: version.registryEpoch,
    registryHash: version.registryHash,
    error: undefined,
  })

export const failed = (ref: Location.Ref, error: string) =>
  write(ref, { state: "failed", registryEpoch: undefined, registryHash: undefined, error })

/**
 * Reads the record and refreshes its recency, so a full cache evicts Locations nobody
 * consults instead of a live Location that was merely built early.
 */
export const read = (ref: Location.Ref) => {
  const key = keyOf(ref)
  const info = records.get(key)
  if (info === undefined) return undefined
  records.delete(key)
  records.set(key, info)
  return info
}

export const all = () => [...records.values()]

/**
 * Invariant check for a drain that is already running behind the map's build barrier: the
 * location graph it was provided must have completed. A future worker model should await
 * the record before dispatch instead of asserting it here.
 *
 * An absent record is not a violation: records are capacity-bounded and written only when a
 * Location's graph is built, so a live Location can legitimately have no record. A record
 * that is present must not be `building` (a drain ran before the build barrier) or `failed`
 * (a drain was handed a graph that did not build).
 */
export const assertReady = (ref: Location.Ref) =>
  Effect.suspend(() => {
    const info = read(ref)
    if (info === undefined)
      return Effect.logWarning("Location has no readiness record", {
        directory: ref.directory,
        workspaceID: ref.workspaceID,
      })
    if (info.state === "ready") return Effect.void
    return Effect.die(`Location is not ready: ${ref.directory} (${info.state}${info.error ? `: ${info.error}` : ""})`)
  })
