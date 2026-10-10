import { describe, expect, test } from "bun:test"
import {
  createContextLineHook,
  injectStandingLine,
  STANDING_LINE,
  STANDING_PREFIX,
} from "../plugin/context-line.ts"

describe("injectStandingLine", () => {
  test("adds the line once", () => {
    const system: { type?: string; text?: string }[] = [{ type: "text", text: "base" }]
    expect(injectStandingLine(system)).toBe(true)
    expect(system).toHaveLength(2)
    expect(system[1]!.text).toBe(STANDING_LINE)
  })

  test("is idempotent within a request", () => {
    const system: { type?: string; text?: string }[] = []
    injectStandingLine(system)
    expect(injectStandingLine(system)).toBe(false)
    expect(system).toHaveLength(1)
  })

  test("recognises an already-present line rather than a second copy", () => {
    const system = [{ type: "text", text: `${STANDING_PREFIX} something else entirely` }]
    expect(injectStandingLine(system)).toBe(false)
    expect(system).toHaveLength(1)
  })

  test("survives a host that hands over something other than an array", () => {
    expect(injectStandingLine(undefined)).toBe(false)
    expect(injectStandingLine("nope")).toBe(false)
  })
})

describe("createContextLineHook", () => {
  const draft = () => ({ sessionID: "s1", system: [] as { type?: string; text?: string }[] })

  test("injects for an owner on an active session", () => {
    const hook = createContextLineHook({ isOwner: () => true, isActive: () => true })
    const d = draft()
    hook(d)
    expect(d.system).toHaveLength(1)
  })

  test("stays out when the advisor is off for the session", () => {
    const hook = createContextLineHook({ isOwner: () => true, isActive: () => false })
    const d = draft()
    hook(d)
    expect(d.system).toHaveLength(0)
  })

  test("stays out when another instance owns reviewing", () => {
    const hook = createContextLineHook({ isOwner: () => false, isActive: () => true })
    const d = draft()
    hook(d)
    expect(d.system).toHaveLength(0)
  })

  test("re-reads ownership on the TTL, so a moved claim stops injecting", () => {
    let owner = true
    const hook = createContextLineHook({
      isOwner: () => owner,
      isActive: () => true,
      ownerTtlMs: 0,
    })
    const first = draft()
    hook(first)
    expect(first.system).toHaveLength(1)
    owner = false
    const second = draft()
    hook(second)
    expect(second.system).toHaveLength(0)
  })

  test("a throwing dependency is reported rather than thrown into the host", () => {
    const errors: Error[] = []
    const hook = createContextLineHook({
      isOwner: () => {
        throw new Error("claim file is gone")
      },
      isActive: () => true,
      onError: (err) => errors.push(err),
    })
    const d = draft()
    expect(() => hook(d)).not.toThrow()
    expect(d.system).toHaveLength(0)
    expect(errors[0]!.message).toBe("claim file is gone")
  })
})
