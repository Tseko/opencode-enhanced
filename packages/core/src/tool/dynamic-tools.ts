export * as DynamicTools from "./dynamic-tools"

import { Layer } from "effect"
import { makeLocationNode } from "../effect/app-node"

/**
 * Location-scoped extension point for tools that are registered by the host
 * runtime at request time instead of being compiled into the static built-in
 * list in `tool/builtins`.
 *
 * Core ships an empty implementation so the Location graph is always complete.
 * The server replaces this node with one that registers dynamic tools through
 * `Tools.Service` once their providers are connected, which is how MCP (and
 * later plugin) tools reach `ToolRegistry.materialize`.
 */
export const node = makeLocationNode({
  name: "dynamic-tools",
  layer: Layer.empty,
  deps: [],
})
