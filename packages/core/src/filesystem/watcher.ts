export * as Watcher from "./watcher"

// @ts-ignore
import { createWrapper } from "@parcel/watcher/wrapper"
import type ParcelWatcher from "@parcel/watcher"
import { makeLocationNode } from "../effect/app-node"
import { Cause, Context, Effect, Layer } from "effect"
import { FileSystemWatcher } from "@opencode-ai/schema/filesystem-watcher"
import path from "path"
import { Config } from "../config"
import { EventV2 } from "../event"
import { Flag } from "../flag/flag"
import { FSUtil } from "../fs-util"
import { Git } from "../git"
import { Location } from "../location"
import { lazy } from "../util/lazy"
import { FileSystemSearch } from "./search"
import { Ignore } from "./ignore"
import { Protected } from "./protected"

declare const OPENCODE_LIBC: string | undefined

const SUBSCRIBE_TIMEOUT_MS = 10_000

export const Event = FileSystemWatcher.Event

const watcher = lazy((): typeof import("@parcel/watcher") | undefined => {
  try {
    const libc = typeof OPENCODE_LIBC === "undefined" ? undefined : OPENCODE_LIBC
    const binding = require(
      `@parcel/watcher-${process.platform}-${process.arch}${process.platform === "linux" ? `-${libc || "glibc"}` : ""}`,
    )
    return createWrapper(binding) as typeof import("@parcel/watcher")
  } catch {
    return
  }
})

function getBackend() {
  if (process.platform === "win32") return "windows"
  if (process.platform === "darwin") return "fs-events"
  if (process.platform === "linux") return "inotify"
}

function protecteds(dir: string) {
  return Protected.paths().filter((item) => {
    const relative = path.relative(dir, item)
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  })
}

export const hasNativeBinding = () => !!watcher()

export interface Interface {}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/FileWatcher") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    if (yield* Flag.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER) return Service.of({})

    const backend = getBackend()
    const location = yield* Location.Service
    if (!backend) {
      yield* Effect.logError("watcher backend not supported", {
        directory: location.directory,
        platform: process.platform,
      })
      return Service.of({})
    }

    const w = watcher()
    if (!w) return Service.of({})

    yield* Effect.logInfo("watcher backend", { directory: location.directory, platform: process.platform, backend })
    const events = yield* EventV2.Service
    const search = yield* FileSystemSearch.Service
    const fs = yield* FSUtil.Service
    const git = yield* Git.Service
    const context = yield* Effect.context()
    const runFork = Effect.runForkWith(context)
    const subscriptions: ParcelWatcher.AsyncSubscription[] = []
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => Promise.allSettled(subscriptions.map((subscription) => subscription.unsubscribe()))),
    )

    const queued = new Map<string, "add" | "change" | "unlink">()
    let timer: ReturnType<typeof setTimeout> | undefined
    const flush = () => {
      timer = undefined
      const batch = [...queued]
      queued.clear()
      for (const [file, event] of batch) {
        const normalized = file.replaceAll("\\", "/")
        if (normalized.includes("/.git/") || normalized.endsWith("/.git")) continue
        runFork(
          search.reindex({ file, event }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to reindex watched file", { file, event, cause: Cause.pretty(cause) }),
            ),
          ),
        )
      }
    }
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (timer) clearTimeout(timer)
        if (queued.size > 0) flush()
      }),
    )

    const publish = (file: string, event: "add" | "change" | "unlink") => {
      runFork(events.publish(Event.Updated, { file, event }))
      const previous = queued.get(file)
      if (event === "unlink" || !previous) queued.set(file, event)
      else if (previous === "unlink") queued.set(file, event)
      if (timer) return
      timer = setTimeout(flush, 50)
    }

    const callback: ParcelWatcher.SubscribeCallback = (_error, updates) => {
      for (const update of updates) {
        if (update.type === "create") publish(update.path, "add")
        if (update.type === "update") publish(update.path, "change")
        if (update.type === "delete") publish(update.path, "unlink")
      }
    }

    const subscribe = (directory: string, ignore: string[]) => {
      const pending = w.subscribe(directory, callback, { ignore, backend })
      return Effect.promise(() => pending).pipe(
        Effect.tap((subscription) => Effect.sync(() => subscriptions.push(subscription))),
        Effect.timeout(SUBSCRIBE_TIMEOUT_MS),
        Effect.catchCause((cause) => {
          pending.then((subscription) => subscription.unsubscribe()).catch(() => {})
          return Effect.logError("failed to subscribe", { directory, cause: Cause.pretty(cause) })
        }),
      )
    }

    const config = (yield* (yield* Config.Service).entries())
      .filter((entry): entry is Config.Document => entry.type === "document")
      .flatMap((item) => item.info.watcher?.ignore ?? [])
    const nested = Ignore.PATTERNS.flatMap((pattern) => {
      if (pattern.includes("*") || pattern.includes("/")) return []
      return [`**/${pattern}/**`, `**/${pattern}`]
    })
    if (location.vcs && (yield* Flag.OPENCODE_EXPERIMENTAL_FILEWATCHER)) {
      yield* Effect.forkScoped(
        subscribe(location.directory, [
          ...Ignore.PATTERNS,
          ...nested,
          ".bun-cache",
          "**/.bun-cache/**",
          ...config,
          ...protecteds(location.directory),
        ]),
      )
    }

    if (location.vcs?.type === "git") {
      const resolved = (yield* git.repo.discover(location.directory))?.gitDirectory
      const vcs = resolved ? yield* fs.realPath(resolved).pipe(Effect.catch(() => Effect.succeed(resolved))) : undefined
      if (vcs && !config.includes(".git") && !config.includes(vcs) && (!resolved || !config.includes(resolved))) {
        const ignore = (yield* fs.readDirectoryEntries(vcs).pipe(Effect.catch(() => Effect.succeed([])))).flatMap(
          (entry) => (entry.name === "HEAD" ? [] : [entry.name]),
        )
        yield* Effect.forkScoped(subscribe(vcs, ignore))
      }
    }

    return Service.of({})
  }).pipe(
    Effect.catchCause((cause) => {
      return Effect.logError("failed to init watcher service", { cause: Cause.pretty(cause) }).pipe(
        Effect.as(Service.of({})),
      )
    }),
  ),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Location.node, Config.node, Git.node, EventV2.node, FileSystemSearch.node],
})
