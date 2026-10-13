import { Cause, Effect, Layer } from "effect"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"
import { EventV2 } from "../../event"
import { Location } from "../../location"
import { LocationServiceMap } from "../../location-service-map"
import { makeGlobalNode } from "../../effect/app-node"
import { PermissionV2 } from "../../permission"
import { QuestionV2 } from "../../question"
import { Readiness } from "../../readiness"
import { SessionRunCoordinator } from "../run-coordinator"
import { SessionRunner } from "../runner"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { SessionExecution } from "../execution"

/** Current-process routing for implicit-local Locations. Future remote placement belongs here. */
const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const events = yield* EventV2.Service
    const dismissPrompts = (sessionID: SessionSchema.ID, location: Location.Ref) =>
      Effect.gen(function* () {
        const permission = yield* PermissionV2.Service
        const question = yield* QuestionV2.Service
        yield* permission.interrupt(sessionID)
        yield* question.interrupt(sessionID)
      }).pipe(Effect.provide(locations.get(location)))
    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, SessionRunner.RunError>({
      drain: Effect.fnUntraced(function* (sessionID: SessionSchema.ID, force) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
        const publishStatus = (status: SessionStatusEvent.Info) =>
          events.publish(SessionStatusEvent.Status, { sessionID, status }, { location: session.location })
        yield* publishStatus({ type: "busy" })
        return yield* Effect.gen(function* () {
          // The readiness gate: the drain never runs against a half-built Location graph,
          // so Location-scoped registries are complete before the first provider turn.
          yield* Readiness.assertReady(session.location)
          return yield* SessionRunner.Service.use((runner) => runner.run({ sessionID, force }))
        }).pipe(
          Effect.provide(locations.get(session.location)),
          Effect.onInterrupt(() => dismissPrompts(sessionID, session.location)),
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError("Failed to drain Session", cause).pipe(Effect.annotateLogs({ sessionID })),
          ),
          Effect.ensuring(publishStatus({ type: "idle" })),
        )
      }),
    })

    return SessionExecution.Service.of({
      active: coordinator.active,
      interrupt: Effect.fn("SessionExecution.interrupt")(function* (sessionID) {
        const session = yield* store.get(sessionID)
        if (session) yield* dismissPrompts(sessionID, session.location)
        yield* coordinator.interrupt(sessionID)
      }),
      resume: coordinator.run,
      wake: coordinator.wake,
    })
  }),
)

export const node = makeGlobalNode({
  service: SessionExecution.Service,
  layer,
  deps: [SessionStore.node, LocationServiceMap.node, EventV2.node],
})

export * as SessionExecutionLocal from "./local"
