import { Patch } from "@opencode-ai/core/patch"
import { normalize, type ViewDiff } from "./session-diff"

type Kind = "add" | "update" | "delete" | "move"

type Raw = {
  filePath?: string
  relativePath?: string
  file?: string
  type?: Kind
  status?: "added" | "deleted" | "modified"
  patch?: string
  diff?: string
  before?: string
  after?: string
  additions?: number
  deletions?: number
  movePath?: string
}

export type ApplyPatchFile = {
  filePath: string
  relativePath: string
  type: Kind
  additions: number
  deletions: number
  movePath?: string
  view: ViewDiff
}

function kind(value: unknown) {
  if (value === "add" || value === "update" || value === "delete" || value === "move") return value
}

function statusKind(value: unknown): Kind | undefined {
  if (value === "added") return "add"
  if (value === "deleted") return "delete"
  if (value === "modified") return "update"
}

function status(type: Kind): "added" | "deleted" | "modified" {
  if (type === "add") return "added"
  if (type === "delete") return "deleted"
  return "modified"
}

export function patchFile(raw: unknown): ApplyPatchFile | undefined {
  if (!raw || typeof raw !== "object") return

  const value = raw as Raw
  const type = kind(value.type) ?? statusKind(value.status)
  const filePath = typeof value.filePath === "string" ? value.filePath : typeof value.file === "string" ? value.file : undefined
  const relativePath = typeof value.relativePath === "string" ? value.relativePath : filePath
  const patch = typeof value.patch === "string" ? value.patch : typeof value.diff === "string" ? value.diff : undefined
  const before = typeof value.before === "string" ? value.before : undefined
  const after = typeof value.after === "string" ? value.after : undefined

  if (!type || !filePath || !relativePath) return
  if (!patch && before === undefined && after === undefined) return

  const additions = typeof value.additions === "number" ? value.additions : 0
  const deletions = typeof value.deletions === "number" ? value.deletions : 0
  const movePath = typeof value.movePath === "string" ? value.movePath : undefined

  return {
    filePath,
    relativePath,
    type,
    additions,
    deletions,
    movePath,
    view: normalize({
      file: relativePath,
      patch,
      before,
      after,
      additions,
      deletions,
      status: status(type),
    }),
  }
}

export function patchFiles(raw: unknown) {
  if (!Array.isArray(raw)) return []
  return raw.map(patchFile).filter((file): file is ApplyPatchFile => !!file)
}

export type BufferTransaction =
  | { type: "replace"; path: string; content: string }
  | { type: "delete"; path: string }
  | { type: "splice"; path: string; fromLine: number; remove: number; insert: ReadonlyArray<string> }
  | { type: "update"; path: string; chunks: ReadonlyArray<Patch.UpdateFileChunk> }

export type PatchStreamState = {
  buffer: string
  transactions: BufferTransaction[]
}

export function createPatchStream(): PatchStreamState {
  return { buffer: "", transactions: [] }
}

export function pushPatchDelta(state: PatchStreamState, delta: string): PatchStreamState {
  const buffer = state.buffer + delta
  return { buffer, transactions: parseTransactions(extractPatchText(buffer)) }
}

export function applyBufferTransactions(content: string, transactions: ReadonlyArray<BufferTransaction>) {
  return transactions.reduce(applyTransaction, content)
}

export function matchesFilePath(patchPath: string, openPath: string) {
  const left = normalizePath(patchPath)
  const right = normalizePath(openPath)
  if (left === right) return true
  if (right.endsWith(`/${left}`)) return true
  if (left.endsWith(`/${right}`)) return true
  return false
}

export function streamDelta(event: unknown) {
  const record = asRecord(event)
  const current = asRecord(record?.current)
  const data = asRecord(current?.data)
  if (
    (current?.type === "session.tool.input.delta" || current?.type === "session.next.tool.input.delta") &&
    typeof data?.delta === "string"
  )
    return data.delta
  if (current?.type === "message.part.delta" && typeof data?.delta === "string") return data.delta
  if (
    record?.type !== "session.tool.input.delta" &&
    record?.type !== "session.next.tool.input.delta" &&
    record?.type !== "message.part.delta"
  )
    return
  const props = asRecord(record.properties)
  if (typeof props?.delta === "string") return props.delta
}

