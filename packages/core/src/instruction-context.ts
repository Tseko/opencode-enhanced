export * as InstructionContext from "./instruction-context"

import { Array, Effect, Layer, Option, Schema } from "effect"
import { isAbsolute, join, relative, sep } from "path"
import { FSUtil } from "./fs-util"
import { Flag } from "./flag/flag"
import { Global } from "./global"
import { InstructionRule } from "./instruction-rule"
import { Location } from "./location"
import { AbsolutePath } from "./schema"
import { SystemContext } from "./system-context/index"
import { SystemContextRegistry } from "./system-context/registry"
import { makeLocationNode } from "./effect/app-node"

class File extends Schema.Class<File>("InstructionContext.File")({
  path: AbsolutePath,
  content: Schema.String,
}) {}

const Files = Schema.Array(File)
const key = SystemContext.Key.make("core/instructions")

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const registry = yield* SystemContextRegistry.Service

    const source = (value: ReadonlyArray<File> | SystemContext.Unavailable) =>
      SystemContext.make({
        key,
        codec: Schema.toCodecJson(Files),
        load: Effect.succeed(value),
        baseline: render,
        update: (_previous, current) =>
          `These instructions replace all previously loaded ambient instructions.\n\n${render(current)}`,
        removed: () => "Previously loaded instructions no longer apply.",
      })

    const observe = Effect.fn("InstructionContext.observe")(function* () {
      const start = yield* fs.resolve(location.directory)
      const stop = yield* fs.resolve(location.project.directory)
      const fromProject = relative(stop, start)
      const insideProject =
        fromProject === "" || (fromProject !== ".." && !fromProject.startsWith(`..${sep}`) && !isAbsolute(fromProject))
      const discovered = new Set(
        yield* Effect.forEach(
          Flag.OPENCODE_DISABLE_PROJECT_CONFIG || !insideProject
            ? []
            : yield* fs.up({
                targets: ["AGENTS.md"],
                start,
                stop,
              }),
          fs.resolve,
        ),
      )
      const rules = yield* fs
        .glob("*.{md,mdc}", {
          cwd: join(global.config, "rules"),
          absolute: true,
          include: "file",
        })
        .pipe(
          Effect.catch(() => Effect.succeed([] as string[])),
          Effect.flatMap((items) => Effect.forEach(items, fs.resolve)),
        )
      // Global AGENTS.md, then project files, then selected ~/.config/opencode/rules.
      // alwaysApply (or untagged) rules always attach; globs/match attach from
      // location paths plus optional session prompt/file signals.
      const paths = Array.dedupe([
        yield* fs.resolve(join(global.config, "AGENTS.md")),
        ...discovered,
        ...rules.toSorted(),
      ])
      const extra = Option.getOrUndefined(yield* Effect.serviceOption(InstructionRule.SignalsService))
      const signals = InstructionRule.merge(
        InstructionRule.fromPaths([location.directory, location.project.directory]),
        extra,
      )
      const files = yield* Effect.forEach(
        paths,
        (path) =>
          fs
            .readFileStringSafe(path)
            .pipe(
              Effect.map((content) =>
                content === undefined ? undefined : new File({ path: AbsolutePath.make(path), content }),
              ),
            ),
        { concurrency: "unbounded" },
      )
      if (files.some((file, index) => file === undefined && discovered.has(paths[index])))
        return SystemContext.unavailable
      const ruleSet = new Set(rules)
      return files.flatMap((file, index) => {
        if (!file) return []
        if (!ruleSet.has(paths[index])) return [file]
        const parsed = InstructionRule.parse(file.content)
        if (!InstructionRule.applies(parsed.spec, signals)) return []
        return [new File({ path: file.path, content: parsed.body })]
      })
    })

    yield* registry.register({
      key,
      load: observe().pipe(
        Effect.map((files) =>
          files === SystemContext.unavailable
            ? source(files)
            : files.length === 0
              ? SystemContext.empty
              : source(files),
        ),
        Effect.catch(() => Effect.succeed(source(SystemContext.unavailable))),
        Effect.catchDefect(() => Effect.succeed(source(SystemContext.unavailable))),
      ),
    })
  }),
)

export const node = makeLocationNode({
  name: "instruction-context",
  layer,
  deps: [FSUtil.node, Global.node, Location.node, SystemContextRegistry.node],
})

function render(files: ReadonlyArray<File>) {
  return files.map((file) => `Instructions from: ${file.path}\n${file.content}`).join("\n\n")
}
