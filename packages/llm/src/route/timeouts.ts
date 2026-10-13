/**
 * Provider request deadlines, overridable per route through `route.with({ timeouts })`.
 *
 * `requestMs` bounds connect plus response headers. `idleMs` bounds the gap
 * between decoded semantic events, so transport keepalive traffic cannot hold a
 * stalled response open. `totalMs` bounds the whole response stream.
 */
export interface Timeouts {
  readonly requestMs?: number
  readonly idleMs?: number
  readonly totalMs?: number
}

export const REQUEST_TIMEOUT_MS = 120_000
export const STREAM_IDLE_TIMEOUT_MS = 90_000
export const STREAM_TOTAL_TIMEOUT_MS = 30 * 60_000

export interface Resolved {
  readonly requestMs: number
  readonly idleMs: number
  readonly totalMs: number
}

export const resolveTimeouts = (timeouts: Timeouts | undefined): Resolved => ({
  requestMs: timeouts?.requestMs ?? REQUEST_TIMEOUT_MS,
  idleMs: timeouts?.idleMs ?? STREAM_IDLE_TIMEOUT_MS,
  totalMs: timeouts?.totalMs ?? STREAM_TOTAL_TIMEOUT_MS,
})
