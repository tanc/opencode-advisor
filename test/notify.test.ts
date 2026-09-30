import { describe, expect, test } from "bun:test"
import { notificationBases } from "../plugin/index.ts"

describe("OpenChamber notification base", () => {
  test("the managed agent-tool URL yields the origin", () => {
    const bases = notificationBases("http://127.0.0.1:41999/api/openchamber/agent-tool")
    expect(bases?.base).toBe("http://127.0.0.1:41999")
  })

  test("keeps a path prefix ahead of the agent-tool suffix", () => {
    const bases = notificationBases("https://host.tld/api/spaces/abcdef123456/api/openchamber/agent-tool")
    expect(bases?.base).toBe("https://host.tld/api/spaces/abcdef123456")
    expect(bases?.origin).toBe("https://host.tld")
  })

  test("falls back to the origin for an unexpected shape", () => {
    const bases = notificationBases("http://host:1234/some/other/path")
    expect(bases?.base).toBe("http://host:1234")
  })

  test("a non-URL yields nothing", () => {
    expect(notificationBases("not a url")).toBeUndefined()
  })
})
