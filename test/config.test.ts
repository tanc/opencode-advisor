import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import {
  discoverAdvisorFiles,
  expandAtImports,
  filterTools,
  parseModelSelector,
  resolveConfig,
  slugify,
} from "../plugin/config.ts"

let cwd: string
let configDir: string

beforeAll(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "advisor-cwd-"))
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), "advisor-cfg-"))
  await fs.writeFile(path.join(cwd, "WATCHDOG.md"), "Watch for schema changes without rollout.")
  await fs.writeFile(path.join(cwd, "AGENTS.md"), "Always run the focused test suite before claiming done.")
  await fs.writeFile(
    path.join(cwd, "WATCHDOG.yml"),
    [
      "instructions: |",
      "  Prefer fixes that preserve public APIs.",
      "advisors:",
      "  - name: Architecture",
      "    enabled: true",
      "    model: anthropic/claude-sonnet-4-5#high",
      "    tools: [read, search]",
      "    instructions: |",
      "      Watch module boundaries.",
      "  - name: Disabled One",
      "    enabled: false",
      "    tools: []",
      "",
    ].join("\n"),
  )
  await fs.writeFile(path.join(configDir, "WATCHDOG.md"), "User-level review guidance.")
})

afterAll(async () => {
  await fs.rm(cwd, { recursive: true, force: true })
  await fs.rm(configDir, { recursive: true, force: true })
})

describe("slugify", () => {
  test("normalizes names to slugs", () => {
    expect(slugify("Architecture Review")).toBe("architecture-review")
    expect(slugify("!!!")).toBe("advisor")
  })
})

describe("parseModelSelector", () => {
  test("splits provider, model, and variant", () => {
    expect(parseModelSelector("anthropic/claude-sonnet-4-5#high")).toEqual({
      providerID: "anthropic",
      id: "claude-sonnet-4-5",
      variant: "high",
    })
  })

  test("accepts an id containing slashes", () => {
    expect(parseModelSelector("openrouter/anthropic/claude-3.5")).toEqual({
      providerID: "openrouter",
      id: "anthropic/claude-3.5",
      variant: undefined,
    })
  })

  test("rejects a bare model name", () => {
    expect(parseModelSelector("claude-sonnet")).toBeUndefined()
  })
})

describe("filterTools", () => {
  test("normalizes aliases, drops unknown and dedupes", () => {
    const warnings: string[] = []
    expect(filterTools(["read", "search", "find", "bogus", "read"], "x", (m) => warnings.push(m))).toEqual(["read", "grep", "glob"])
    expect(warnings.some((w) => w.includes("bogus"))).toBe(true)
  })

  test("an explicit empty list means no tools", () => {
    expect(filterTools([], "x", () => {})).toEqual([])
  })
})

describe("expandAtImports", () => {
  test("inlines relative imports but leaves fenced code literal", async () => {
    await fs.writeFile(path.join(cwd, "review.md"), "SECRET CRITERION")
    await fs.writeFile(path.join(cwd, "main.md"), "Before\n@review.md\n```\n@review.md\n```\nAfter")
    const expanded = await expandAtImports(await fs.readFile(path.join(cwd, "main.md"), "utf8"), path.join(cwd, "main.md"))
    expect(expanded).toContain("SECRET CRITERION")
    expect(expanded).toContain("```\n@review.md\n```")
  })
})

describe("discoverAdvisorFiles", () => {
  test("loads watchdog blocks and the roster on the discovery path", async () => {
    const found = await discoverAdvisorFiles(cwd, configDir)
    expect(found.watchdogBlocks.length).toBeGreaterThanOrEqual(2)
    const arch = found.advisors.find((a) => a.name === "Architecture")
    expect(arch).toBeDefined()
    expect(arch?.model).toBe("anthropic/claude-sonnet-4-5#high")
    expect(arch?.tools).toEqual(["read", "grep"])
    expect(arch?.instructions).toContain("module boundaries")
    expect(found.advisors.find((a) => a.name === "Disabled One")?.enabled).toBe(false)
    expect(found.sharedInstructions).toContain("preserve public APIs")
    expect(found.projectContext).toContain("Always run the focused test suite")
  })
})

describe("resolveConfig", () => {
  test("adopts a default advisor when no roster is discovered", async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "advisor-empty-"))
    try {
      const config = await resolveConfig({ enabled: true, model: "p/m" }, empty, empty)
      expect(config.advisors).toHaveLength(1)
      expect(config.advisors[0]!.slug).toBe("advisor")
      expect(config.advisors[0]!.model).toBe("p/m")
      expect(config.model).toBe("p/m")
    } finally {
      await fs.rm(empty, { recursive: true, force: true })
    }
  })

  test("inline options replace the discovered roster and honor the master switch", async () => {
    const config = await resolveConfig(
      { enabled: true, advisors: [{ name: "Inline", tools: [] }], immuneTurns: 5 },
      cwd,
      configDir,
    )
    expect(config.advisors.map((a) => a.name)).toEqual(["Inline"])
    expect(config.advisors[0]!.tools).toEqual([])
    expect(config.immuneTurns).toBe(5)
  })

  test("defaults to disabled", async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "advisor-empty-"))
    try {
      const config = await resolveConfig({}, empty, empty)
      expect(config.enabled).toBe(false)
      expect(config.immuneTurns).toBe(3)
    } finally {
      await fs.rm(empty, { recursive: true, force: true })
    }
  })
})
