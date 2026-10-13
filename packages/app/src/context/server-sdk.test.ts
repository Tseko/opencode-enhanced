import { describe, expect, test } from "bun:test"
import { adaptServerEvent, coalesceServerEvents, enqueueServerEvent, resumeStreamAfterPageShow } from "./server-sdk"
import type { OpenCodeEvent } from "@opencode-ai/client/promise"
import type { Event } from "@opencode-ai/sdk/v2/client"

describe("resumeStreamAfterPageShow", () => {
  test("restarts a stream only after a back-forward cache restore", () => {
    let starts = 0
    const start = () => starts++

    resumeStreamAfterPageShow({ persisted: false } as PageTransitionEvent, start)
    resumeStreamAfterPageShow({ persisted: true } as PageTransitionEvent, start)

    expect(starts).toBe(1)
  })
})

describe("adaptServerEvent", () => {
  test("preserves V2 events while adapting permission requests for existing consumers", () => {
    const current = {
      id: "evt_1",
      created: 1,
      type: "permission.v2.asked",
      data: { id: "perm_1", sessionID: "ses_1", action: "read", resources: ["src/**"] },
    } as OpenCodeEvent

    expect(adaptServerEvent(current)).toMatchObject({
      type: "permission.asked",
      properties: { id: "perm_1", sessionID: "ses_1", permission: "read", patterns: ["src/**"] },
      current,
    })
  })
})

describe("coalesceServerEvents", () => {
  const delta = (value: string, field = "text", partID = "part") => ({
    directory: "/repo",
    payload: {
      type: "message.part.delta",
      properties: { messageID: "msg", partID, field, delta: value },
    } as Event,
  })

  test("merges adjacent deltas for the same field", () => {
    const first = delta("hello ")
    const second = delta("world")
    first.payload.id = "first"
    second.payload.id = "second"
    const result = coalesceServerEvents([first, second])

    expect(result).toHaveLength(1)
    expect(result[0]?.payload).toMatchObject({ id: "second", properties: { delta: "hello world" } })
  })

  test("merges adjacent current text deltas", () => {
    const current = (id: string, value: string) =>
      adaptServerEvent({
        id,
        created: 1,
        type: "session.text.delta",
        location: { directory: "/repo" },
        data: { sessionID: "ses", assistantMessageID: "msg", ordinal: 0, delta: value },
      } as OpenCodeEvent)
    const result = coalesceServerEvents([
      { directory: "/repo", payload: current("evt_1", "hello ") },
      { directory: "/repo", payload: current("evt_2", "world") },
    ])

    expect(result).toHaveLength(1)
    expect(result[0]?.payload.current).toMatchObject({ id: "evt_2", data: { delta: "hello world" } })
  })

  test("merges adjacent session.next text deltas and versioned suffixes", () => {
    const current = (id: string, value: string, type: string) =>
      adaptServerEvent({
        id,
        created: 1,
        type,
        location: { directory: "/repo" },
        data: { sessionID: "ses", assistantMessageID: "msg", textID: "txt_1", delta: value },
      } as OpenCodeEvent)
    const result = coalesceServerEvents([
      { directory: "/repo", payload: current("evt_1", "hello ", "session.next.text.delta") },
      { directory: "/repo", payload: current("evt_2", "wor", "session.next.text.delta.1") },
      { directory: "/repo", payload: current("evt_3", "ld", "session.next.text.delta.2") },
    ])

    expect(result).toHaveLength(1)
    expect(result[0]?.payload.current).toMatchObject({ id: "evt_3", data: { delta: "hello world" } })
  })

  test("keeps distinct next delta streams and non-delta barriers", () => {
    const text = (id: string, value: string, textID: string) =>
      adaptServerEvent({
        id,
        created: 1,
        type: "session.next.text.delta",
        location: { directory: "/repo" },
        data: { sessionID: "ses", assistantMessageID: "msg", textID, delta: value },
      } as unknown as OpenCodeEvent)
    const reasoning = (id: string, value: string) =>
      adaptServerEvent({
        id,
        created: 1,
        type: "session.next.reasoning.delta",
        location: { directory: "/repo" },
        data: { sessionID: "ses", assistantMessageID: "msg", reasoningID: "rsn_1", delta: value },
      } as unknown as OpenCodeEvent)
    const status = {
      directory: "/repo",
      payload: { type: "session.status", properties: { sessionID: "ses", status: { type: "idle" } } } as Event,
    }
    const result = coalesceServerEvents([
      { directory: "/repo", payload: text("evt_1", "a", "txt_1") },
      { directory: "/repo", payload: text("evt_2", "b", "txt_1") },
      { directory: "/repo", payload: reasoning("evt_3", "think") },
      { directory: "/repo", payload: reasoning("evt_4", "ing") },
      status,
      { directory: "/repo", payload: text("evt_5", "c", "txt_2") },
    ])

    expect(result.map((event) => event.payload.current?.id ?? event.payload.type)).toEqual([
      "evt_2",
      "evt_4",
      "session.status",
      "evt_5",
    ])
    expect(result[0]?.payload.current).toMatchObject({ data: { delta: "ab" } })
    expect(result[1]?.payload.current).toMatchObject({ data: { delta: "thinking" } })
  })

  test("merges adjacent session.next tool input deltas", () => {
    const current = (id: string, value: string) =>
      adaptServerEvent({
        id,
        created: 1,
        type: "session.next.tool.input.delta",
        location: { directory: "/repo" },
        data: { sessionID: "ses", assistantMessageID: "msg", callID: "call_1", delta: value },
      } as unknown as OpenCodeEvent)
    const result = coalesceServerEvents([
      { directory: "/repo", payload: current("evt_1", '{"q"') },
      { directory: "/repo", payload: current("evt_2", ':1}') },
    ])

    expect(result).toHaveLength(1)
    expect(result[0]?.payload.current).toMatchObject({ id: "evt_2", data: { delta: '{"q":1}' } })
  })

  test("merges adjacent session.next compaction deltas", () => {
    const current = (id: string, value: string) =>
      adaptServerEvent({
        id,
        created: 1,
        type: "session.next.compaction.delta",
        location: { directory: "/repo" },
        data: { sessionID: "ses", messageID: "msg", text: value },
      } as unknown as OpenCodeEvent)
    const result = coalesceServerEvents([
      { directory: "/repo", payload: current("evt_1", "hello ") },
      { directory: "/repo", payload: current("evt_2", "world") },
    ])

    expect(result).toHaveLength(1)
    expect(result[0]?.payload.current).toMatchObject({ id: "evt_2", data: { text: "hello world" } })
  })

  test("preserves event boundaries and distinct fields", () => {
    const status = {
      directory: "/repo",
      payload: { type: "session.status", properties: { sessionID: "ses", status: { type: "idle" } } } as Event,
    }
    const result = coalesceServerEvents([delta("a"), delta("b", "metadata"), status, delta("c")])

    expect(result.map((event) => event.payload.type)).toEqual([
      "message.part.delta",
      "message.part.delta",
      "session.status",
      "message.part.delta",
    ])
  })

  test("preserves event ID order across interleaved deltas", () => {
    const first = delta("a")
    const other = delta("b", "text", "other")
    const last = delta("c")
    first.payload.id = "1"
    other.payload.id = "2"
    last.payload.id = "3"

    const result = coalesceServerEvents([first, other, last])

    expect(result.map((event) => event.payload.id)).toEqual(["1", "2", "3"])
  })
})

