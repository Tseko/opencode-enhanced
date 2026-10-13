import { describe, expect } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Effect, Exit, Layer, Schema, Scope } from "effect"
import { testEffect } from "./lib/effect"

const outputStore = Layer.mock(ToolOutputStore.Service, {
  bound: (input) => Effect.succeed({ output: input.output, outputPaths: [] }),
})
const it = testEffect(AppNodeBuilder.build(ToolRegistry.node, [[ToolOutputStore.node, outputStore]]))

const make = (description: string) =>
  Tool.make({
    description,
    input: Schema.Struct({ text: Schema.String }),
    output: Schema.Struct({ text: Schema.String }),
    execute: ({ text }) => Effect.succeed({ text }),
  })

const registerIn = (tools: Readonly<Record<string, Tool.AnyTool>>) =>
  Effect.gen(function* () {
    const service = yield* ToolRegistry.Service
    const scope = yield* Scope.make()
    yield* service.register(tools).pipe(Scope.provide(scope))
    return { service, scope }
  })

describe("ToolRegistry snapshot version", () => {
  it.effect("keeps the hash and epoch stable while the registered set is unchanged", () =>
    Effect.gen(function* () {
      const { service } = yield* registerIn({ echo: make("Echo text") })
      const first = yield* service.materialize()
      expect(first.epoch).toBe(1)
      expect((yield* service.materialize()).hash).toBe(first.hash)

      // A reconnect that re-registers an identical definition must not flap the version.
      const reconnect = yield* registerIn({ echo: make("Echo text") })
      const reconnected = yield* reconnect.service.materialize()
      expect(reconnected).toMatchObject({ epoch: first.epoch, hash: first.hash })
    }),
  )

  it.effect("advances the epoch for a changed definition and for a closed registration scope", () =>
    Effect.gen(function* () {
      const { service, scope } = yield* registerIn({ echo: make("Echo text") })
      const first = yield* service.materialize()

      const changed = yield* registerIn({ echo: make("Echo text, now louder") })
      const louder = yield* changed.service.materialize()
      expect(louder.hash).not.toBe(first.hash)
      expect(louder.epoch).toBe(first.epoch + 1)
      expect(louder.definitions.map((definition) => definition.description)).toEqual(["Echo text, now louder"])

      // The older registration is still live under the newer one; closing the newer owner
      // must restore the original snapshot, not leave a stale owner serving calls.
      yield* Scope.close(changed.scope, Exit.void)
      const restored = yield* service.materialize()
      expect(restored).toMatchObject({ hash: first.hash, epoch: louder.epoch + 1 })

      yield* Scope.close(scope, Exit.void)
      expect((yield* service.materialize()).definitions).toEqual([])
    }),
  )

  it.effect("does not version one agent's permission filter", () =>
    Effect.gen(function* () {
      const { service } = yield* registerIn({ echo: make("Echo text") })
      const all = yield* service.materialize()
      const filtered = yield* service.materialize([{ action: "echo", resource: "*", effect: "deny" }])
      expect(filtered.definitions).toEqual([])
      expect(filtered).toMatchObject({ epoch: all.epoch, hash: all.hash })
    }),
  )

  it.effect("coalesces repeated registrations from one owner instead of growing the entry list", () =>
    Effect.gen(function* () {
      const { service, scope } = yield* registerIn({ echo: make("first") })
      yield* service.register({ echo: make("second") }).pipe(Scope.provide(scope))
      expect((yield* service.stats()).registrations).toBe(1)
      expect((yield* service.materialize()).definitions.map((definition) => definition.description)).toEqual(["second"])
      yield* Scope.close(scope, Exit.void)
      expect((yield* service.materialize()).definitions).toEqual([])
    }),
  )
})
