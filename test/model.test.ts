import { describe, expect, test } from "bun:test"
import { matchModel, parseSelector } from "../plugin/model.ts"

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
