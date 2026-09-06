const mutatingTools = new Set(["edit", "write", "apply_patch"])

export function createFileMutationTracker() {
  const pending = new Set<string>()
  const shouldRefresh = (event: unknown, sessionID?: string) => {
    const payload = mutationEventPayload(event)
    if (!payload) return false
    const type = payloadType(payload)
    if (!type) return false
    const data = payloadData(payload)
    if (sessionID && typeof data.sessionID === "string" && data.sessionID !== sessionID) return false

    if (type === "file.edited" || type === "file.watcher.updated" || type === "filesystem.changed") {
      const file = typeof data.file === "string" ? data.file : undefined
      if (type !== "file.edited" && !file) return false
      if (file?.startsWith(".git/") || file?.includes("/.git/")) return false
      return true
    }

    const callID = typeof data.callID === "string" ? data.callID : undefined
    const name = typeof data.name === "string" ? data.name : typeof data.tool === "string" ? data.tool : undefined
    const kind = type.replace(/^session\.next\./, "session.")
    if (kind === "session.tool.called" || kind === "session.tool.input.started") {
      if (name && mutatingTools.has(name) && callID) pending.add(callID)
      return false
    }
    if (kind === "session.tool.success") {
      if (callID && pending.delete(callID)) return true
      return looksLikeFileMutation(data)
    }
    if (kind === "session.tool.failed" && callID) pending.delete(callID)
    return false
  }
  return { shouldRefresh }
}

export function mutationEventPayload(event: unknown) {
  const record = asRecord(event)
  if (!record) return
  return asRecord(record.details) ?? record
}

export function eventSessionID(event: unknown) {
  const payload = mutationEventPayload(event)
  if (!payload) return
  const sessionID = payloadData(payload).sessionID
  if (typeof sessionID === "string") return sessionID
}

function payloadType(payload: Record<string, unknown>) {
  const current = asRecord(payload.current)
  const type = typeof current?.type === "string" ? current.type : payload.type
  if (typeof type !== "string") return
  return type.replace(/\.\d+$/, "")
}

function payloadData(payload: Record<string, unknown>) {
  const current = asRecord(payload.current)
  const data = asRecord(current?.data)
  const properties = asRecord(payload.properties)
  if (!data) return properties ?? {}
  if (!properties) return data
  return { ...properties, ...data }
}

function looksLikeFileMutation(data: Record<string, unknown>) {
  const structured = asRecord(data.structured)
  const result = asRecord(data.result)
  const source = structured ?? result ?? data
  if (Array.isArray(source.files) || Array.isArray(source.applied)) return true
  return source.operation === "write" && typeof source.target === "string"
}

function asRecord(value: unknown) {
  if (!value || typeof value !== "object") return
  return value as Record<string, unknown>
}
