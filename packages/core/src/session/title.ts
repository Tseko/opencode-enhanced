export function isDefault(title: string) {
  return /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(title)
}

export function fromPrompt(text: string) {
  const line = text.trim().split(/\r?\n/, 1)[0]?.replace(/\s+/g, " ").trim()
  if (!line) return
  return line.split(" ").filter(Boolean).slice(0, 3).join(" ")
}

export * as SessionTitle from "./title"
