import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { Tool as MCPToolDef } from "@modelcontextprotocol/sdk/types.js"
import { describe, expect } from "bun:test"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { DynamicTools } from "@opencode-ai/core/tool/dynamic-tools"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { Effect, Layer } from "effect"
import { McpDynamicTools } from "@/mcp/dynamic-tools"
import { McpToolSnapshot } from "@/mcp/tool-snapshot"
import type { McpTool } from "@/mcp"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { tmpdir } from "../fixture/fixture"

const sessionID = SessionV2.ID.make("ses_mcp_dynamic_tools")
const identity = {
  agent: AgentV2.ID.make("build"),
  assistantMessageID: SessionMessage.ID.make("msg_mcp_dynamic_tools"),
}

let assertions: PermissionV2.AssertInput[] = []
let calls: Array<{ name: string; input: Record<string, unknown> | undefined }> = []
let denied: string | undefined

/** Nothing in this test needs a real session, so permission is observed instead of resolved. */
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(input.action === denied ? Effect.fail(new PermissionV2.BlockedError({ rules: [] })) : Effect.void),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
    interrupt: () => Effect.void,
  }),
)

const client = {
  callTool: async (params: { name: string; arguments?: Record<string, unknown> }) => {
    calls.push({ name: params.name, input: params.arguments })
    if (params.name === "explode") return { isError: true, content: [{ type: "text" as const, text: "boom" }] }
    return { content: [{ type: "text" as const, text: `ran ${params.name}` }] }
  },
} as unknown as Client

const connect = (directory: string, tools: Record<string, MCPToolDef>) =>
  McpToolSnapshot.publish(
    directory,
    Object.fromEntries(
      Object.entries(tools).map(([name, def]) => [name, { def, client, timeout: 1_000 } satisfies McpTool]),
    ),
  )

const definition = (name: string, inputSchema: MCPToolDef["inputSchema"] = { type: "object", properties: {} }) =>
  ({ name, description: `Runs ${name}`, inputSchema }) satisfies MCPToolDef

const withRegistry = <A, E, R>(
  directory: string,
  body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>,
) => {
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of({
      directory: AbsolutePath.make(directory),
      workspaceID: undefined,
      project: { id: ProjectV2.ID.global, directory: AbsolutePath.make(directory) },
      vcs: undefined,
    } satisfies Location.Interface),
  )
  return Effect.gen(function* () {
    return yield* body(yield* ToolRegistry.Service)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, DynamicTools.node]), [
        [Location.node, activeLocation],
        [DynamicTools.node, McpDynamicTools.node],
        [PermissionV2.node, permission],
        [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      ]),
    ),
  )
}

const call = (registry: ToolRegistry.Interface, name: string) =>
  registry
    .materialize()
    .pipe(
      Effect.flatMap((materialized) =>
        materialized.settle({
          sessionID,
          ...identity,
          call: { type: "tool-call", id: `call-${name}`, name, input: { limit: 3 } },
        }),
      ),
    )

const it = testEffect(Layer.empty)

