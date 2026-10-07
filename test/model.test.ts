import { describe, expect, test } from "bun:test"
import { matchModel, matchWithRefresh, parseSelector } from "../plugin/model.ts"

const registry = [
  { providerID: "opencode-go", id: "glm-5.3-flash", modelID: "glm-5.3-flash" },
  { providerID: "opencode-go", id: "glm-5.3", modelID: "glm-5.3" },
  { providerID: "minimax", id: "MiniMax-M3", modelID: "MiniMax-M3" },
  { providerID: "openrouter", id: "z-ai/glm-5.3-flash", modelID: "z-ai/glm-5.3-flash" },
]

describe("parseSelector", () => {
  test("splits provider, model and variant on the first slash", () => {
    expect(parseSelector("openrouter/z-ai/glm-5.3-flash#thinking")).toEqual({
      providerID: "openrouter",
      id: "z-ai/glm-5.3-flash",
      variant: "thinking",
    })
  })

  test("rejects a selector with no model half", () => {
    expect(parseSelector("minimax")).toBeUndefined()
    expect(parseSelector("minimax/")).toBeUndefined()
  })
})

describe("matchModel", () => {
  test("returns the registry's canonical model", () => {
    expect(matchModel(registry, "minimax/MiniMax-M3").model).toEqual({ providerID: "minimax", id: "MiniMax-M3", variant: undefined })
  })

  test("matches case-insensitively and answers with the id, not the display name", () => {
    // The exact bug this exists for: pickers show "GLM-5.3-Flash" while the id is lowercase.
    const match = matchModel(registry, "opencode-go/GLM-5.3-Flash")
    expect(match.warning).toBeUndefined()
    expect(match.model).toEqual({ providerID: "opencode-go", id: "glm-5.3-flash", variant: undefined })
  })

  test("keeps the variant through a case-insensitive match", () => {
    expect(matchModel(registry, "MINIMAX/minimax-m3#thinking").model).toEqual({
      providerID: "minimax",
      id: "MiniMax-M3",
      variant: "thinking",
    })
  })

  test("explains an unknown provider and lists what there is", () => {
    const { model, warning } = matchModel(registry, "opencode-go-typo/glm-5.3-flash")
    expect(model).toBeUndefined()
    expect(warning).toContain("no provider")
    expect(warning).toContain("minimax")
  })

  test("explains an unknown model inside a known provider", () => {
    const { model, warning } = matchModel(registry, "opencode-go/glm-9")
    expect(model).toBeUndefined()
    expect(warning).toContain("not in provider")
    expect(warning).toContain("glm-5.3-flash")
  })

  test("explains an invalid selector", () => {
    expect(matchModel(registry, "nonsense").warning).toContain("not a valid selector")
  })
})

describe("matchWithRefresh", () => {
  const cold = [{ providerID: "opencode-go", id: "glm-5.3-flash", modelID: "glm-5.3-flash" }]
  const warm = [...cold, { providerID: "bifrost", id: "glm_5_3_flash_bf", modelID: "glm_5_3_flash_bf" }]
  const noSleep = async () => {}

  test("does not refresh when the first lookup matches", async () => {
    let refreshes = 0
    const { match } = await matchWithRefresh(
      "opencode-go/glm-5.3-flash",
      async () => cold,
      async () => {
        refreshes += 1
      },
      { sleep: noSleep },
    )
    expect(match.model).toEqual({ providerID: "opencode-go", id: "glm-5.3-flash", variant: undefined })
    expect(refreshes).toBe(0)
  })

  test("refreshes and looks again when a provider has not been discovered yet", async () => {
    // The bug this exists for: on a cold registry the selector missed, so
    // resolution fell through to the location default instead of retrying.
    let refreshes = 0
    let discovered = false
    const { match } = await matchWithRefresh(
      "bifrost/glm_5_3_flash_bf",
      async () => (discovered ? warm : cold),
      async () => {
        refreshes += 1
        discovered = true
      },
      { sleep: noSleep },
    )
    expect(refreshes).toBe(1)
    expect(match.model).toEqual({ providerID: "bifrost", id: "glm_5_3_flash_bf", variant: undefined })
  })

  test("stops after the lookup budget and reports why", async () => {
    let refreshes = 0
    const { available, match } = await matchWithRefresh(
      "bifrost/glm_5_3_flash_bf",
      async () => cold,
      async () => {
        refreshes += 1
      },
      { sleep: noSleep },
    )
    expect(refreshes).toBe(1) // attempts: 2 => exactly one refresh
    expect(match.model).toBeUndefined()
    expect(match.warning).toContain('no provider "bifrost"')
    expect(available).toEqual(cold)
  })

  test("keeps the last lookup when a refresh fails", async () => {
    const errors: unknown[] = []
    const { match } = await matchWithRefresh(
      "bifrost/glm_5_3_flash_bf",
      async () => cold,
      async () => {
        throw new Error("registry down")
      },
      { sleep: noSleep, onRefreshError: (error) => errors.push(error) },
    )
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe("registry down")
    expect(match.model).toBeUndefined()
  })

  test("honours attempts: 1 by not refreshing at all", async () => {
    let refreshes = 0
    await matchWithRefresh(
      "bifrost/glm_5_3_flash_bf",
      async () => cold,
      async () => {
        refreshes += 1
      },
      { attempts: 1, sleep: noSleep },
    )
    expect(refreshes).toBe(0)
  })
})
