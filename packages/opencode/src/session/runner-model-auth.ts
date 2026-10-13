import { Catalog } from "@opencode-ai/core/catalog"
import { Credential } from "@opencode-ai/core/credential"
import { Integration } from "@opencode-ai/core/integration"
import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { Effect, Layer } from "effect"
import { Auth } from "@/auth"

const layer = Layer.effect(
  SessionRunnerModel.Service,
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const integrations = yield* Integration.Service
    const auth = yield* Auth.Service
    return SessionRunnerModel.Service.of({
      resolve: Effect.fn("SessionRunnerModel.resolve")(function* (session) {
        const defaultModel = session.model ? undefined : yield* catalog.model.default()
        const selected = session.model
          ? yield* catalog.model.get(session.model.providerID, session.model.id)
          : defaultModel && SessionRunnerModel.supported(defaultModel)
            ? defaultModel
            : (yield* catalog.model.all()).find(SessionRunnerModel.supported)
        if (!selected && session.model)
          return yield* new SessionRunnerModel.ModelUnavailableError({
            providerID: session.model.providerID,
            modelID: session.model.id,
          })
        if (!selected) return yield* new SessionRunnerModel.ModelNotSelectedError({ sessionID: session.id })
        const provider = yield* catalog.provider.get(selected.providerID)
        const connection = yield* integrations.connection.active(
          provider?.integrationID ?? Integration.ID.make(selected.providerID),
        )
        const credential = connection
          ? yield* integrations.connection.resolve(connection)
          : yield* apiKeyFromAuth(auth, selected.providerID)
        const model = yield* SessionRunnerModel.resolve(session, selected, credential)
        return { model, info: selected }
      }),
    })
  }),
)

function apiKeyFromAuth(auth: Auth.Interface, providerID: string) {
  return auth.get(providerID).pipe(
    Effect.map((info) => (info?.type === "api" ? Credential.Key.make({ type: "key", key: info.key }) : undefined)),
    Effect.orElseSucceed(() => undefined),
  )
}

export const node = makeLocationNode({
  service: SessionRunnerModel.Service,
  layer,
  deps: [Catalog.node, Integration.node, Auth.node],
})

export * as SessionRunnerModelAuth from "./runner-model-auth"
