export * as McpToolSnapshot from "./tool-snapshot"

import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, PubSub, Stream } from "effect"
import type { McpTool } from "./index"

/**
 * Process-wide bridge between the MCP connection layer and Location-scoped tool
 * registration.
 *
 * MCP connections are process-global: `MCP.node` is built once in the app graph, and
 * letting a Location depend on it would start a second copy of every configured server.
 * Tool registration, however, has to happen inside a Location layer (see
 * `./dynamic-tools`) because the tool registry is Location-scoped. The two sides meet
 * here instead of in the layer graph: the MCP layer publishes the tools it connected for
 * a directory and registers a hook that connects a directory on demand, and Location
 * layers register tools from what they read.
 *
 * This state is module-level on purpose. Publisher and readers can end up in different
 * Effect graphs, so no layer-scoped value can be shared between them.
 */
type Ensure = (directory: string) => Effect.Effect<void>

const snapshot = new Map<string, Record<string, McpTool>>()
const published = Effect.runSync(PubSub.unbounded<string>())
let ensure: Ensure | undefined

/**
 * Canonical key, so the directory a Location was built for and the directory an HTTP
 * request created its instance for resolve to the same snapshot entry.
 */
export const key = (directory: string) => FSUtil.resolve(directory)

/** Tools the MCP layer connected for `directory`, as of the last publish. */
export const read = (directory: string) => snapshot.get(key(directory)) ?? {}

/**
 * Stream of canonical directories whose tools were republished.
 *
 * The subscription is taken before the stream is pulled, so a publish that happens while
 * a Location is still connecting is queued instead of lost. `Stream.fromPubSub` would
 * subscribe lazily and drop it.
 */
export const changes = () => PubSub.subscribe(published).pipe(Effect.map((subscription) => Stream.fromSubscription(subscription)))

/** Replace a directory's tools and wake up every Location registering them. */
export const publish = (directory: string, tools: Record<string, McpTool>) =>
  Effect.sync(() => {
    const canonical = key(directory)
    snapshot.set(canonical, tools)
    return canonical
  }).pipe(Effect.flatMap((canonical) => PubSub.publish(published, canonical)), Effect.asVoid)

/** Drop a directory's tools, for example because its clients were closed. */
export const invalidate = (directory: string) => publish(directory, {})

/** Registered by the MCP layer so Locations can connect a directory without sequencing it. */
export const setEnsure = (value: Ensure) => Effect.sync(() => void (ensure = value))

export const clearEnsure = (value: Ensure) =>
  Effect.sync(() => {
    if (ensure === value) ensure = undefined
  })

/**
 * Connect `directory` and publish its tools. Resolves once the connection attempt is
 * over, so a freshly built Location already sees the tools of a running server.
 */
export const ensureTools = (directory: string) =>
  ensure
    ? ensure(directory)
    : Effect.logWarning("MCP tools are unavailable because the MCP service is not running", { directory })
