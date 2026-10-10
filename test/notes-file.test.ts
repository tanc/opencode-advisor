import { describe, expect, test, afterAll } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { appendNote, notesFilePath, clearNotes, NOTES_FILE_MAX_LINES, NOTES_KEEP_LINES, type NotesEntry } from "../plugin/notes-file.ts"

const base = await mkdtemp(path.join(os.tmpdir(), "advisor-notes-"))
const directory = "/some/project"

function entry(over: Partial<NotesEntry> = {}): NotesEntry {
  return { t: 1_700_000_000_000, sessionID: "s1", advisor: "Advisor", severity: "concern", note: "a note", ...over }
}

describe("appendNote", () => {
  test("creates the notes file and appends one JSONL line", () => {
    appendNote(base, directory, entry())
    const p = notesFilePath(base, directory)
    expect(existsSync(p)).toBe(true)
    const line = JSON.parse(readFileSync(p, "utf8").trim())
    expect(line.sessionID).toBe("s1")
    expect(line.severity).toBe("concern")
    expect(line.note).toBe("a note")
  })

  test("one line per note, newest last", () => {
    appendNote(base, directory, entry({ note: "second", t: 1_700_000_000_001 }))
    const lines = readFileSync(notesFilePath(base, directory), "utf8").trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[1]!).note).toBe("second")
  })

  test("the file name is the claim key of the directory, so two projects do not collide", () => {
    appendNote(base, "/other/project", entry({ sessionID: "s2" }))
    expect(notesFilePath(base, "/some/project")).not.toBe(notesFilePath(base, "/other/project"))
    expect(readFileSync(notesFilePath(base, "/other/project"), "utf8")).toContain("s2")
  })

  test("prunes to the last lines past the cap, keeping the newest", () => {
    const big = base + "-prune"
    try {
      for (let i = 0; i < NOTES_FILE_MAX_LINES + 10; i++) appendNote(big, directory, entry({ note: `n${i}` }))
      const lines = readFileSync(notesFilePath(big, directory), "utf8").trim().split("\n")
      // Pruning runs per append: the cap is never exceeded and the tail survives.
      expect(lines.length).toBeLessThanOrEqual(NOTES_FILE_MAX_LINES)
      expect(lines.length).toBeGreaterThanOrEqual(NOTES_KEEP_LINES)
      expect(JSON.parse(lines.at(-1)!).note).toBe(`n${NOTES_FILE_MAX_LINES + 9}`)
      expect(lines[0]!).not.toContain('"n0"')
    } finally {
      clearNotes(big)
    }
  })

  test("fails open: an unwritable base breaks nothing", () => {
    const blocker = base + "-file"
    writeFileSync(blocker, "not a directory")
    // Must not throw, even though every path below the base fails.
    appendNote(blocker, directory, entry())
    expect(existsSync(notesFilePath(blocker, directory))).toBe(false)
  })

  test("a corrupt file does not wedge appends (prune skips on unreadable)", () => {
    const p = notesFilePath(base, "/corrupt/project")
    mkdirSync(p, { recursive: true })
    // A directory where the JSONL file should be: readFileSync fails with EISDIR.
    appendNote(base, "/corrupt/project", entry({ note: "after corruption" }))
    // Still did not throw; the (now-directory) path simply cannot hold lines.
  })

  test("clearNotes removes the directory", async () => {
    const gone = base + "-gone"
    appendNote(gone, directory, entry())
    clearNotes(gone)
    expect(existsSync(notesFilePath(gone, directory))).toBe(false)
  })
})

afterAll(async () => {
  await rm(base, { recursive: true, force: true })
})

import { writeStatus, statusFilePath } from "../plugin/notes-file.ts"

describe("writeStatus", () => {
  test("writes the latest card per directory, atomically replacing the old one", () => {
    writeStatus(base, { t: 1, sessionID: "s1", directory, body: "first" })
    writeStatus(base, { t: 2, sessionID: "s1", directory, body: "second" })
    const raw = readFileSync(statusFilePath(base, directory), "utf8")
    const parsed = JSON.parse(raw)
    expect(parsed.body).toBe("second")
    expect(parsed.directory).toBe(directory)
    // No temp files left behind.
    expect(existsSync(`${statusFilePath(base, directory)}.${process.pid}.tmp`)).toBe(false)
  })

  test("per-directory keys do not collide", () => {
    writeStatus(base, { t: 3, sessionID: "s2", directory: "/other/project", body: "other" })
    expect(JSON.parse(readFileSync(statusFilePath(base, "/some/project"), "utf8")).body).toBe("second")
    expect(JSON.parse(readFileSync(statusFilePath(base, "/other/project"), "utf8")).body).toBe("other")
  })

  test("fails open on an unwritable base", () => {
    expect(() => writeStatus(base + "-file", { t: 4, sessionID: "s1", directory, body: "x" })).not.toThrow()
  })
})
