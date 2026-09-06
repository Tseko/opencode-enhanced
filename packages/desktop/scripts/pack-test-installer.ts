#!/usr/bin/env bun
import { $ } from "bun"

process.env.OPENCODE_CHANNEL = "prod"
process.env.OPENCODE_ISOLATE_INSTALL = "1"
process.env.OPENCODE_VERSION ??= `0.0.0-cursor-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`
process.env.OPENCODE_PRODUCT_NAME ??= "OpenCode Cursor"
process.env.CSC_IDENTITY_AUTO_DISCOVERY ??= "false"

const pkgFile = Bun.file("./package.json")
const originalText = await pkgFile.text()

try {
  await import("./prepare")
  const packed = await pkgFile.json()
  packed.name = "opencode-cursor"
  packed.version = process.env.OPENCODE_VERSION
  await Bun.write("./package.json", JSON.stringify(packed, null, 2) + "\n")

  await $`bunx electron-vite build`
  await $`bunx electron-builder --win --publish never --config electron-builder.config.ts`
} finally {
  await Bun.write("./package.json", originalText.endsWith("\n") ? originalText : originalText + "\n")
}

const installer = `dist/opencode-desktop-win-x64-${process.env.OPENCODE_VERSION}.exe`
console.log(`Test installer ready: ${installer}`)
console.log(
  `Production-channel build (no DEV badge). Installs as "${process.env.OPENCODE_PRODUCT_NAME}" into %LOCALAPPDATA%\\Programs\\opencode-cursor, not production OpenCode.`,
)
