import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { InstructionContext } from "@opencode-ai/core/instruction-context"
import { InstructionRule } from "@opencode-ai/core/instruction-rule"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

const instructionLayer = (input: {
  config: string
  locationServiceLayer: Layer.Layer<Location.Service>
  filesystemLayer?: Layer.Layer<FSUtil.Service>
}) =>
  AppNodeBuilder.build(LayerNode.group([SystemContextRegistry.node, InstructionContext.node]), [
    [Global.node, Global.layerWith({ config: input.config })],
    [Location.node, input.locationServiceLayer],
    ...(input.filesystemLayer ? [[FSUtil.node, input.filesystemLayer] as const] : []),
  ])

describe("InstructionContext", () => {
  it.live("loads global and upward project AGENTS.md files as one aggregate context", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const directory = path.join(project, "packages", "core")
          const outside = path.join(tmp.path, "AGENTS.md")
          const globalFile = path.join(global, "AGENTS.md")
          const projectFile = path.join(project, "AGENTS.md")
          const packageFile = path.join(directory, "AGENTS.md")
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.mkdir(directory, { recursive: true })
            await fs.writeFile(outside, "outside")
            await fs.writeFile(globalFile, "global")
            await fs.writeFile(projectFile, "project")
            await fs.writeFile(packageFile, "package")
          })

          const load = SystemContextRegistry.Service.pipe(
            Effect.flatMap((service) => service.load()),
            Effect.provide(
              instructionLayer({
                config: global,
                locationServiceLayer: Layer.succeed(
                  Location.Service,
                  Location.Service.of(
                    location(
                      { directory: AbsolutePath.make(directory) },
                      { projectDirectory: AbsolutePath.make(project) },
                    ),
                  ),
                ),
              }),
            ),
          )

          const initialized = yield* SystemContext.initialize(yield* load)
          expect(initialized.baseline).toBe(
            [
              `Instructions from: ${globalFile}\nglobal`,
              `Instructions from: ${packageFile}\npackage`,
              `Instructions from: ${projectFile}\nproject`,
            ].join("\n\n"),
          )
          expect(initialized.baseline).not.toContain("outside")

          yield* Effect.promise(() => fs.writeFile(packageFile, "changed"))
          const changed = yield* SystemContext.reconcile(yield* load, initialized.snapshot)
          expect(changed).toMatchObject({
            _tag: "Updated",
            text: expect.stringContaining(`Updated instructions from: ${packageFile}\nchanged`),
          })
          if (changed._tag === "Updated") {
            expect(changed.text).not.toContain(`Instructions from: ${globalFile}\nglobal`)
            expect(changed.text).not.toContain(`Instructions from: ${projectFile}\nproject`)
          }

          yield* Effect.promise(() => fs.rm(packageFile))
          const partial = yield* SystemContext.reconcile(yield* load, initialized.snapshot)
          expect(partial).toEqual({
            _tag: "Updated",
            text: `Instructions from: ${packageFile} no longer apply.`,
            snapshot: expect.any(Object),
          })

          yield* Effect.promise(() => Promise.all([fs.rm(globalFile), fs.rm(projectFile)]))
          expect(yield* SystemContext.reconcile(yield* load, initialized.snapshot)).toEqual({
            _tag: "Updated",
            text: "Previously loaded instructions no longer apply.",
            snapshot: {},
          })
        }),
      ),
    ),
  )

  it.live("loads global rules files after project AGENTS.md on every location", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const globalFile = path.join(global, "AGENTS.md")
          const projectFile = path.join(project, "AGENTS.md")
          const ruleFile = path.join(global, "rules", "01-user.md")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(global, "rules"), { recursive: true })
            await fs.mkdir(project, { recursive: true })
            await fs.writeFile(globalFile, "global")
            await fs.writeFile(projectFile, "project")
            await fs.writeFile(ruleFile, "never use dotnet build")
          })

          const context = yield* SystemContextRegistry.Service.pipe(
            Effect.flatMap((service) => service.load()),
            Effect.provide(
              instructionLayer({
                config: global,
                locationServiceLayer: Layer.succeed(
                  Location.Service,
                  Location.Service.of(
                    location(
                      { directory: AbsolutePath.make(project) },
                      { projectDirectory: AbsolutePath.make(project) },
                    ),
                  ),
                ),
              }),
            ),
          )

          expect((yield* SystemContext.initialize(context)).baseline).toBe(
            [
              `Instructions from: ${globalFile}\nglobal`,
              `Instructions from: ${projectFile}\nproject`,
              `Instructions from: ${ruleFile}\nnever use dotnet build`,
            ].join("\n\n"),
          )
        }),
      ),
    ),
  )

  it.live("skips glob and match rules until the location or session signals hit", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "Telmetra")
          const autrady = path.join(tmp.path, "Autrady")
          const alwaysFile = path.join(global, "rules", "always.md")
          const razorFile = path.join(global, "rules", "razor.md")
          const autradyFile = path.join(global, "rules", "autrady.md")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(global, "rules"), { recursive: true })
            await fs.mkdir(project, { recursive: true })
            await fs.mkdir(autrady, { recursive: true })
            await fs.writeFile(
              alwaysFile,
              `---
alwaysApply: true
---
always`,
            )
            await fs.writeFile(
              razorFile,
              `---
alwaysApply: false
globs: "**/*.cshtml"
---
razor`,
            )
            await fs.writeFile(
              autradyFile,
              `---
alwaysApply: false
match:
  - autrady
---
autrady`,
            )
          })

          const telmetra = yield* SystemContextRegistry.Service.pipe(
            Effect.flatMap((service) => service.load()),
            Effect.provide(
              instructionLayer({
                config: global,
                locationServiceLayer: Layer.succeed(
                  Location.Service,
                  Location.Service.of(
                    location(
                      { directory: AbsolutePath.make(project) },
                      { projectDirectory: AbsolutePath.make(project) },
                    ),
                  ),
                ),
              }),
            ),
          )
          expect((yield* SystemContext.initialize(telmetra)).baseline).toContain(`Instructions from: ${alwaysFile}`)
          expect((yield* SystemContext.initialize(telmetra)).baseline).not.toContain("razor")
          expect((yield* SystemContext.initialize(telmetra)).baseline).not.toContain("autrady")

          const autradyCtx = yield* SystemContextRegistry.Service.pipe(
            Effect.flatMap((service) => service.load()),
            Effect.provide(
              instructionLayer({
                config: global,
                locationServiceLayer: Layer.succeed(
                  Location.Service,
                  Location.Service.of(
                    location(
                      { directory: AbsolutePath.make(autrady) },
                      { projectDirectory: AbsolutePath.make(autrady) },
                    ),
                  ),
                ),
              }),
            ),
          )
          expect((yield* SystemContext.initialize(autradyCtx)).baseline).toContain(
            `Instructions from: ${autradyFile}\nautrady`,
          )
          expect((yield* SystemContext.initialize(autradyCtx)).baseline).not.toContain("razor")

          const razorCtx = yield* SystemContextRegistry.Service.pipe(
            Effect.flatMap((service) => service.load()),
            Effect.provide(
              instructionLayer({
                config: global,
                locationServiceLayer: Layer.succeed(
                  Location.Service,
                  Location.Service.of(
                    location(
                      { directory: AbsolutePath.make(project) },
                      { projectDirectory: AbsolutePath.make(project) },
                    ),
                  ),
                ),
              }),
            ),
            Effect.provideService(
              InstructionRule.SignalsService,
              InstructionRule.SignalsService.of({
                text: "",
                paths: [path.join(project, "Views", "Home.cshtml")],
              }),
            ),
          )
          expect((yield* SystemContext.initialize(razorCtx)).baseline).toContain(`Instructions from: ${razorFile}`)
        }),
      ),
    ),
  )

  it.live("keeps an empty AGENTS.md as available context", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const file = path.join(tmp.path, "AGENTS.md")
          yield* Effect.promise(() => fs.writeFile(file, ""))
          const context = yield* SystemContextRegistry.Service.pipe(
            Effect.flatMap((service) => service.load()),
            Effect.provide(
              instructionLayer({
                config: path.join(tmp.path, "global"),
                locationServiceLayer: Layer.succeed(
                  Location.Service,
                  Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
                ),
              }),
            ),
          )

          expect((yield* SystemContext.initialize(context)).baseline).toBe(`Instructions from: ${file}\n`)
        }),
      ),
    ),
  )

  it.effect("preserves admitted instructions while observation is unavailable", () =>
    Effect.gen(function* () {
      const failingFS = Layer.effect(
        FSUtil.Service,
        FSUtil.Service.pipe(
          Effect.map((fs) =>
            FSUtil.Service.of({ ...fs, up: () => Effect.fail(new FSUtil.FileSystemError({ method: "up" })) }),
          ),
        ),
      ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
      const context = yield* SystemContextRegistry.Service.pipe(
        Effect.flatMap((service) => service.load()),
        Effect.provide(
          instructionLayer({
            config: "/global",
            filesystemLayer: failingFS,
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(location({ directory: AbsolutePath.make("/repo") })),
            ),
          }),
        ),
      )

      expect(
        yield* SystemContext.reconcile(context, {
          "core/instructions": {
            value: [{ path: "/repo/AGENTS.md", content: "old" }],
            removed: "Previously loaded instructions no longer apply.",
          },
        }),
      ).toEqual({ _tag: "Unchanged" })
    }),
  )

  it.effect("preserves admitted instructions when a discovered file disappears before read", () =>
    Effect.gen(function* () {
      const file = AbsolutePath.make("/repo/AGENTS.md")
      const racingFS = Layer.effect(
        FSUtil.Service,
        FSUtil.Service.pipe(
          Effect.map((fs) =>
            FSUtil.Service.of({
              ...fs,
              up: () => Effect.succeed([file]),
              readFileStringSafe: () => Effect.succeed(undefined),
            }),
          ),
        ),
      ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
      const context = yield* SystemContextRegistry.Service.pipe(
        Effect.flatMap((service) => service.load()),
        Effect.provide(
          instructionLayer({
            config: "/global",
            filesystemLayer: racingFS,
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(location({ directory: AbsolutePath.make("/repo") })),
            ),
          }),
        ),
      )

      expect(
        yield* SystemContext.reconcile(context, {
          "core/instructions": {
            value: [{ path: file, content: "old" }],
            removed: "Previously loaded instructions no longer apply.",
          },
        }),
      ).toEqual({ _tag: "Unchanged" })
    }),
  )

  it.effect("canonicalizes upward discovery boundaries", () =>
    Effect.gen(function* () {
      let observed: { targets: string[]; start: string; stop?: string } | undefined
      const observingFS = Layer.effect(
        FSUtil.Service,
        FSUtil.Service.pipe(
          Effect.map((fs) =>
            FSUtil.Service.of({
              ...fs,
              up: (options) =>
                Effect.sync(() => {
                  observed = options
                  return []
                }),
            }),
          ),
        ),
      ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))

      yield* SystemContextRegistry.Service.pipe(
        Effect.flatMap((service) => service.load()),
        Effect.provide(
          instructionLayer({
            config: "/global",
            filesystemLayer: observingFS,
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(
                location({ directory: AbsolutePath.make("/repo/") }, { projectDirectory: AbsolutePath.make("/repo") }),
              ),
            ),
          }),
        ),
      )

      expect(observed).toEqual({
        targets: ["AGENTS.md"],
        start: FSUtil.resolve("/repo"),
        stop: FSUtil.resolve("/repo"),
      })
    }),
  )

  it.effect("honors the project instruction opt-out", () =>
    Effect.gen(function* () {
      const previous = process.env.OPENCODE_DISABLE_PROJECT_CONFIG
      let scanned = false
      process.env.OPENCODE_DISABLE_PROJECT_CONFIG = "1"

      yield* SystemContextRegistry.Service.pipe(
        Effect.flatMap((service) => service.load()),
        Effect.provide(
          instructionLayer({
            config: "/global",
            filesystemLayer: Layer.effect(
              FSUtil.Service,
              FSUtil.Service.pipe(
                Effect.map((fs) => FSUtil.Service.of({ ...fs, up: () => Effect.sync(() => ((scanned = true), [])) })),
              ),
            ).pipe(Layer.provide(LayerNode.compile(FSUtil.node))),
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(location({ directory: AbsolutePath.make("/repo") })),
            ),
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env.OPENCODE_DISABLE_PROJECT_CONFIG
            else process.env.OPENCODE_DISABLE_PROJECT_CONFIG = previous
          }),
        ),
      )

      expect(scanned).toBe(false)
    }),
  )

  it.effect("does not discover project instructions outside the canonical project root", () =>
    Effect.gen(function* () {
      let scanned = false
      yield* SystemContextRegistry.Service.pipe(
        Effect.flatMap((service) => service.load()),
        Effect.provide(
          instructionLayer({
            config: "/global",
            filesystemLayer: Layer.effect(
              FSUtil.Service,
              FSUtil.Service.pipe(
                Effect.map((fs) => FSUtil.Service.of({ ...fs, up: () => Effect.sync(() => ((scanned = true), [])) })),
              ),
            ).pipe(Layer.provide(LayerNode.compile(FSUtil.node))),
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(
                location(
                  { directory: AbsolutePath.make("/outside") },
                  { projectDirectory: AbsolutePath.make("/repo") },
                ),
              ),
            ),
          }),
        ),
      )

      expect(scanned).toBe(false)
    }),
  )

  it.effect("caps oversized AGENTS.md and points the model at read", () =>
    Effect.gen(function* () {
      const file = AbsolutePath.make("/repo/AGENTS.md")
      const content = Array.from({ length: InstructionContext.MAX_FILE_LINES + 50 }, (_, index) => `line-${index}`).join(
        "\n",
      )
      const cappedFS = Layer.effect(
        FSUtil.Service,
        FSUtil.Service.pipe(
          Effect.map((fs) =>
            FSUtil.Service.of({
              ...fs,
              up: () => Effect.succeed([file]),
              glob: () => Effect.succeed([]),
              resolve: (path) => Effect.succeed(path),
              readFileStringSafe: (path) => Effect.succeed(path === file ? content : undefined),
            }),
          ),
        ),
      ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
      const context = yield* SystemContextRegistry.Service.pipe(
        Effect.flatMap((service) => service.load()),
        Effect.provide(
          instructionLayer({
            config: "/global",
            filesystemLayer: cappedFS,
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(location({ directory: AbsolutePath.make("/repo") })),
            ),
          }),
        ),
      )

      const baseline = (yield* SystemContext.initialize(context)).baseline
      expect(baseline).toContain(`Instructions from: ${file}`)
      expect(baseline).toContain("line-0")
      expect(baseline).toContain(`line-${InstructionContext.MAX_FILE_LINES - 1}`)
      expect(baseline).not.toContain(`line-${InstructionContext.MAX_FILE_LINES}`)
      expect(baseline).toContain("Use the read tool on this path to load the rest.")
    }),
  )

  it.effect("omits later instruction files once the aggregate budget is full", () =>
    Effect.gen(function* () {
      const first = AbsolutePath.make("/repo/AGENTS.md")
      const extra = AbsolutePath.make("/global/rules/extra.md")
      const chunk = "x".repeat(InstructionContext.MAX_FILE_BYTES)
      const overflowingFS = Layer.effect(
        FSUtil.Service,
        FSUtil.Service.pipe(
          Effect.map((fs) =>
            FSUtil.Service.of({
              ...fs,
              up: () => Effect.succeed([first]),
              glob: () => Effect.succeed([extra]),
              resolve: (path) => Effect.succeed(path),
              readFileStringSafe: (path) => Effect.succeed(path === first || path === extra ? chunk : undefined),
            }),
          ),
        ),
      ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
      const context = yield* SystemContextRegistry.Service.pipe(
        Effect.flatMap((service) => service.load()),
        Effect.provide(
          instructionLayer({
            config: "/global",
            filesystemLayer: overflowingFS,
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(location({ directory: AbsolutePath.make("/repo") })),
            ),
          }),
        ),
      )

      const baseline = (yield* SystemContext.initialize(context)).baseline
      expect(baseline).toContain(`Instructions from: ${first}`)
      expect(baseline).toContain(`Instructions from: ${extra}`)
      expect(baseline).toContain("Use the read tool on this path to load it.")
      expect(baseline.split(chunk).length - 1).toBe(1)
      expect(Buffer.byteLength(baseline, "utf-8")).toBeLessThanOrEqual(InstructionContext.MAX_TOTAL_BYTES)
    }),
  )
})
