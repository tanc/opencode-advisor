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

  test("injects on an active session", () => {
    const hook = createContextLineHook({ isActive: () => true })
    const d = draft()
    hook(d)
    expect(d.system).toHaveLength(1)
  })

  test("stays out when the advisor is off for the session", () => {
    const hook = createContextLineHook({ isActive: () => false })
    const d = draft()
    hook(d)
    expect(d.system).toHaveLength(0)
  })

  test("every instance may register: two hooks, one draft, still one line", () => {
    const hook = createContextLineHook({ isActive: () => true })
    const d = draft()
    hook(d)
    hook(d)
    expect(d.system).toHaveLength(1)
  })

  test("a throwing dependency is reported rather than thrown into the host", () => {
    const errors: Error[] = []
    const hook = createContextLineHook({
      isActive: () => {
        throw new Error("state is unreadable")
      },
      onError: (err) => errors.push(err),
    })
    const d = draft()
    expect(() => hook(d)).not.toThrow()
    expect(d.system).toHaveLength(0)
    expect(errors[0]!.message).toBe("state is unreadable")
  })
})
