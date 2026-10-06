import { describe, expect, test } from "bun:test"
import { stamp } from "../plugin/format.ts"

const at = (iso: string) => new Date(iso).getTime()

describe("stamp", () => {
  test("shows only the time for a moment on the current day", () => {
    const now = at("2026-10-06T09:12:22")
    const earlier = at("2026-10-06T08:30:00")
    expect(stamp(earlier, now)).toBe(new Date(earlier).toLocaleTimeString())
    expect(stamp(earlier, now)).not.toContain(String(new Date(earlier).getFullYear()))
  })

  test("shows the date when the moment is from another day", () => {
    const now = at("2026-10-06T09:12:22")
    const yesterday = at("2026-10-05T12:53:29")
    expect(stamp(yesterday, now)).toBe(new Date(yesterday).toLocaleString())
    expect(stamp(yesterday, now)).toContain(String(new Date(yesterday).getFullYear()))
  })

  test("treats a future same-day moment as today", () => {
    const now = at("2026-10-06T09:00:00")
    const later = at("2026-10-06T17:00:00")
    expect(stamp(later, now)).toBe(new Date(later).toLocaleTimeString())
  })
})
