export * as InstanceLoader from "./instance-loader"

import type { InstanceContext } from "@/project/instance-context"

/**
 * Lets a Location-scoped layer load the `InstanceContext` for its directory even though it
 * was built in a drain fiber the instance middleware never wrapped.
 *
 * `McpDynamicTools` needs legacy config, which is instance-scoped, but importing the
 * instance graph from there closes a module cycle through `Command` and `MCP`. `AppRuntime`
 * registers its loader here, and consumers only see this leaf module.
 */
export type Loader = (directory: string) => Promise<InstanceContext>

let loader: Loader | undefined

export const register = (value: Loader) => {
  loader = value
}

export const load = (directory: string) => loader?.(directory)
