/**
 * The notes bridge between the advisor and OpenChamber extensions.
 *
 * OpenChamber never renders plugin synthetics in its timeline, but its extension
 * SDK lets a panel read files: relative to the open project with the `files`
 * capability, or `~/…` paths matching the extension's declared `filesystem`
 * globs. The advisor writes each delivered note as one JSONL line under
 * `~/.cache/opencode-advisor/notes/`, and the companion panel
 * (opencode-advisor-panel) declares that glob and renders the current session's
 * notes — the only rendered surface advisor output has.
 *
 * The file name is `claimKey(directory)` — the same sha1-12 the claims use — so
 * the panel can compute it from the session's directory with WebCrypto and needs
 * no lookup. Appends fail open: a broken notes directory must never break note
 * delivery. The file is pruned to its last NOTES_FILE_MAX_LINES lines on write.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { claimKey } from "./claims.ts"

export const NOTES_FILE_MAX_LINES = 400
export const NOTES_KEEP_LINES = 300
/** Where the notes bridge lives by default — the claims directory's parent. */
export const NOTES_BASE = join(homedir(), ".cache", "opencode-advisor")

export function notesDir(base: string): string {
  return join(base, "notes")
}

export function notesFilePath(base: string, directory: string): string {
  return join(notesDir(base), `${claimKey(directory)}.jsonl`)
}

export interface NotesEntry {
  /** When the note was delivered (epoch ms). */
  t: number
  sessionID: string
  advisor: string
  severity: string
  note: string
  instance?: string
}

/** Append one delivered note; create the directory and prune on the way. Never throws. */
export function appendNote(base: string, directory: string, entry: NotesEntry): void {
  try {
    const dir = notesDir(base)
    mkdirSync(dir, { recursive: true })
    const path = notesFilePath(base, directory)
    appendFileSync(path, JSON.stringify(entry) + "\n")
    prune(path)
  } catch {
    // A notes file the panel cannot read is a panel with nothing to show —
    // never a reason to break note delivery.
  }
}

function prune(path: string): void {
  try {
    const raw = readFileSync(path, "utf8")
    const lines = raw.split("\n").filter((l) => l.trim() !== "")
    if (lines.length <= NOTES_FILE_MAX_LINES) return
    const kept = lines.slice(-NOTES_KEEP_LINES)
    writeFileSync(path, kept.join("\n") + "\n")
  } catch {
    // Unreadable or absent: skip pruning. The file still works for appends, and
    // deleting on a transient read error would destroy the panel's only data.
  }
}

/** Remove every notes file — used by tests. */
export function clearNotes(base: string): void {
  try {
    rmSync(notesDir(base), { recursive: true, force: true })
  } catch {
    // ignore
  }
}

export function statusFilePath(base: string, directory: string): string {
  return join(join(base, "status"), `${claimKey(directory)}.json`)
}

export interface StatusEntry {
  /** When the card was generated (epoch ms). */
  t: number
  sessionID: string
  directory: string
  body: string
  instance?: string
}

/**
 * Publish the latest command reply (e.g. /advisor status) as one JSON file the
 * OpenChamber panel renders as a pinned card. Overwritten per directory — it is
 * a "latest state" card, not a log. Fail-open, like the notes bridge.
 */
export function writeStatus(base: string, entry: StatusEntry): void {
  try {
    const dir = join(base, "status")
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${claimKey(entry.directory)}.json`)
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(entry))
    // Rename is atomic on POSIX and replaces the destination outright — no
    // unlink first, which would open a window where the panel sees no file.
    renameSync(tmp, path)
  } catch {
    // A status file the panel cannot read is a panel without the card — never
    // a reason to break the command.
  }
}