describe("enqueueServerEvent", () => {
  const partUpdated = (text: string) =>
    ({
      type: "message.part.updated",
      properties: {
        sessionID: "session",
        part: { id: "part", sessionID: "session", messageID: "message", type: "text", text },
      },
    }) as Event

  test("preserves part updates across message remove and re-add barriers", () => {
    const events: Array<{ directory: string; payload: Event }> = []
    const enqueue = (payload: Event) => enqueueServerEvent(events, { directory: "/repo", payload })

    enqueue(partUpdated("old"))
    enqueue({ type: "message.removed", properties: { sessionID: "session", messageID: "message" } } as Event)
    enqueue({
      type: "message.updated",
      properties: {
        sessionID: "session",
        info: {
          id: "message",
          sessionID: "session",
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: { providerID: "provider", modelID: "model" },
        },
      },
    } as Event)
    enqueue(partUpdated("new"))

    expect(events.map((event) => event.payload.type)).toEqual([
      "message.part.updated",
      "message.removed",
      "message.updated",
      "message.part.updated",
    ])
  })

  test("preserves deltas after a replacement snapshot", () => {
    const events: Array<{ directory: string; payload: Event }> = []
    const enqueue = (payload: Event) => enqueueServerEvent(events, { directory: "/repo", payload })

    enqueue(partUpdated("a"))
    enqueue(partUpdated("ab"))
    enqueue({
      type: "message.part.delta",
      properties: { sessionID: "session", messageID: "message", partID: "part", field: "text", delta: "c" },
    } as Event)

    const result = coalesceServerEvents(events)
    expect(result.map((event) => event.payload.type)).toEqual(["message.part.updated", "message.part.delta"])
    expect(result[0]?.payload).toMatchObject({ properties: { part: { text: "ab" } } })
    expect(result[1]?.payload).toMatchObject({ properties: { delta: "c" } })
  })

  test("preserves updates after session deletion", () => {
    const events: Array<{ directory: string; payload: Event }> = []
    const enqueue = (payload: Event) => enqueueServerEvent(events, { directory: "/repo", payload })

    enqueue(partUpdated("old"))
    enqueue({
      type: "session.deleted",
      properties: { sessionID: "session", info: { id: "session" } },
    } as Event)
    enqueue(partUpdated("new"))

    expect(events.map((event) => event.payload.type)).toEqual([
      "message.part.updated",
      "session.deleted",
      "message.part.updated",
    ])
  })

  test("does not coalesce edge-triggered session statuses", () => {
    const events: Array<{ directory: string; payload: Event }> = []
    const enqueue = (status: "retry" | "busy") =>
      enqueueServerEvent(events, {
        directory: "/repo",
        payload: {
          type: "session.status",
          properties: {
            sessionID: "session",
            status: status === "retry" ? { type: "retry", attempt: 1, message: "retry", next: 1 } : { type: "busy" },
          },
        } as Event,
      })

    enqueue("retry")
    enqueue("busy")

    expect(events).toHaveLength(2)
  })
})