export function streamKey(event: unknown) {
  const record = asRecord(event)
  const current = asRecord(record?.current)
  const data = asRecord(current?.data)
  if (typeof data?.callID === "string") return data.callID
  if (typeof data?.partID === "string") return data.partID
  const props = asRecord(record?.properties)
  if (typeof props?.callID === "string") return props.callID
  if (typeof props?.partID === "string") return props.partID
}

function applyTransaction(content: string, tx: BufferTransaction) {
  if (tx.type === "replace") return tx.content
  if (tx.type === "delete") return ""
  if (tx.type === "update") return applyUpdate(tx.path, tx.chunks, content)
  const lines = splitLines(content)
  const fromLine = Math.max(0, Math.min(tx.fromLine, lines.length))
  lines.splice(fromLine, tx.remove, ...tx.insert)
  return joinLines(lines, content)
}

function applyUpdate(path: string, chunks: ReadonlyArray<Patch.UpdateFileChunk>, content: string) {
  try {
    return Patch.derive(path, chunks, content).content
  } catch {
    return content
  }
}

function parseTransactions(text: string) {
  if (text.includes("*** Begin Patch") || text.includes("*** Update File:") || text.includes("*** Add File:")) {
    return parseApplyPatch(text)
  }
  return parseUnified(text)
}

function parseApplyPatch(text: string) {
  const lines = text.replaceAll("\r\n", "\n").split("\n")
  const transactions: BufferTransaction[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]!
    if (line.startsWith("*** Add File:")) {
      const path = line.slice("*** Add File:".length).trim()
      const parsed = parseAddFile(lines, index + 1)
      if (parsed.complete && path) transactions.push({ type: "replace", path, content: parsed.content })
      index = parsed.next
      continue
    }
    if (line.startsWith("*** Delete File:")) {
      const path = line.slice("*** Delete File:".length).trim()
      if (path) transactions.push({ type: "delete", path })
      index++
      continue
    }
    if (line.startsWith("*** Update File:")) {
      const path = line.slice("*** Update File:".length).trim()
      let next = index + 1
      if (lines[next]?.startsWith("*** Move to:")) next++
      const parsed = parseUpdateChunks(lines, next)
      if (path && parsed.chunks.length > 0) transactions.push({ type: "update", path, chunks: parsed.chunks })
      index = parsed.next
      continue
    }
    index++
  }
  return transactions
}

function parseAddFile(lines: ReadonlyArray<string>, start: number) {
  const content: string[] = []
  let index = start
  while (index < lines.length && !lines[index]!.startsWith("***")) {
    if (!lines[index]!.startsWith("+")) return { complete: false, content: content.join("\n"), next: index }
    content.push(lines[index]!.slice(1))
    index++
  }
  return { complete: index < lines.length && lines[index]!.startsWith("***"), content: content.join("\n"), next: index }
}

function parseUpdateChunks(lines: ReadonlyArray<string>, start: number) {
  const chunks: Patch.UpdateFileChunk[] = []
  let index = start
  while (index < lines.length && lines[index]!.startsWith("@@")) {
    const parsed = parseApplyChunk(lines, index)
    if (!parsed.complete) break
    chunks.push(parsed.chunk)
    index = parsed.next
  }
  return { chunks, next: index }
}

function parseApplyChunk(lines: ReadonlyArray<string>, start: number) {
  const changeContext = lines[start]!.slice(2).trim() || undefined
  const oldLines: string[] = []
  const newLines: string[] = []
  let endOfFile = false
  let index = start + 1
  while (index < lines.length) {
    const line = lines[index]!
    if (line === "*** End of File") {
      endOfFile = true
      index++
      return { complete: true as const, chunk: chunk(oldLines, newLines, changeContext, endOfFile), next: index }
    }
    if (line.startsWith("@@") || line.startsWith("***")) {
      return { complete: true as const, chunk: chunk(oldLines, newLines, changeContext, endOfFile), next: index }
    }
    if (line.startsWith(" ")) {
      oldLines.push(line.slice(1))
      newLines.push(line.slice(1))
    } else if (line.startsWith("-")) oldLines.push(line.slice(1))
    else if (line.startsWith("+")) newLines.push(line.slice(1))
    else return { complete: false as const, next: index }
    index++
  }
  return { complete: false as const, next: index }
}

function chunk(
  oldLines: ReadonlyArray<string>,
  newLines: ReadonlyArray<string>,
  changeContext: string | undefined,
  endOfFile: boolean,
): Patch.UpdateFileChunk {
  return { oldLines, newLines, changeContext, endOfFile: endOfFile || undefined }
}

