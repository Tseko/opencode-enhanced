import { describe, expect, test } from "bun:test"
import {
  applyBufferTransactions,
  createPatchStream,
  matchesFilePath,
  patchFiles,
  pushPatchDelta,
  streamDelta,
} from "./apply-patch-file"
import { text } from "./session-diff"

describe("apply patch file", () => {
  test("parses patch metadata from the server", () => {
    const file = patchFiles([
      {
        filePath: "/tmp/a.ts",
        relativePath: "a.ts",
        type: "update",
        patch:
          "Index: a.ts\n===================================================================\n--- a.ts\t\n+++ a.ts\t\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n",
        additions: 1,
        deletions: 1,
      },
    ])[0]

    expect(file).toBeDefined()
    expect(file?.view.fileDiff.name).toBe("a.ts")
    expect(file?.view.fileDiff.isPartial).toBe(false)
    expect(text(file!.view, "deletions")).toBe("one\ntwo\n")
    expect(text(file!.view, "additions")).toBe("one\nthree\n")
  })

  test("keeps legacy before and after payloads working", () => {
    const file = patchFiles([
      {
        filePath: "/tmp/a.ts",
        relativePath: "a.ts",
        type: "update",
        before: "one\n",
        after: "two\n",
        additions: 1,
        deletions: 1,
      },
    ])[0]

    expect(file).toBeDefined()
    expect(text(file!.view, "deletions")).toBe("one\n")
    expect(text(file!.view, "additions")).toBe("two\n")
  })

  test("turns streamed apply_patch hunks into buffer transactions", () => {
    const first = pushPatchDelta(
      createPatchStream(),
      '{"patchText":"*** Begin Patch\\n*** Update File: a.ts\\n@@\\n-two\\n',
    )
    expect(first.transactions).toEqual([])

    const next = pushPatchDelta(first, '+TWO\\n*** End Patch"}')
    expect(next.transactions).toEqual([
      {
        type: "update",
        path: "a.ts",
        chunks: [{ oldLines: ["two"], newLines: ["TWO"], changeContext: undefined, endOfFile: undefined }],
      },
    ])
    expect(applyBufferTransactions("one\ntwo\nthree\n", next.transactions)).toBe("one\nTWO\nthree\n")
  })

  test("applies complete unified hunks as splice transactions", () => {
    const state = pushPatchDelta(
      createPatchStream(),
      "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n",
    )
    expect(state.transactions).toEqual([
      {
        type: "splice",
        path: "src/a.ts",
        fromLine: 0,
        remove: 2,
        insert: ["one", "three"],
      },
    ])
    expect(applyBufferTransactions("one\ntwo\nfour\n", state.transactions)).toBe("one\nthree\nfour\n")
  })

  test("reads V2 tool input deltas from the event envelope", () => {
    expect(
      streamDelta({
        type: "session.tool.input.delta",
        properties: { delta: "@@" },
        current: { type: "session.tool.input.delta", data: { delta: "@@" } },
      }),
    ).toBe("@@")
    expect(
      streamDelta({
        type: "session.next.tool.input.delta",
        properties: { delta: "*** Begin Patch" },
        current: { type: "session.next.tool.input.delta", data: { delta: "*** Begin Patch" } },
      }),
    ).toBe("*** Begin Patch")
    expect(matchesFilePath("src/a.ts", "/tmp/project/src/a.ts")).toBe(true)
  })

  test("parses V2 FileDiff.Info apply_patch output", () => {
    const file = patchFiles([
      {
        file: "src/a.ts",
        patch:
          "Index: src/a.ts\n===================================================================\n--- src/a.ts\t\n+++ src/a.ts\t\n@@ -1,1 +1,1 @@\n-one\n+two\n",
        additions: 1,
        deletions: 1,
        status: "modified",
      },
    ])[0]

    expect(file?.filePath).toBe("src/a.ts")
    expect(file?.type).toBe("update")
    expect(text(file!.view, "additions")).toBe("two\n")
  })
})
