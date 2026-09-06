import { expect, test } from "bun:test"
import { getRelativeTime } from "./time"

const t: Parameters<typeof getRelativeTime>[1] = (key, params) => {
  if (key === "common.time.justNow") return "Just now"
  if (key === "common.time.minutesAgo.short") return `${params?.count}m ago`
  if (key === "common.time.hoursAgo.short") return `${params?.count}h ago`
  return `${params?.count}d ago`
}

test("formats compact relative time from millis", () => {
  const now = Date.now()
  expect(getRelativeTime(now - 30_000, t)).toBe("Just now")
  expect(getRelativeTime(now - 2 * 60_000, t)).toBe("2m ago")
  expect(getRelativeTime(now - 3 * 60 * 60_000, t)).toBe("3h ago")
  expect(getRelativeTime(now - 2 * 24 * 60 * 60_000, t)).toBe("2d ago")
})

test("still accepts ISO timestamps", () => {
  const value = new Date(Date.now() - 5 * 60_000).toISOString()
  expect(getRelativeTime(value, t)).toBe("5m ago")
})
