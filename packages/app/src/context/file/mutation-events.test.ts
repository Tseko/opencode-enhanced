import { describe, expect, test } from "bun:test"
import { createFileMutationTracker, eventSessionID } from "./mutation-events"

describe("createFileMutationTracker", () => {
  test("refreshes after a mutating V2 tool succeeds", () => {
    const tracker = createFileMutationTracker()
    expect(
      tracker.shouldRefresh(
        {
          name: "C:/proj",
          details: {
            type: "session.next.tool.called",
            properties: { sessionID: "ses_1", callID: "c1", tool: "apply_patch" },
          },
        },
        "ses_1",
      ),
    ).toBe(false)
    expect(
      tracker.shouldRefresh(
        {
          name: "C:/proj",
          details: {
            type: "session.next.tool.success",
            properties: { sessionID: "ses_1", callID: "c1" },
          },
        },
        "ses_1",
      ),
    ).toBe(true)
  })

  test("ignores read tools and other sessions", () => {
    const tracker = createFileMutationTracker()
    tracker.shouldRefresh({
      details: {
        type: "session.tool.called",
        properties: { sessionID: "ses_1", callID: "c1", name: "read" },
      },
    })
    expect(
      tracker.shouldRefresh({
        details: {
          type: "session.tool.success",
          properties: { sessionID: "ses_1", callID: "c1" },
        },
      }),
    ).toBe(false)
    tracker.shouldRefresh(
      {
        details: {
          type: "session.next.tool.called",
          current: { type: "session.next.tool.called", data: { sessionID: "ses_other", callID: "c2", tool: "edit" } },
        },
      },
      "ses_1",
    )
    expect(
      tracker.shouldRefresh(
        {
          details: {
            type: "session.next.tool.success",
            current: { type: "session.next.tool.success", data: { sessionID: "ses_other", callID: "c2" } },
          },
        },
        "ses_1",
      ),
    ).toBe(false)
  })

  test("refreshes from file mutation output when the called event was missed", () => {
    const tracker = createFileMutationTracker()
    expect(
      tracker.shouldRefresh({
        details: {
          type: "session.next.tool.success",
          properties: {
            sessionID: "ses_1",
            callID: "c1",
            structured: { files: [{ file: "cursor-live-buffer-test.md" }] },
          },
        },
      }),
    ).toBe(true)
  })

  test("refreshes watcher and edited events except git internals", () => {
    const tracker = createFileMutationTracker()
    expect(
      tracker.shouldRefresh({
        details: { type: "file.watcher.updated", properties: { file: "cursor-live-buffer-test.md" } },
      }),
    ).toBe(true)
    expect(
      tracker.shouldRefresh({
        details: { type: "file.edited", properties: { file: "C:/proj/cursor-live-buffer-test.md" } },
      }),
    ).toBe(true)
    expect(
      tracker.shouldRefresh({
        details: { type: "file.watcher.updated", properties: { file: ".git/index" } },
      }),
    ).toBe(false)
  })
})

describe("eventSessionID", () => {
  test("reads V2 current data from the server bus envelope", () => {
    expect(
      eventSessionID({
        name: "C:/proj",
        details: {
          type: "session.next.tool.input.delta",
          current: { type: "session.next.tool.input.delta", data: { sessionID: "ses_1", delta: "@@" } },
        },
      }),
    ).toBe("ses_1")
  })
})
