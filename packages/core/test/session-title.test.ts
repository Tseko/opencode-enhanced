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

describe("SessionTitle.clean", () => {
  test("trims and keeps a single-line title", () => {
    expect(SessionTitle.clean("  Debug 500 errors in production  ")).toBe("Debug 500 errors in production")
  })

  test("uses the first non-empty line and drops the rest", () => {
    expect(SessionTitle.clean("\n\nTitle here\nExtra explanation the model added")).toBe("Title here")
  })

  test("strips think blocks", () => {
    expect(SessionTitle.clean("<think>short title candidate</think>Fix the login flow")).toBe("Fix the login flow")
    expect(SessionTitle.clean("Fix the login flow<think>trailing thoughts</think>")).toBe("Fix the login flow")
  })

  test("returns undefined for empty or whitespace output", () => {
    expect(SessionTitle.clean("")).toBeUndefined()
    expect(SessionTitle.clean("   \n\n\t")).toBeUndefined()
    expect(SessionTitle.clean("<think>nothing but thinking</think>\n\n")).toBeUndefined()
  })

  test("clamps long titles to 100 characters", () => {
    const long = "x".repeat(120)
    expect(SessionTitle.clean(long)).toBe(`${"x".repeat(97)}...`)
    expect(SessionTitle.clean(long)).toHaveLength(100)
  })
})

describe("SessionTitle placeholder matching", () => {
  test("default titles never match placeholder-derived titles", () => {
    const created = new Date(0).toISOString()
    expect(SessionTitle.isDefault(`New session - ${created} extra`)).toBe(false)
    expect(SessionTitle.isDefault(SessionTitle.fromPrompt("Refactor the login") ?? "")).toBe(false)
  })
})
