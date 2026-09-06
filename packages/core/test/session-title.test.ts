import { describe, expect, test } from "bun:test"
import { SessionTitle } from "@opencode-ai/core/session/title"

describe("SessionTitle", () => {
  test("detects timestamped default titles", () => {
    expect(SessionTitle.isDefault("New session - 2026-09-06T19:39:00.000Z")).toBe(true)
    expect(SessionTitle.isDefault("Child session - 2026-09-06T19:39:00.000Z")).toBe(true)
    expect(SessionTitle.isDefault("Add archive icon")).toBe(false)
  })

  test("takes the first two or three words of the initial prompt", () => {
    expect(SessionTitle.fromPrompt("Add archive icon to the sidebar")).toBe("Add archive icon")
    expect(SessionTitle.fromPrompt("  Fix tests\nmore context")).toBe("Fix tests")
    expect(SessionTitle.fromPrompt("Hello")).toBe("Hello")
    expect(SessionTitle.fromPrompt("   ")).toBeUndefined()
  })
})
