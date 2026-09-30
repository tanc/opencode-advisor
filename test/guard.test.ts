import { describe, expect, test } from "bun:test"
import { EmissionGuard, normalizeNote, resolveChannel, severityRank } from "../plugin/guard.ts"

describe("normalizeNote", () => {
  test("folds punctuation, case and whitespace", () => {
    expect(normalizeNote("  Stop. ")).toBe("stop")
    expect(normalizeNote("*Stop*")).toBe("stop")
    expect(normalizeNote("No issue; continue.")).toBe("no issue continue")
  })
})

describe("EmissionGuard", () => {
  test("suppresses empty and content-free notes", () => {
    const guard = new EmissionGuard()
    expect(guard.admit("   ", { rank: 1, pending: false })).toEqual({ accepted: false, reason: "empty" })
    expect(guard.admit("Stop.", { rank: 1, pending: false })).toEqual({ accepted: false, reason: "noise" })
    expect(guard.admit("LGTM", { rank: 1, pending: false }).accepted).toBe(false)
  })

  test("drops an equal or lower-severity duplicate but admits an escalation", () => {
    const guard = new EmissionGuard()
    expect(guard.admit("Missing await on end()", { rank: 1, pending: false }).accepted).toBe(true)
    expect(guard.admit("missing await on end", { rank: 1, pending: false })).toEqual({ accepted: false, reason: "duplicate" })
    expect(guard.admit("missing await on end", { rank: 2, pending: false }).accepted).toBe(true)
    expect(guard.admit("missing await on end", { rank: 2, pending: false }).accepted).toBe(false)
  })

  test("enforces the per-update non-blocker budget", () => {
    const guard = new EmissionGuard({ budgetPerUpdate: 2 })
    guard.beginUpdate()
    expect(guard.admit("first", { rank: 1, pending: false }).accepted).toBe(true)
    expect(guard.admit("second", { rank: 1, pending: false }).accepted).toBe(true)
    expect(guard.admit("third", { rank: 1, pending: false })).toEqual({ accepted: false, reason: "rate-limit" })
  })

  test("a higher-severity pending note displaces a lower one", () => {
    const guard = new EmissionGuard({ budgetPerUpdate: 1 })
    guard.beginUpdate()
    expect(guard.admit("cleanup idea", { rank: 1, pending: true }).accepted).toBe(true)
    const displaced = guard.admit("material risk", { rank: 2, pending: true })
    expect(displaced).toEqual({ accepted: true, displacedKey: "cleanup idea" })
  })

  test("blockers are exempt from the budget", () => {
    const guard = new EmissionGuard({ budgetPerUpdate: 1 })
    guard.beginUpdate()
    guard.admit("first nit", { rank: 1, pending: false })
    expect(guard.admit("real blocker", { rank: 3, pending: false }).accepted).toBe(true)
  })

  test("beginUpdate clears the budget but keeps dedupe history", () => {
    const guard = new EmissionGuard({ budgetPerUpdate: 1 })
    guard.beginUpdate()
    guard.admit("one", { rank: 1, pending: false })
    guard.beginUpdate()
    expect(guard.admit("two", { rank: 1, pending: false }).accepted).toBe(true)
    expect(guard.admit("one", { rank: 1, pending: false }).accepted).toBe(false)
  })

  test("reset clears everything", () => {
    const guard = new EmissionGuard()
    guard.admit("something", { rank: 1, pending: false })
    guard.reset()
    expect(guard.admit("something", { rank: 1, pending: false }).accepted).toBe(true)
  })
})

describe("resolveChannel", () => {
  const base = {
    streaming: true,
    interruptImmuneTurnActive: false,
  }

  test("the reviewer never starts a turn", () => {
    for (const severity of ["blocker", "concern", "nit", undefined] as const) {
      expect(resolveChannel({ ...base, streaming: false, severity })).toBe("preserve")
    }
  })

  test("a running turn takes notes without restarting it", () => {
    expect(resolveChannel({ ...base, severity: "concern" })).toBe("steer")
    expect(resolveChannel({ ...base, severity: "blocker" })).toBe("steer")
    expect(resolveChannel({ ...base, severity: "nit" })).toBe("queue")
    expect(resolveChannel({ ...base, severity: undefined })).toBe("queue")
  })

  test("the immune window downgrades concerns but not blockers", () => {
    expect(resolveChannel({ ...base, severity: "concern", interruptImmuneTurnActive: true })).toBe("queue")
    expect(resolveChannel({ ...base, severity: "blocker", interruptImmuneTurnActive: true })).toBe("steer")
  })
})

describe("severityRank", () => {
  test("omitted severity is a nit", () => {
    expect(severityRank(undefined)).toBe(1)
    expect(severityRank("blocker")).toBe(3)
  })
})