describe("McpDynamicTools", () => {
  it.live("registers connected MCP tools into the location tool registry", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          assertions = []
          calls = []
          denied = undefined
          yield* connect(dir.path, {
            demo_list_projects: definition("list_projects", {
              type: "object",
              properties: { limit: { type: "number" } },
            }),
          })
          const definitions = yield* withRegistry(dir.path, (registry) =>
            registry.materialize().pipe(Effect.map((materialized) => materialized.definitions)),
          )
          expect(definitions.map((tool) => tool.name)).toContain("demo_list_projects")
          expect(definitions.find((tool) => tool.name === "demo_list_projects")).toMatchObject({
            description: "Runs list_projects",
            inputSchema: {
              type: "object",
              properties: { limit: { type: "number" } },
              additionalProperties: false,
            },
          })
        }),
      ),
    ),
  )

  it.live("executes the MCP tool through the connected client", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          assertions = []
          calls = []
          denied = undefined
          yield* connect(dir.path, { demo_list_projects: definition("list_projects") })
          const settled = yield* withRegistry(dir.path, (registry) => call(registry, "demo_list_projects"))
          expect(settled.result).toEqual({ type: "text", value: "ran list_projects" })
          expect(calls).toEqual([{ name: "list_projects", input: { limit: 3 } }])
          expect(assertions).toMatchObject([
            {
              sessionID,
              agent: identity.agent,
              action: "demo_list_projects",
              resources: ["*"],
              save: ["*"],
              source: { type: "tool", callID: "call-demo_list_projects" },
            },
          ])
        }),
      ),
    ),
  )

  it.live("reports a denied permission instead of calling the server", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          assertions = []
          calls = []
          denied = "demo_list_projects"
          yield* connect(dir.path, { demo_list_projects: definition("list_projects") })
          const settled = yield* withRegistry(dir.path, (registry) => call(registry, "demo_list_projects"))
          expect(settled.result).toEqual({
            type: "error",
            value: "Permission to call MCP tool demo_list_projects was not granted",
          })
          expect(calls).toEqual([])
        }),
      ),
    ),
  )

  it.live("surfaces a tool error reported by the server", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          assertions = []
          calls = []
          denied = undefined
          yield* connect(dir.path, { demo_explode: definition("explode") })
          const settled = yield* withRegistry(dir.path, (registry) => call(registry, "demo_explode"))
          expect(settled.result).toEqual({ type: "error", value: "boom" })
        }),
      ),
    ),
  )

  it.live("re-registers tools after the server republishes them", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          assertions = []
          calls = []
          denied = undefined
          yield* connect(dir.path, { demo_list_projects: definition("list_projects") })
          yield* withRegistry(dir.path, (registry) =>
            Effect.gen(function* () {
              const initial = yield* registry.materialize().pipe(Effect.map((m) => m.definitions.map((t) => t.name)))
              expect(initial).toContain("demo_list_projects")
              yield* connect(dir.path, { demo_list_issues: definition("list_issues") })
              const names = yield* pollWithTimeout(
                registry.materialize().pipe(
                  Effect.map((materialized) => materialized.definitions.map((tool) => tool.name)),
                  Effect.map((names) => (names.includes("demo_list_issues") ? names : undefined)),
                ),
                "republished MCP tools were never registered",
              )
              expect(names).toContain("demo_list_issues")
              expect(names).not.toContain("demo_list_projects")
            }),
          )
        }),
      ),
    ),
  )

  it.live("does not register tools connected for another directory", () =>
    Effect.acquireRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      (dirs) => Effect.promise(() => Promise.all(dirs.map((dir) => dir[Symbol.asyncDispose]())).then(() => undefined)),
    ).pipe(
      Effect.flatMap(([connected, other]) =>
        Effect.gen(function* () {
          assertions = []
          calls = []
          denied = undefined
          yield* connect(connected.path, { demo_list_projects: definition("list_projects") })
          const definitions = yield* withRegistry(other.path, (registry) =>
            registry.materialize().pipe(Effect.map((materialized) => materialized.definitions)),
          )
          expect(definitions.map((tool) => tool.name)).not.toContain("demo_list_projects")
        }),
      ),
    ),
  )
})

/**
 * The desktop server replaces Core's empty placeholder inside the full Location graph.
 * Building that graph is where a replacement mismatch (name, tag, or dependencies) would
 * surface, so this covers the wiring rather than just the node.
 */
const locationIt = testEffect(
  AppNodeBuilder.build(LayerNode.group([ApplicationTools.node, Database.node, EventV2.node, LocationServiceMap.node]), [
    [DynamicTools.node, McpDynamicTools.node],
  ]),
)

describe("McpDynamicTools in the location service map", () => {
  locationIt.live("exposes connected MCP tools through the location tool registry", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          assertions = []
          calls = []
          denied = undefined
          yield* connect(dir.path, { demo_list_projects: definition("list_projects") })
          const names = yield* ToolRegistry.Service.use((registry) =>
            registry.materialize().pipe(Effect.map((materialized) => materialized.definitions.map((tool) => tool.name))),
          ).pipe(
            Effect.provide(
              LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(dir.path) })),
            ),
            Effect.scoped,
          )
          expect(names).toContain("demo_list_projects")
        }),
      ),
    ),
  )
})
