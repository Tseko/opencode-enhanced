export function isDefault(title: string) {
  return /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(title)
}

export function fromPrompt(text: string) {
  const line = text.trim().split(/\r?\n/, 1)[0]?.replace(/\s+/g, " ").trim()
  if (!line) return
  return line.split(" ").filter(Boolean).slice(0, 3).join(" ")
}

// Normalizes raw model output into a displayable single-line title: drops think blocks,
// picks the first non-empty line, and clamps overly long titles.
export function clean(text: string) {
  const line = text
    .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (!line) return
  return line.length > 100 ? `${line.substring(0, 97)}...` : line
}

export * as SessionTitle from "./title"
