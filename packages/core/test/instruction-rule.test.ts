import { describe, expect, test } from "bun:test"
import { InstructionRule } from "../src/instruction-rule"

describe("InstructionRule", () => {
  test("untagged files always apply", () => {
    const parsed = InstructionRule.parse("NEVER use dotnet build")
    expect(parsed.spec).toEqual({ alwaysApply: true, globs: [], match: [] })
    expect(parsed.body).toContain("NEVER use dotnet build")
    expect(InstructionRule.applies(parsed.spec, { text: "", paths: [] })).toBe(true)
  })

  test("alwaysApply true ignores globs", () => {
    const parsed = InstructionRule.parse(`---
alwaysApply: true
globs: "**/*.cshtml"
---
keep`)
    expect(parsed.spec.alwaysApply).toBe(true)
    expect(parsed.body.trim()).toBe("keep")
    expect(InstructionRule.applies(parsed.spec, { text: "", paths: [] })).toBe(true)
  })

  test("globs attach only for matching paths", () => {
    const parsed = InstructionRule.parse(`---
alwaysApply: false
globs:
  - "**/*.cshtml"
  - "**/*.razor"
---
razor`)
    expect(parsed.spec.alwaysApply).toBe(false)
    expect(InstructionRule.applies(parsed.spec, { text: "search InstallationPackages", paths: [] })).toBe(false)
    expect(
      InstructionRule.applies(parsed.spec, {
        text: "",
        paths: ["C:/Users/admin/source/repos/Telmetra/Views/Home.cshtml"],
      }),
    ).toBe(true)
  })

  test("match attaches from workspace path or prompt text", () => {
    const parsed = InstructionRule.parse(`---
alwaysApply: false
match:
  - autrady
  - ticker
---
autrady`)
    expect(
      InstructionRule.applies(parsed.spec, InstructionRule.fromPaths(["C:/Users/admin/source/repos/Telmetra"])),
    ).toBe(false)
    expect(
      InstructionRule.applies(parsed.spec, InstructionRule.fromPaths(["C:/Users/admin/source/repos/Autrady"])),
    ).toBe(true)
    expect(InstructionRule.applies(parsed.spec, { text: "rank ticker strategies", paths: [] })).toBe(true)
  })

  test("omitted alwaysApply with globs is conditional", () => {
    const parsed = InstructionRule.parse(`---
globs: "**/*.cshtml"
---
body`)
    expect(parsed.spec.alwaysApply).toBe(false)
  })

  test("description-only frontmatter still always applies", () => {
    const parsed = InstructionRule.parse(`---
description: Think critically
---
ALWAYS think critically`)
    expect(parsed.spec.alwaysApply).toBe(true)
  })
})
