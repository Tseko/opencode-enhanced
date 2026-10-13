import { describe, expect, test } from "bun:test"
import { createApiForServer, createSdkForServer } from "./server"
import { createCompatibleApi } from "./server-compat"

function setup(
  protocol: "v1" | "v2" | Promise<"v1" | "v2">,
  responses?: { vcs?: { branch: string; default_branch: string } },
) {
  const requests: Request[] = []
  const fetcher = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      requests.push(request)
      if (request.method === "PATCH") {
        return Response.json({
          id: "ses_1",
          slug: "ses_1",
          projectID: "project",
          directory: "/repo",
          title: "Session",
          version: "1",
          time: { created: 1, updated: 1 },
        })
      }
      if (request.method === "POST" && request.url.endsWith("/prompt_async"))
        return new Response(undefined, { status: 204 })
      if (request.method === "POST" && /\/api\/session\/[^/]+\/compact$/.test(new URL(request.url).pathname))
        return Response.json({
          data: { admittedSeq: 1, id: "compact_1", sessionID: "ses_1", timeCreated: 1, type: "compaction" },
        })
      if (request.method === "POST" && /\/api\/session\/[^/]+\/revert\/stage$/.test(new URL(request.url).pathname))
        return Response.json({ data: { messageID: "msg_1", files: [] } })
      if (request.method === "POST" && request.url.endsWith("/prompt")) {
        return Response.json({
          admittedSeq: 1,
          id: "msg_1",
          sessionID: "ses_1",
          timeCreated: 1,
          type: "user",
          data: { text: "hello" },
          delivery: "steer",
        })
      }
      if (request.method === "GET" && new URL(request.url).pathname === "/vcs")
        return Response.json(responses?.vcs ?? {})
      if (request.method === "GET" && new URL(request.url).pathname === "/api/command") {
        return Response.json({
          location: { directory: "/repo", project: { id: "project", directory: "/repo" } },
          data: [{ name: "review", template: "Review $ARGUMENTS" }],
        })
      }
      if (request.method === "GET") return Response.json([])
      return new Response(undefined, { status: 204 })
    },
    { preconnect: globalThis.fetch.preconnect },
  )
  const server = { url: "http://localhost:4096" }
  const api = createCompatibleApi({
    protocol: typeof protocol === "string" ? Promise.resolve(protocol) : protocol,
    current: createApiForServer({ server, fetch: fetcher }),
    next: createSdkForServer({ server, fetch: fetcher, directory: "/repo", throwOnError: true }),
    legacy: (directory) => createSdkForServer({ server, fetch: fetcher, directory, throwOnError: true }),
    directory: "/repo",
  })
  return { api, requests }
}

