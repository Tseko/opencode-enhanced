export * as InstructionRule from "./instruction-rule"

import { Context } from "effect"
import { ConfigMarkdown } from "./config/markdown"
import { Glob } from "./util/glob"

export interface Spec {
  readonly alwaysApply: boolean
  readonly globs: ReadonlyArray<string>
  readonly match: ReadonlyArray<string>
}

export interface Parsed {
  readonly spec: Spec
  readonly body: string
}

export interface Signals {
  readonly text: string
  readonly paths: ReadonlyArray<string>
}

export class SignalsService extends Context.Service<SignalsService, Signals>()("@opencode/InstructionRule.Signals") {}

const emptySpec: Spec = { alwaysApply: true, globs: [], match: [] }

export function parse(content: string): Parsed {
  const markdown = ConfigMarkdown.parseOption(content)
  if (!markdown) return { spec: emptySpec, body: content }
  return { spec: specFrom(markdown.data), body: markdown.content }
}

export function fromPaths(paths: ReadonlyArray<string>): Signals {
  return { text: paths.join("\n"), paths }
}

export function merge(base: Signals, extra: Signals | undefined): Signals {
  if (!extra) return base
  return {
    text: [base.text, extra.text].filter((part) => part.length > 0).join("\n"),
    paths: [...base.paths, ...extra.paths],
  }
}

export function applies(spec: Spec, signals: Signals): boolean {
  if (spec.alwaysApply) return true
  const haystack = `${signals.text}\n${signals.paths.join("\n")}`.toLowerCase()
  if (spec.match.some((keyword) => keyword.length > 0 && haystack.includes(keyword.toLowerCase()))) return true
  return spec.globs.some((pattern) => signals.paths.some((filepath) => matchesGlob(pattern, filepath)))
}

function specFrom(data: unknown): Spec {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return emptySpec
  const record: { [key: string]: unknown } = { ...data }
  const globs = strings(record.globs)
  const match = strings(record.match)
  const always = flag(record.alwaysApply)
  const alwaysApply = always ?? (globs.length === 0 && match.length === 0)
  return { alwaysApply, globs, match }
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : []
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => (typeof item === "string" && item.trim() ? [item.trim()] : []))
}

function flag(value: unknown): boolean | undefined {
  if (value === true || value === "true") return true
  if (value === false || value === "false") return false
  return
}

function matchesGlob(pattern: string, filepath: string) {
  const normalized = filepath.replaceAll("\\", "/").replace(/^file:\/\//i, "")
  const trimmed = /^\/[A-Za-z]:/.test(normalized) ? normalized.slice(1) : normalized
  const base = trimmed.split("/").at(-1) ?? trimmed
  const glob = pattern.replaceAll("\\", "/")
  const leaf = glob.includes("/") ? glob.replace(/^(\*\*\/)+/, "") : glob
  return Glob.match(glob, trimmed) || Glob.match(glob, base) || Glob.match(leaf, base)
}
