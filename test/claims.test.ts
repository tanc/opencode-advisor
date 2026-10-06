import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { activeClaimCount, claimKey, isClaimOwner, releaseClaim, writeClaim } from "../plugin/claims.ts"

const DEAD_PID = 2147483646

function base(): string {
  return mkdtempSync(join(tmpdir(), "advisor-claims-"))
}

describe("claims", () => {
  test("an instance with no rival owns reviewing", () => {
    const dir = base()
    try {
      writeClaim({ directory: "/repo", instance: "aaaaaa", base: dir })
      expect(isClaimOwner({ directory: "/repo", instance: "aaaaaa", base: dir })).toBe(true)
      expect(activeClaimCount("/repo", dir)).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("the newest live claim wins, so a reload takes over", () => {
    const dir = base()
    try {
      writeClaim({ directory: "/repo", instance: "old111", base: dir, pid: 1 })
      writeClaim({ directory: "/repo", instance: "new222", base: dir })
      expect(isClaimOwner({ directory: "/repo", instance: "old111", base: dir, pid: 1 })).toBe(false)
      expect(isClaimOwner({ directory: "/repo", instance: "new222", base: dir })).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a dead instance's claim is ignored and pruned", () => {
    const dir = base()
    try {
      writeClaim({ directory: "/repo", instance: "ghost1", base: dir, pid: DEAD_PID })
      expect(isClaimOwner({ directory: "/repo", instance: "mine00", base: dir })).toBe(true)
      expect(activeClaimCount("/repo", dir)).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("releasing hands ownership back", () => {
    const dir = base()
    try {
      writeClaim({ directory: "/repo", instance: "mine00", base: dir })
      releaseClaim({ directory: "/repo", base: dir })
      expect(activeClaimCount("/repo", dir)).toBe(0)
      expect(isClaimOwner({ directory: "/repo", instance: "mine00", base: dir })).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("different directories do not collide", () => {
    const dir = base()
    try {
      writeClaim({ directory: "/repo-a", instance: "aaaaaa", base: dir })
      expect(claimKey("/repo-a")).not.toBe(claimKey("/repo-b"))
      expect(activeClaimCount("/repo-b", dir)).toBe(0)
      expect(isClaimOwner({ directory: "/repo-b", instance: "bbbbbb", base: dir })).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("an unusable claim directory fails open", () => {
    // Whatever the reason - permissions, a missing home, a race - the reviewer
    // must keep working rather than silently switching itself off.
    expect(isClaimOwner({ directory: "/repo", instance: "aaaaaa", base: "/proc/definitely-not-writable" })).toBe(true)
  })
})
