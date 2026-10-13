import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { Readiness } from "@opencode-ai/core/readiness"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const group = LayerNode.group([ApplicationTools.node, Database.node, EventV2.node, LocationServiceMap.node])
const it = testEffect(AppNodeBuilder.build(group))
// The failing graph exercises the record a drain would consult before it can run.
const broken = testEffect(
  AppNodeBuilder.build(group, [
    [ToolRegistry.node, Layer.effect(ToolRegistry.Service, Effect.die("tool registry unavailable"))],
  ]),
)

const withLocation = <A, E, R>(body: (ref: Location.Ref) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
  ).pipe(
    Effect.flatMap((dir) =>
      Effect.scoped(body(Location.Ref.make({ directory: AbsolutePath.make(dir.path) }))),
    ),
  )

const build = (ref: Location.Ref) =>
  LocationServiceMap.Service.pipe(Effect.flatMap((locations) => locations.contextEffect(ref)))

describe("Readiness", () => {
  it.live("records a ready Location with its tool registry snapshot once the graph builds", () =>
    withLocation((ref) =>
      Effect.gen(function* () {
        yield* build(ref)
        const info = Readiness.read(ref)
        expect(info?.state).toBe("ready")
        expect(info?.registryEpoch).toBeGreaterThan(0)
        expect(info?.registryHash).toMatch(/^[0-9a-f]{8}$/)
        yield* Readiness.assertReady(ref)
      }),
    ),
  )

  broken.live("records a failed Location when its graph cannot build", () =>
    withLocation((ref) =>
      Effect.gen(function* () {
        expect(yield* build(ref).pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })
        const info = Readiness.read(ref)
        expect(info?.state).toBe("failed")
        expect(info?.error).toContain("tool registry unavailable")
        expect(yield* Readiness.assertReady(ref).pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })
      }),
    ),
  )

  it.live("passes when a Location has no record, because absence is an observability gap", () =>
    withLocation((ref) =>
      Effect.gen(function* () {
        expect(Readiness.read(ref)).toBeUndefined()
        expect(yield* Readiness.assertReady(ref).pipe(Effect.exit)).toMatchObject({ _tag: "Success" })
      }),
    ),
  )

  it.live("keeps a record that keeps being read when the bounded cache evicts", () =>
    withLocation((ref) =>
      Effect.gen(function* () {
        Readiness.failed(ref, "kept by recency")
        for (let index = 0; index < 256; index++) {
          Readiness.failed(
            Location.Ref.make({ directory: AbsolutePath.make(`${ref.directory}/evictable-${index}`) }),
            "evictable",
          )
          Readiness.read(ref)
        }
        expect(Readiness.read(ref)?.error).toBe("kept by recency")
      }),
    ),
  )
})
