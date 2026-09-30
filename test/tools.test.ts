import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { runGlob, runGrep, runRead, runTool } from "../plugin/tools.ts"

let root: string

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "advisor-tools-"))
  await fs.mkdir(path.join(root, "src"), { recursive: true })
  await fs.writeFile(path.join(root, "src", "a.ts"), "export const alpha = 1\n// beta marker\n")
  await fs.writeFile(path.join(root, "src", "b.ts"), "export const beta = 2\n")
  await fs.writeFile(path.join(root, "README.md"), "# docs\n")
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe("read", () => {
  test("returns numbered lines", async () => {
    const out = await runRead(root, { path: "src/a.ts" })
    expect(out.isError).toBeFalsy()
    expect(out.text).toContain("1: export const alpha = 1")
  })

  test("honours offset and limit", async () => {
    const out = await runRead(root, { path: "src/a.ts", offset: 2, limit: 1 })
    expect(out.text).toContain("2: // beta marker")
    expect(out.text).not.toContain("1: export")
  })

  test("rejects paths escaping the project", async () => {
    const out = await runRead(root, { path: "../../etc/passwd" })
    expect(out.isError).toBe(true)
  })

  test("reports missing files", async () => {
    expect((await runRead(root, { path: "nope.ts" })).isError).toBe(true)
  })
})

describe("grep", () => {
  test("finds matches across the tree", async () => {
    const out = await runGrep(root, { pattern: "beta" })
    expect(out.text).toContain("src/a.ts:2")
    expect(out.text).toContain("src/b.ts:1")
  })

  test("scopes to a path and glob", async () => {
    const out = await runGrep(root, { pattern: "beta", path: "src", glob: "b.ts" })
    expect(out.text).toContain("src/b.ts:1")
    expect(out.text).not.toContain("src/a.ts")
  })

  test("reports no matches", async () => {
    expect((await runGrep(root, { pattern: "zzz_nope_zzz" })).text).toContain("no matches")
  })

  test("reports an invalid pattern", async () => {
    const out = await runGrep(root, { pattern: "(" })
    expect(out.isError).toBe(true)
  })
})

describe("glob", () => {
  test("matches by pattern", async () => {
    const out = await runGlob(root, { pattern: "src/**/*.ts" })
    expect(out.text).toContain("src/a.ts")
    expect(out.text).toContain("src/b.ts")
    expect(out.text).not.toContain("README.md")
  })
})

describe("runTool", () => {
  test("denies tools that were not granted", async () => {
    const out = await runTool(root, "grep", { pattern: "beta" }, [])
    expect(out.isError).toBe(true)
    expect(out.text).toContain("not granted")
  })

  test("dispatches granted tools", async () => {
    const out = await runTool(root, "read", { path: "README.md" }, ["read"])
    expect(out.text).toContain("# docs")
  })
})
