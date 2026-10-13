declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
}

export const InstallationVersion = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
export const InstallationChannel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
// Isolated test installers stamp a `0.0.0-<channel>-<timestamp>` version that is never
// published to npm. Treat those builds as local so tooling does not pin dependencies
// (for example `@opencode-ai/plugin`) to a version that cannot be installed.
export const InstallationLocal = InstallationChannel === "local" || InstallationVersion.startsWith("0.0.0-")