function parseUnified(text: string) {
  const lines = text.replaceAll("\r\n", "\n").split("\n")
  const transactions: BufferTransaction[] = []
  let path = ""
  let index = 0
  while (index < lines.length) {
    const line = lines[index]!
    if (line.startsWith("+++ ")) {
      path = stripDiffPath(line.slice(4))
      index++
      continue
    }
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (!header) {
      index++
      continue
    }
    const oldStart = Number(header[1])
    const oldCount = header[2] === undefined ? 1 : Number(header[2])
    const newCount = header[4] === undefined ? 1 : Number(header[4])
    const parsed = parseUnifiedHunk(lines, index + 1, oldCount, newCount)
    if (parsed.complete && path) {
      transactions.push({
        type: "splice",
        path,
        fromLine: oldCount === 0 ? oldStart : oldStart - 1,
        remove: oldCount,
        insert: parsed.insert,
      })
    }
    index = parsed.next
  }
  return transactions
}

function parseUnifiedHunk(lines: ReadonlyArray<string>, start: number, oldCount: number, newCount: number) {
  const insert: string[] = []
  let oldSeen = 0
  let newSeen = 0
  let index = start
  while (index < lines.length) {
    const line = lines[index]!
    if (line.startsWith("\\")) {
      index++
      continue
    }
    if (line.startsWith("@@") || line.startsWith("diff ") || line.startsWith("*** ")) break
    if (line.startsWith("-")) {
      oldSeen++
      index++
      continue
    }
    if (line.startsWith("+")) {
      insert.push(line.slice(1))
      newSeen++
      index++
      continue
    }
    if (line.startsWith(" ")) {
      insert.push(line.slice(1))
      oldSeen++
      newSeen++
      index++
      continue
    }
    break
  }
  return { complete: oldSeen >= oldCount && newSeen >= newCount, insert, next: index }
}

function extractPatchText(buffer: string) {
  const json = jsonStringField(buffer, "patchText") ?? jsonStringField(buffer, "patch")
  if (json !== undefined) return json
  const begin = buffer.indexOf("*** Begin Patch")
  if (begin !== -1) {
    const end = buffer.indexOf("*** End Patch", begin)
    if (end === -1) return buffer.slice(begin)
    return buffer.slice(begin, end + "*** End Patch".length)
  }
  const unified = buffer.indexOf("@@")
  if (unified === -1) return buffer
  const header = buffer.lastIndexOf("Index:", unified)
  const dash = buffer.lastIndexOf("--- ", unified)
  const start = Math.max(header, dash)
  return buffer.slice(start === -1 ? unified : start)
}

function jsonStringField(buffer: string, key: string) {
  const needle = `"${key}"`
  const keyIndex = buffer.indexOf(needle)
  if (keyIndex === -1) return
  const colon = buffer.indexOf(":", keyIndex + needle.length)
  if (colon === -1) return
  const quote = buffer.indexOf('"', colon + 1)
  if (quote === -1) return
  return unescapeJsonRange(buffer, quote + 1)
}

function unescapeJsonRange(buffer: string, start: number) {
  let out = ""
  let escaped = false
  let index = start
  while (index < buffer.length) {
    const ch = buffer[index]!
    index++
    if (escaped) {
      if (ch === "n") out += "\n"
      else if (ch === "r") out += "\r"
      else if (ch === "t") out += "\t"
      else out += ch
      escaped = false
      continue
    }
    if (ch === "\\") {
      escaped = true
      continue
    }
    if (ch === '"') return out
    out += ch
  }
  return out
}

function normalizePath(value: string) {
  return value.replaceAll("\\", "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "")
}

function stripDiffPath(value: string) {
  return normalizePath(value.replace(/^[ab]\//, "").split("\t")[0]!.trim())
}

function splitLines(content: string) {
  const lines = content.split("\n")
  if (lines.at(-1) === "") lines.pop()
  return lines
}

function joinLines(lines: ReadonlyArray<string>, original: string) {
  if (lines.length === 0) return original.endsWith("\n") ? "\n" : ""
  return lines.join("\n") + (original.endsWith("\n") || original.length === 0 ? "\n" : "")
}

function asRecord(value: unknown) {
  if (!value || typeof value !== "object") return
  return value as Record<string, unknown>
}
