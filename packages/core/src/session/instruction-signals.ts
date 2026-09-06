export * as SessionInstructionSignals from "./instruction-signals"

import { InstructionRule } from "../instruction-rule"
import { SessionMessage } from "./message"
import { Prompt } from "./prompt"

export function fromPrompts(prompts: ReadonlyArray<Prompt>): InstructionRule.Signals {
  const texts: string[] = []
  const paths: string[] = []
  for (const prompt of prompts) {
    texts.push(prompt.text)
    for (const file of prompt.files ?? []) {
      paths.push(fromUri(file.uri))
      if (file.name) paths.push(file.name)
    }
  }
  return { text: texts.join("\n"), paths }
}

export function fromMessages(messages: ReadonlyArray<SessionMessage.Message>): InstructionRule.Signals {
  const texts: string[] = []
  const paths: string[] = []
  for (const message of messages) {
    if (message.type === "user") {
      texts.push(message.text)
      for (const file of message.files ?? []) {
        paths.push(fromUri(file.uri))
        if (file.name) paths.push(file.name)
      }
      continue
    }
    if (message.type !== "assistant") continue
    for (const file of message.snapshot?.files ?? []) paths.push(file)
    for (const part of message.content) {
      if (part.type !== "tool") continue
      paths.push(...pathsFromInput(part.state.input))
    }
  }
  return { text: texts.join("\n"), paths }
}

function fromUri(uri: string) {
  if (!uri.startsWith("file://")) return uri
  const path = decodeURIComponent(uri.slice("file://".length))
  return /^\/[A-Za-z]:/.test(path) ? path.slice(1) : path
}

function pathsFromInput(value: unknown): string[] {
  if (typeof value === "string") return looksLikePath(value) ? [value] : []
  if (Array.isArray(value)) return value.flatMap(pathsFromInput)
  if (value === null || typeof value !== "object") return []
  return Object.entries(value).flatMap(([key, item]) => {
    if (typeof item === "string" && /path|file|glob|uri/i.test(key)) return [item]
    return pathsFromInput(item)
  })
}

function looksLikePath(value: string) {
  return value.includes("/") || value.includes("\\") || /\.\w{1,8}$/.test(value)
}
