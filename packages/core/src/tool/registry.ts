export * as ToolRegistry from "./registry"

import { ToolOutput, type ToolCall, type ToolDefinition, type ToolResultValue } from "@opencode-ai/llm"
import { Context, Effect, Layer, Scope } from "effect"
import { AgentV2 } from "../agent"
import { PermissionV2 } from "../permission"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import { ToolOutputStore } from "../tool-output-store"
import { Wildcard } from "../util/wildcard"
import { ApplicationTools } from "./application-tools"
import { definition, permission, settle, validateName, type AnyTool, type RegistrationError } from "./tool"
import { Tools } from "./tools"
import { makeLocationNode } from "../effect/app-node"

export type ExecuteInput = {
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly call: ToolCall
}

export interface Interface {
  readonly materialize: (permissions?: PermissionV2.Ruleset) => Effect.Effect<Materialization>
  /** Inspectable registry state for readiness records, diagnostics, and tests. */
  readonly stats: () => Effect.Effect<RegistryStats>
  /** Internal registration capability exposed publicly only through Tools.Service. */
  readonly register: (tools: Readonly<Record<string, AnyTool>>) => Effect.Effect<void, RegistrationError, Scope.Scope>
}

/** Inspectable registry state: held registration entries and the current snapshot version. */
export interface RegistryStats {
  readonly registrations: number
  readonly epoch: number
  readonly hash: string
}

export interface Materialization {
  /**
   * Monotonic snapshot version of the registry. It advances only when `hash` changes, so a
   * caller can tell a genuinely new tool set from a rebuild of the same one.
   */
  readonly epoch: number
  /**
   * Content hash of the registered definitions (names, descriptions, schemas, permission
   * actions). Describes the registered set, independent of one agent's permission filter.
   */
  readonly hash: string
  readonly definitions: ReadonlyArray<ToolDefinition>
  readonly settle: (input: ExecuteInput) => Effect.Effect<Settlement, ToolOutputStore.Error>
}

export interface Settlement {
  readonly result: ToolResultValue
  readonly output?: ToolOutput
  readonly outputPaths?: ReadonlyArray<string>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ToolRegistry") {}

const registryLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const applications = yield* ApplicationTools.Service
    const resources = yield* ToolOutputStore.Service
    type Registration = { readonly identity: object; readonly tool: AnyTool }
    const local = new Map<string, Array<{ readonly token: object; readonly registration: Registration }>>()
    const fingerprints = new WeakMap<object, string>()
    let epoch = 0
    let version: string | undefined

    /**
     * Content identity of one registration, cached by its immutable identity object. A
     * repeat registration of the same tool therefore keeps the same fingerprint, which is
     * what lets `materialize` report a stable hash across reconnects.
     */
    const fingerprintOf = (name: string, registration: Registration) => {
      const cached = fingerprints.get(registration.identity)
      if (cached !== undefined) return cached
      const value = definition(name, registration.tool)
      const fingerprint = JSON.stringify({
        name: value.name,
        description: value.description,
        inputSchema: value.inputSchema,
        outputSchema: value.outputSchema,
        permission: permission(registration.tool, name),
      })
      fingerprints.set(registration.identity, fingerprint)
      return fingerprint
    }

    /**
     * Current registration set plus its snapshot version. The identity is computed before a
     * permission filter: it versions the registered set, not one agent's advertised subset,
     * so a reconnect that re-registers identical definitions keeps the same hash and epoch.
     */
    const snapshot = () => {
      const registrations = new Map(applications.entries())
      for (const [name, entries] of local) {
        const registration = entries.at(-1)?.registration
        if (registration) registrations.set(name, registration)
      }
      const hash = fingerprint(
        [...registrations]
          .map(([name, registration]) => `${name}\u0000${fingerprintOf(name, registration)}`)
          .toSorted(),
      )
      if (hash !== version) {
        version = hash
        epoch += 1
      }
      return { registrations, hash }
    }

