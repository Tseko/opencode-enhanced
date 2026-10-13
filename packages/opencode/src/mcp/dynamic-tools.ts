export * as McpDynamicTools from "./dynamic-tools"

import { CallToolResultSchema, type CallToolResult, type Tool as MCPToolDef } from "@modelcontextprotocol/sdk/types.js"
import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Tools } from "@opencode-ai/core/tool/tools"
import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Exit, Layer, Ref, Schema, Scope, Semaphore, Stream } from "effect"
import type { McpTool } from "./index"
import { McpToolSnapshot } from "./tool-snapshot"

/**
 * Registers the tools of every connected MCP server into the Location's tool registry.
 *
 * This replaces Core's empty `DynamicTools.node`. Registration has to happen inside a
 * Location because the registry is Location-scoped, while the MCP connections are
 * process-global: the tool data reaches this layer through `./tool-snapshot` instead of a
 * node dependency, so building a Location never starts a second set of servers.
 */
const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const location = yield* Location.Service
    // Refreshes are serialized: a `tools/list_changed` notification can arrive while the
    // initial registration is still running.
    const lock = Semaphore.makeUnsafe(1)
    // Registrations live in their own scope so a refresh can replace them wholesale.
    const registered = yield* Ref.make<Scope.Closeable | undefined>(undefined)

    const refresh = lock.withPermit(
      Effect.gen(function* () {
        const previous = yield* Ref.get(registered)
        if (previous) yield* Scope.close(previous, Exit.void)
        const scope = yield* Scope.make()
        const connected = McpToolSnapshot.read(location.directory)
        yield* Effect.forEach(
          Object.entries(connected),
          ([name, tool]) =>
            tools.register({ [name]: makeTool(name, tool, permission) }).pipe(
              Scope.provide(scope),
              // One unusable name must not cost the model every other MCP tool.
              Effect.catchTag("Tool.RegistrationError", (error) =>
                Effect.logWarning("skipping MCP tool with an unusable name", { name, error: error.message }),
              ),
            ),
          { discard: true },
        )
        yield* Ref.set(registered, scope)
      }),
    )

    // Subscribe before connecting: the subscription is taken synchronously, so a publish
    // that lands while the servers below connect is queued instead of lost.
    const changes = yield* McpToolSnapshot.changes()
    yield* changes.pipe(
      Stream.filter((directory) => directory === McpToolSnapshot.key(location.directory)),
      Stream.runForEach(() => refresh),
      Effect.forkScoped,
    )
    yield* McpToolSnapshot.ensureTools(location.directory)
    yield* refresh
    yield* Effect.addFinalizer(() =>
      Ref.get(registered).pipe(Effect.flatMap((scope) => (scope ? Scope.close(scope, Exit.void) : Effect.void))),
    )
  }),
)

function makeTool(name: string, tool: McpTool, permission: PermissionV2.Interface) {
  return Tool.make({
    description: tool.def.description ?? "",
    input: Schema.Unknown,
    output: Schema.String,
    jsonSchema: inputSchema(tool.def),
    execute: (input, context) =>
      Effect.gen(function* () {
        yield* permission
          .assert({
            action: name,
            resources: ["*"],
            save: ["*"],
            metadata: {},
            sessionID: context.sessionID,
            agent: context.agent,
            source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
          })
          .pipe(
            Effect.mapError(
              () => new ToolFailure({ message: `Permission to call MCP tool ${name} was not granted` }),
            ),
          )
        const result = yield* Effect.tryPromise({
          try: () =>
            tool.client.callTool(
              { name: tool.def.name, arguments: (input ?? {}) as Record<string, unknown> },
              CallToolResultSchema,
              {
                resetTimeoutOnProgress: true,
                timeout: tool.timeout,
                // The SDK only sends a progress token when this hook is present, which is
                // what allows `timeout` to reset on progress.
                onprogress: () => {},
              },
            ),
          catch: (error) => new ToolFailure({ message: error instanceof Error ? error.message : String(error) }),
        })
        const text = toolResultText(result)
        if (result.isError) return yield* new ToolFailure({ message: text || `MCP tool ${tool.def.name} failed` })
        return text
      }),
  })
}

/** MCP tool parameters are owned by the server, so they are advertised verbatim. */
function inputSchema(definition: MCPToolDef) {
  return {
    ...(definition.inputSchema as Record<string, unknown>),
    type: "object",
    properties: (definition.inputSchema.properties ?? {}) as Record<string, unknown>,
    additionalProperties: false,
  }
}

function toolResultText(result: CallToolResult) {
  const parts = result.content.flatMap((item) =>
    item.type === "text"
      ? [item.text]
      : item.type === "image" || item.type === "audio"
        ? // Binary payloads would swamp the context; name them and let the model ask again.
          [`[${item.type}: ${item.mimeType}]`]
        : [JSON.stringify(item)],
  )
  if (parts.length > 0) return parts.join("\n\n").trim()
  if (result.structuredContent !== undefined && result.structuredContent !== null)
    return JSON.stringify(result.structuredContent, null, 2)
  return ""
}

export const node = makeLocationNode({
  name: "dynamic-tools",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, Location.node],
})
