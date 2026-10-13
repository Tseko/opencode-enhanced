import { expect, test } from "bun:test"
import { RelativePath } from "@opencode-ai/core/schema"
import { GlobTool } from "@opencode-ai/core/tool/glob"
import { GrepTool } from "@opencode-ai/core/tool/grep"

test("glob defaults collection to 100 and marks lists that reach the result limit", () => {
  expect(GlobTool.DEFAULT_LIMIT).toBe(100)
  expect(
    GlobTool.toModelOutput(
      [
        { path: RelativePath.make("a.ts"), type: "file" },
        { path: RelativePath.make("b.ts"), type: "file" },
      ],
      true,
    ),
  ).toContain("(Result limit reached: showing 2 results.")
})

test("grep defaults collection to 100 and marks lists that reach the result limit", () => {
  expect(GrepTool.DEFAULT_LIMIT).toBe(100)
  expect(
    GrepTool.toModelOutput(
      [
        {
          entry: { path: RelativePath.make("a.ts"), type: "file" },
          line: 1,
          offset: 0,
          text: "needle",
          submatches: [],
        },
      ],
      true,
    ),
  ).toContain("Found 1 match (result limit reached; more matches may be available)")
})
