import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"
import { groupParts, toolActionCountItems } from "./message-part"
import { readPartText } from "./message-part-text"

const tool = (id: string, name: string) =>
  ({
    id,
    sessionID: "session",
    messageID: "message",
    type: "tool",
    callID: id,
    tool: name,
    state: {
      status: "completed",
      input: {},
      output: "",
      title: "",
      metadata: {},
      time: { start: 0, end: 0 },
    },
  }) satisfies Part

const text = (id: string) =>
  ({ id, sessionID: "session", messageID: "message", type: "text", text: id }) satisfies Part

const refs = (parts: Part[]) => parts.map((part) => ({ messageID: "message", part }))

describe("groupParts", () => {
  test("keeps context gathering compact even for one lookup", () => {
    expect(groupParts(refs([tool("read-1", "read")]))).toEqual([
      {
        key: "tool:context:read-1",
        type: "tool",
        kind: "context",
        refs: [{ messageID: "message", partID: "read-1" }],
      },
    ])
  })

  test("groups adjacent commands", () => {
    expect(groupParts(refs([tool("bash-1", "bash"), tool("bash-2", "shell")]))).toEqual([
      {
        key: "tool:command:bash-1",
        type: "tool",
        kind: "command",
        refs: [
          { messageID: "message", partID: "bash-1" },
          { messageID: "message", partID: "bash-2" },
        ],
      },
    ])
  })

  test("splits command, edit, and generic tool activities", () => {
    expect(
      groupParts(
        refs([
          tool("bash-1", "bash"),
          tool("bash-2", "bash"),
          tool("edit-1", "edit"),
          tool("edit-2", "write"),
          tool("custom-1", "custom"),
          tool("custom-2", "custom"),
        ]),
      ).map((group) => (group.type === "tool" ? group.kind : group.type)),
    ).toEqual(["command", "edit", "tool"])
  })

  test("does not add an outer group around a single detailed tool", () => {
    expect(groupParts(refs([tool("bash-1", "bash")]))[0]?.type).toBe("part")
  })

  test("assistant text separates command runs", () => {
    expect(
      groupParts(refs([tool("bash-1", "bash"), tool("bash-2", "bash"), text("answer"), tool("bash-3", "bash")])).map(
        (group) => group.type,
      ),
    ).toEqual(["tool", "part", "part"])
  })
})

describe("readPartText", () => {
  test("returns empty string when accum is undefined and part text is undefined", () => {
    expect(readPartText(undefined, { id: "part_1" })).toBe("")
  })

  test("returns trimmed part text when accum is undefined", () => {
    expect(readPartText(undefined, { id: "part_1", text: "  hello  " })).toBe("hello")
  })

  test("prefers accum value over part text when accum has a hit", () => {
    expect(readPartText({ part_1: "  from accum  " }, { id: "part_1", text: "from part" })).toBe("from accum")
  })

  test("falls back to part text when accum misses", () => {
    expect(readPartText({ other_part: "ignored" }, { id: "part_1", text: "  from part  " })).toBe("from part")
  })

  test("returns empty string for whitespace-only text", () => {
    expect(readPartText(undefined, { id: "part_1", text: "   \n\t  " })).toBe("")
  })

  test("trims leading and trailing whitespace", () => {
    expect(readPartText(undefined, { id: "part_1", text: "\n  body  \n" })).toBe("body")
  })
})

describe("toolActionCountItems", () => {
  const running = (id: string, name: string) =>
    ({ ...tool(id, name), state: { status: "running", input: {}, time: { start: 0 } } }) satisfies Part

  test("counts completed activity per category", () => {
    expect(
      toolActionCountItems([
        tool("read-1", "read"),
        tool("glob-1", "glob"),
        tool("grep-1", "grep"),
        tool("list-1", "list"),
        tool("bash-1", "bash"),
        tool("write-1", "write"),
        tool("task-1", "task"),
        tool("todo-1", "todowrite"),
        text("answer"),
      ]),
    ).toEqual([
      { key: "ui.messagePart.context.read", count: 1 },
      { key: "ui.messagePart.context.search", count: 2 },
      { key: "ui.messagePart.context.list", count: 1 },
      { key: "ui.messagePart.tools.command.done", count: 1 },
      { key: "ui.messagePart.tools.edit.done", count: 1 },
      { key: "ui.messagePart.tools.generic.done", count: 1 },
    ])
  })

  test("switches a category to its active form while a part runs", () => {
    expect(toolActionCountItems([tool("bash-1", "bash"), running("bash-2", "bash"), tool("edit-1", "edit")])).toEqual([
      { key: "ui.messagePart.context.read", count: 0 },
      { key: "ui.messagePart.context.search", count: 0 },
      { key: "ui.messagePart.context.list", count: 0 },
      { key: "ui.messagePart.tools.command.active", count: 2 },
      { key: "ui.messagePart.tools.edit.done", count: 1 },
      { key: "ui.messagePart.tools.generic.done", count: 0 },
    ])
  })

  test("ignores hidden and question parts", () => {
    expect(
      toolActionCountItems([
        tool("todo-1", "todowrite"),
        tool("question-1", "question"),
        running("question-2", "question"),
      ]),
    ).toEqual([
      { key: "ui.messagePart.context.read", count: 0 },
      { key: "ui.messagePart.context.search", count: 0 },
      { key: "ui.messagePart.context.list", count: 0 },
      { key: "ui.messagePart.tools.command.done", count: 0 },
      { key: "ui.messagePart.tools.edit.done", count: 0 },
      { key: "ui.messagePart.tools.generic.done", count: 0 },
    ])
  })
})