describe("createCompatibleApi", () => {
  /*
  test("routes V1 archive through the legacy session update", async () => {
    const { api, requests } = setup("v1")
    await api.session.archive({ sessionID: "ses_1", directory: "/repo" })

    const url = new URL(requests[0]!.url)
    expect(url.pathname).toBe("/session/ses_1")
    expect(requests[0]!.headers.get("x-opencode-directory")).toBe("%2Frepo")
    expect(requests[0]!.method).toBe("PATCH")
    expect(await requests[0]!.json()).toMatchObject({ time: { archived: expect.any(Number) } })
  })
  */

  test("routes V1-protocol prompts through the V2 session prompt endpoint", async () => {
    const { api, requests } = setup("v1")
    await api.session.prompt({
      sessionID: "ses_1",
      id: "msg_1",
      text: "hello @src/index.ts",
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
      files: [
        { uri: "file:///repo/src/index.ts", name: "index.ts", mention: { text: "@src/index.ts", start: 6, end: 19 } },
        { uri: "data:text/plain;base64,aGVsbG8=", name: "notes.txt" },
      ],
    })

    const prompt = requests.find((request) => new URL(request.url).pathname.endsWith("/prompt"))
    expect(prompt).toBeDefined()
    expect(requests.some((request) => new URL(request.url).pathname.endsWith("/prompt_async"))).toBe(false)
    expect(await prompt!.json()).toMatchObject({
      id: "msg_1",
      prompt: {
        text: "hello @src/index.ts",
        files: [
          { uri: "file:///repo/src/index.ts", name: "index.ts", source: { start: 6, end: 19, text: "@src/index.ts" } },
          { uri: "data:text/plain;base64,aGVsbG8=", name: "notes.txt" },
        ],
      },
    })
  })

  test("routes V1 interrupt through abort and the V2 interrupt endpoint", async () => {
    const { api, requests } = setup("v1")
    await api.session.interrupt({ sessionID: "ses_1" })

    expect(requests.map((request) => new URL(request.url).pathname).sort()).toEqual([
      "/api/session/ses_1/interrupt",
      "/session/ses_1/abort",
    ])
  })

  test("maps original parts into the V2 prompt payload", async () => {
    const { api, requests } = setup("v2")
    await api.session.prompt({
      sessionID: "ses_1",
      id: "msg_1",
      text: "look",
      files: [{ uri: "data:image/png;base64,AAAA", name: "image.png" }],
      legacyParts: [
        { id: "prt_text", type: "text", text: "look" },
        { id: "prt_image", type: "file", mime: "image/png", url: "data:image/png;base64,AAAA", filename: "image.png" },
      ],
    })

    const prompt = requests.find((request) => new URL(request.url).pathname.endsWith("/prompt"))
    expect(prompt).toBeDefined()
    expect(await prompt!.json()).toMatchObject({
      id: "msg_1",
      prompt: {
        text: "look",
        files: [{ uri: "data:image/png;base64,AAAA", name: "image.png" }],
      },
    })
  })

  test("resolves protocol detection once across implementation methods", async () => {
    let detections = 0
    const resolved = Promise.resolve<"v1" | "v2">("v2")
    const protocol = new Proxy(resolved, {
      get(target, property) {
        if (property !== "then") return Reflect.get(target, property, target)
        detections++
        return target.then.bind(target)
      },
    })
    const { api } = setup(protocol)

    await api.session.list()
    await api.session.list()

    expect(detections).toBe(1)
  })

  /*
  test("keeps V2 session actions on the current API", async () => {
    const { api, requests } = setup("v2")
    await api.session.archive({ sessionID: "ses_1" })

    expect(new URL(requests[0]!.url).pathname).toBe("/api/session/ses_1/archive")
    expect(requests[0]!.method).toBe("POST")
  })
  */

  test("uses the global V1 session search endpoint", async () => {
    const { api, requests } = setup("v1")
    await api.session.list({ parentID: null, search: "session", limit: 50 })

    expect(new URL(requests[0]!.url).pathname).toBe("/experimental/session")
  })

  /*
  test("projects the V1 default branch", async () => {
    const { api } = setup("v1", { vcs: { branch: "feature", default_branch: "dev" } })

    expect(await api.vcs.get({ location: { directory: "/repo" } })).toMatchObject({
      data: { branch: "feature", defaultBranch: "dev" },
    })
  })
  */

  test("translates current file searches to the V1 dirs parameter", async () => {
    const { api, requests } = setup("v1")
    await api.file.find({ location: { directory: "/repo" }, query: "src", type: "file", limit: 20 })

    const url = new URL(requests[0]!.url)
    expect(url.pathname).toBe("/find/file")
    expect(url.searchParams.get("dirs")).toBe("false")
    expect(url.searchParams.get("limit")).toBe("20")
  })

  test("routes V1-protocol permission replies through the V2 session permission endpoint", async () => {
    const { api, requests } = setup("v1")
    await api.permission.reply({
      sessionID: "ses_1",
      requestID: "per_1",
      reply: "always",
      location: { directory: "/other" },
    })

    expect(new URL(requests[0]!.url).pathname).toBe("/api/session/ses_1/permission/per_1/reply")
    expect(await requests[0]!.json()).toEqual({ reply: "always" })
  })

  test("routes V2 permission replies through the current session permission endpoint", async () => {
    const { api, requests } = setup("v2")
    await api.permission.reply({
      sessionID: "ses_1",
      requestID: "per_1",
      reply: "once",
    })

    expect(new URL(requests[0]!.url).pathname).toBe("/api/session/ses_1/permission/per_1/reply")
    expect(await requests[0]!.json()).toEqual({ reply: "once" })
  })

  test("routes V1-protocol compact, revert, and active through V2 session endpoints", async () => {
    const { api, requests } = setup("v1")
    await api.session.compact({ sessionID: "ses_1" })
    await api.session.revert.stage({ sessionID: "ses_1", messageID: "msg_1" })
    await api.session.revert.clear({ sessionID: "ses_1" })
    await api.session.revert.commit({ sessionID: "ses_1" })
    await api.session.active()

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/session/ses_1/compact",
      "/api/session/ses_1/revert/stage",
      "/api/session/ses_1/revert/clear",
      "/api/session/ses_1/revert/commit",
      "/api/session/active",
    ])
    expect(requests.some((request) => new URL(request.url).pathname.includes("/summarize"))).toBe(false)
    expect(requests.some((request) => new URL(request.url).pathname.includes("/unrevert"))).toBe(false)
  })

  test("routes V1-protocol question replies through V2 session question endpoints", async () => {
    const { api, requests } = setup("v1")
    await api.question.reply({ sessionID: "ses_1", requestID: "q_1", answers: [] })
    await api.question.reject({ sessionID: "ses_1", requestID: "q_1" })

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/session/ses_1/question/q_1/reply",
      "/api/session/ses_1/question/q_1/reject",
    ])
  })

  test("routes V1-protocol slash commands through the V2 session prompt endpoint", async () => {
    const { api, requests } = setup("v1")
    await api.session.command({ sessionID: "ses_1", command: "review", arguments: "src" })

    expect(requests.some((request) => new URL(request.url).pathname === "/session/ses_1/command")).toBe(false)
    const prompt = requests.find((request) => new URL(request.url).pathname.endsWith("/prompt"))
    expect(prompt).toBeDefined()
    expect(await prompt!.json()).toMatchObject({
      prompt: { text: "Review src" },
    })
  })

  test("keeps V1-protocol shell on the legacy session endpoint", async () => {
    const { api, requests } = setup("v1")
    await api.session.shell({ sessionID: "ses_1", command: "ls" })

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual(["/session/ses_1/shell"])
  })

  test("disposes the V1 instance after connecting a provider", async () => {
    const { api, requests } = setup("v1")

    await api.integration.connect.key({
      integrationID: "openrouter",
      key: "secret",
      location: { directory: "/repo" },
    })

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/auth/openrouter",
      "/api/integration/openrouter/connect/key",
      "/instance/dispose",
      "/instance/dispose",
    ])
    expect(requests[2]!.headers.get("x-opencode-directory")).toBe("%2Frepo")
    expect(requests[3]!.headers.get("x-opencode-directory")).toBeNull()
  })

  test("disposes the V1 instance after completing provider OAuth", async () => {
    const { api, requests } = setup("v1")

    await api.integration.oauth.complete({
      integrationID: "openrouter",
      attemptID: "openrouter:0",
      code: "code",
      location: { directory: "/repo" },
    })

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/provider/openrouter/oauth/callback",
      "/instance/dispose",
      "/instance/dispose",
    ])
    expect(requests[1]!.headers.get("x-opencode-directory")).toBe("%2Frepo")
    expect(requests[2]!.headers.get("x-opencode-directory")).toBeNull()
  })
})
