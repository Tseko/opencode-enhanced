import { expect, test } from "@playwright/test"
import { assistantMessage, setupTimeline, status, textPart, toolPart, userMessage } from "./fixture"

// AnimatedNumber renders a rotating digit strip, so each value is read from its aria-label rather than
// from text content. Label order mirrors the count items: read, search, list, command, edit, tool.
test.describe("thinking preloader", () => {
  test("reports cumulative turn activity and a ticking elapsed timer", async ({ page }) => {
    const timeline = await setupTimeline(page, {
      locale: "en",
      settings: { showReasoningSummaries: false },
      messages: [
        userMessage(undefined, { created: Date.now() - 42_000 }),
        assistantMessage(
          [
            toolPart("prt_preloader_read", "read", "completed", { filePath: "src/index.ts" }),
            toolPart("prt_preloader_glob", "glob", "completed", { pattern: "src/**/*.ts" }),
            toolPart("prt_preloader_bash", "bash", "running", { command: "bun test" }),
            textPart("prt_preloader_text", "Working through the task"),
          ],
          { completed: false, created: Date.now() - 41_000 },
        ),
      ],
    })
    await timeline.send(status("busy"), 120)

    const thinking = page.locator('[data-slot="session-turn-thinking"]')
    await expect(thinking).toBeVisible()
    await expect(thinking).toContainText("Thinking")

    const counts = page.locator('[data-slot="session-turn-thinking-counts"]')
    await expect(counts).toBeVisible()
    await expect(counts).toContainText("read")
    await expect(counts).toContainText("Running")
    await expect(counts).toContainText("command")
    await expect(counts.locator('[data-component="animated-number"]').nth(0)).toHaveAttribute("aria-label", "1")
    await expect(counts.locator('[data-component="animated-number"]').nth(1)).toHaveAttribute("aria-label", "1")
    await expect(counts.locator('[data-component="animated-number"]').nth(3)).toHaveAttribute("aria-label", "1")
    await expect(counts.locator('[data-component="animated-number"]').nth(4)).toHaveAttribute("aria-label", "0")
    expect((await counts.boundingBox())?.width ?? 0).toBeGreaterThan(40)

    const elapsed = page.locator('[data-slot="session-turn-thinking-elapsed"]')
    await expect(elapsed).toHaveText(/^\d+s$/)
    const before = await elapsed.textContent()
    await page.waitForTimeout(1300)
    await expect(elapsed).not.toHaveText(before ?? "")
  })

  test("switches to the minutes format in the new layout", async ({ page }) => {
    await setupTimeline(page, {
      locale: "en",
      settings: { showReasoningSummaries: false, newLayoutDesigns: true },
      messages: [
        userMessage(undefined, { created: Date.now() - 95_000 }),
        assistantMessage([toolPart("prt_preloader_edit", "edit", "completed", { filePath: "src/index.ts" })], {
          completed: false,
          created: Date.now() - 94_000,
        }),
      ],
    })

    const thinking = page.locator('[data-slot="session-turn-thinking"]')
    await expect(thinking).toBeVisible()
    await expect(page.locator('[data-slot="session-turn-thinking-elapsed"]')).toHaveText(/^1m \d+s$/)
    const counts = page.locator('[data-slot="session-turn-thinking-counts"]')
    await expect(counts).toContainText("Made")
    await expect(counts).toContainText("edit")
    await expect(counts.locator('[data-component="animated-number"]').nth(4)).toHaveAttribute("aria-label", "1")
  })

  test("keeps the row single-line in a narrow panel", async ({ page }) => {
    await setupTimeline(page, {
      locale: "en",
      settings: { showReasoningSummaries: false },
      viewport: { width: 520, height: 900 },
      messages: [
        userMessage(undefined, { created: Date.now() - 30_000 }),
        assistantMessage(
          [
            toolPart("prt_preloader_narrow_read", "read", "completed", { filePath: "src/index.ts" }),
            toolPart("prt_preloader_narrow_glob", "glob", "completed", { pattern: "src/**/*.ts" }),
            toolPart("prt_preloader_narrow_list", "list", "completed", { path: "src" }),
            toolPart("prt_preloader_narrow_bash", "bash", "running", { command: "bun test" }),
            toolPart("prt_preloader_narrow_edit", "edit", "completed", { filePath: "src/index.ts" }),
            toolPart("prt_preloader_narrow_task", "task", "completed", {
              description: "Inspect",
              subagent_type: "explore",
            }),
          ],
          { completed: false, created: Date.now() - 29_000 },
        ),
      ],
    })

    const thinking = page.locator('[data-slot="session-turn-thinking"]')
    await expect(thinking).toBeVisible()
    await expect(page.locator('[data-slot="session-turn-thinking-elapsed"]')).toBeVisible()
    const row = await thinking.boundingBox()
    expect(row?.height ?? 0).toBeLessThanOrEqual(24)
    expect((row?.x ?? 0) + (row?.width ?? 0)).toBeLessThanOrEqual(521)
    await expect(page.locator('[data-slot="session-turn-thinking-counts"]')).toBeVisible()
  })
})
