import { describe, expect } from "bun:test"
import { Effect, Schema, Stream } from "effect"
import { LLM } from "../src"
import { Route, Endpoint, LLMClient, Protocol, type FramingDef } from "../src/route"
import { Model } from "../src/schema"
import { testEffect } from "./lib/effect"
import { fixedResponse } from "./lib/http"

type FakeBody = {
  readonly body: string
}

const FakeEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("finish"), reason: Schema.Literal("stop") }),
])
type FakeEvent = Schema.Schema.Type<typeof FakeEvent>

const raiseEvent = (event: FakeEvent): import("../src/schema").LLMEvent =>
  event.type === "finish"
    ? { type: "finish", reason: event.reason }
    : { type: "text-delta", id: "text-0", text: event.text }

const fakeProtocol = Protocol.make<FakeBody, FakeEvent, FakeEvent, void>({
  id: "fake",
  body: {
    schema: Schema.Struct({ body: Schema.String }),
    from: () => Effect.succeed({ body: "" }),
  },
  stream: {
    event: FakeEvent,
    initial: () => undefined,
    step: (state, event) => Effect.succeed([state, [raiseEvent(event)]] as const),
  },
})

/** Emits the supplied frames and then ends the stream normally, like a socket close. */
const framesFraming = (frames: ReadonlyArray<FakeEvent>): FramingDef<FakeEvent> => ({
  id: "frames",
  frame: () => Stream.fromIterable(frames),
})

/** Emits one frame and then never produces another one. */
const stalledFraming: FramingDef<FakeEvent> = {
  id: "stalled",
  frame: () =>
    Stream.concat(Stream.make({ type: "text", text: "hi" } satisfies FakeEvent), Stream.never),
}

/** Produces its first frame only after the supplied delay. */
const slowStartFraming = (delayMs: number): FramingDef<FakeEvent> => ({
  id: "slow-start",
  frame: () =>
    Stream.concat(
      Stream.fromEffect(Effect.sleep(delayMs)).pipe(Stream.drain),
      Stream.make({ type: "text", text: "hi" } satisfies FakeEvent),
    ),
})

const routeFor = (framing: FramingDef<FakeEvent>, timeouts?: { idleMs?: number; totalMs?: number }) =>
  Route.make({
    id: "fake",
    protocol: fakeProtocol,
    endpoint: Endpoint.path("/chat"),
    framing,
  })
    .with({ endpoint: { baseURL: "https://fake.local" } })
    .with(timeouts === undefined ? {} : { timeouts })

const requestFor = (route: ReturnType<typeof routeFor>) =>
  LLM.request({
    id: "req_1",
    model: Model.make({ id: "fake-model", provider: "fake-provider", route }),
    prompt: "hello",
  })

const it = testEffect(fixedResponse(""))

describe("provider stream contract", () => {
  it.live("accepts a stream that ends with a terminal finish", () =>
    Effect.gen(function* () {
      const llm = yield* LLMClient.Service
      const events = Array.from(
        yield* llm
          .stream(requestFor(routeFor(framesFraming([{ type: "text", text: "hi" }, { type: "finish", reason: "stop" }]))))
          .pipe(Stream.runCollect),
      )
      expect(events.map((event) => event.type)).toEqual(["text-delta", "finish"])
    }),
  )

  it.live("fails a stream that closes without a terminal finish", () =>
    Effect.gen(function* () {
      const llm = yield* LLMClient.Service
      const error = yield* llm
        .stream(requestFor(routeFor(framesFraming([{ type: "text", text: "hi" }]))))
        .pipe(Stream.runDrain, Effect.flip)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain("without a terminal finish event")
    }),
  )

  it.live("fails a stream that stalls between semantic events", () =>
    Effect.gen(function* () {
      const llm = yield* LLMClient.Service
      const error = yield* llm
        .stream(requestFor(routeFor(stalledFraming, { idleMs: 20 })))
        .pipe(Stream.runDrain, Effect.flip)
      expect((error as Error).message).toContain("idle")
    }),
  )

  it.live("fails a stream that exceeds its total deadline", () =>
    Effect.gen(function* () {
      const llm = yield* LLMClient.Service
      const error = yield* llm
        .stream(requestFor(routeFor(slowStartFraming(30), { totalMs: 10 })))
        .pipe(Stream.runDrain, Effect.flip)
      expect((error as Error).message).toContain("total deadline")
    }),
  )
})