    const settleWith = Effect.fn("ToolRegistry.settle")(function* (input: ExecuteInput, advertised?: object) {
      const registration =
        local.get(input.call.name)?.at(-1)?.registration ?? applications.entries().get(input.call.name)
      if (!registration)
        return {
          result: {
            type: "error" as const,
            value: advertised ? `Stale tool call: ${input.call.name}` : `Unknown tool: ${input.call.name}`,
          },
        }
      if (advertised && registration.identity !== advertised)
        return { result: { type: "error" as const, value: `Stale tool call: ${input.call.name}` } }
      const pending = yield* settle(registration.tool, input.call, {
        sessionID: input.sessionID,
        agent: input.agent,
        assistantMessageID: input.assistantMessageID,
        toolCallID: input.call.id,
      }).pipe(
        Effect.map((output) => ({ output })),
        Effect.catchTag("LLM.ToolFailure", (failure) =>
          Effect.succeed({ result: { type: "error" as const, value: failure.message } }),
        ),
      )
      if ("result" in pending) return pending
      const output = pending.output
      const bounded = yield* resources.bound({ sessionID: input.sessionID, toolCallID: input.call.id, output })
      const result = ToolOutput.toResultValue(bounded.output)
      if (result.type === "error")
        return bounded.outputPaths.length > 0 ? { result, outputPaths: bounded.outputPaths } : { result }
      return bounded.outputPaths.length > 0
        ? { result, output: bounded.output, outputPaths: bounded.outputPaths }
        : { result, output: bounded.output }
    })

    return Service.of({
      register: Effect.fn("ToolRegistry.register")(function* (tools) {
        const entries = Object.entries(tools)
        if (entries.length === 0) return
        yield* Effect.forEach(entries, ([name]) => validateName(name), { discard: true })
        // The owner is the registering scope: a repeat registration from the same scope
        // replaces its own entry instead of growing the list, and closing the scope removes
        // exactly the entries it owns.
        const token = yield* Scope.Scope
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            for (const [name, tool] of entries) {
              const prior = (local.get(name) ?? []).filter((entry) => entry.token !== token)
              local.set(name, [...prior, { token, registration: { identity: {}, tool } }])
            }
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                for (const [name] of entries) {
                  const registrations = local.get(name)?.filter((registration) => registration.token !== token) ?? []
                  if (registrations.length > 0) local.set(name, registrations)
                  else local.delete(name)
                }
              }),
            )
          }),
        )
      }),
      stats: Effect.fn("ToolRegistry.stats")(function* () {
        const { hash } = snapshot()
        const registrations = [...local.values()].reduce((total, entries) => total + entries.length, 0)
        return { registrations: registrations + applications.entries().size, epoch, hash }
      }),
      materialize: Effect.fn("ToolRegistry.materialize")(function* (permissions = []) {
        const { registrations, hash } = snapshot()
        for (const [name, registration] of registrations)
          if (whollyDisabled(permission(registration.tool, name), permissions)) registrations.delete(name)
        return {
          epoch,
          hash,
          definitions: [...registrations]
            .toSorted(([left], [right]) => left.localeCompare(right))
            .map(([name, registration]) => definition(name, registration.tool)),
          settle: (input) => {
            const registration = registrations.get(input.call.name)
            if (registration) return settleWith(input, registration.identity)
            return Effect.succeed({ result: { type: "error", value: `Unknown tool: ${input.call.name}` } })
          },
        }
      }),
    })
  }),
)

const layer = Layer.effect(
  Tools.Service,
  Service.use((registry) => Effect.succeed(Tools.Service.of({ register: registry.register }))),
).pipe(Layer.provideMerge(registryLayer))

function whollyDisabled(action: string, rules: PermissionV2.Ruleset) {
  const rule = rules.findLast((rule) => Wildcard.match(action, rule.action))
  return rule?.resource === "*" && rule.effect === "deny"
}

/**
 * Change detector for the registry snapshot, not a security primitive: a collision only
 * means a version bump is missed, never that a stale owner is trusted (settlement still
 * compares registration identities).
 */
function fingerprint(parts: ReadonlyArray<string>) {
  let hash = 0x811c9dc5
  const value = parts.join("\u0001")
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [ApplicationTools.node, ToolOutputStore.node],
})

export const toolsNode = makeLocationNode({
  service: Tools.Service,
  layer,
  deps: [ApplicationTools.node, ToolOutputStore.node],
})
