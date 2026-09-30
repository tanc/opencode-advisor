/**
 * Read-only investigative tools for the advisor.
 *
 * The advisor verifies claims against the workspace instead of reviewing prose
 * alone (omp's `read`/`grep`/`glob` grant). Everything here is read-only and
 * path-jailed to the project directory: a reviewer must never be able to modify
 * or read outside the repository it is reviewing.
 *
 * `grep`/`glob` prefer ripgrep when installed (fast, respects ignore files) and
 * fall back to a bounded pure-Node walk otherwise.
 */
import { execFile } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export interface ToolOutcome {
  text: string
  isError?: boolean
}

export interface ToolLimits {
  maxReadBytes: number
  maxReadLines: number
  maxMatches: number
  maxFiles: number
  maxOutputChars: number
}

export const DEFAULT_LIMITS: ToolLimits = {
  maxReadBytes: 256 * 1024,
  maxReadLines: 2000,
  maxMatches: 200,
  maxFiles: 4000,
  maxOutputChars: 40_000,
}

const IGNORED_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".cache", "target", "vendor", ".venv", "__pycache__"])

function clip(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`
}

/** Resolve a request path inside `root`; returns undefined when it escapes. */
export function resolveInRoot(root: string, requested: string): string | undefined {
  const base = path.resolve(root)
  const resolved = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(base, requested)
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return undefined
  return resolved
}

let rgPath: string | null | undefined
async function findRg(): Promise<string | null> {
  if (rgPath !== undefined) return rgPath
  const candidates = ["rg", "/home/linuxbrew/.linuxbrew/bin/rg", "/usr/local/bin/rg", "/usr/bin/rg"]
  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, ["--version"], { timeout: 2000 })
      rgPath = candidate
      return candidate
    } catch {
      // try next
    }
  }
  rgPath = null
  return null
}

/* ------------------------------------------------------------------ *
 * read
 * ------------------------------------------------------------------ */

export async function runRead(
  root: string,
  input: { path?: unknown; offset?: unknown; limit?: unknown },
  limits = DEFAULT_LIMITS,
): Promise<ToolOutcome> {
  const requested = typeof input.path === "string" ? input.path : ""
  if (!requested) return { text: "read: `path` is required", isError: true }
  const target = resolveInRoot(root, requested)
  if (!target) return { text: `read: path escapes the project: ${requested}`, isError: true }
  let stat
  try {
    stat = await fs.stat(target)
  } catch {
    return { text: `read: no such file: ${requested}`, isError: true }
  }
  if (stat.isDirectory()) return { text: `read: ${requested} is a directory (use glob)`, isError: true }
  if (stat.size > limits.maxReadBytes * 4) return { text: `read: file too large (${stat.size} bytes)`, isError: true }

  let content: string
  try {
    content = await fs.readFile(target, "utf8")
  } catch (err) {
    return { text: `read: ${(err as Error).message}`, isError: true }
  }
  const lines = content.split("\n")
  const offset = Math.max(1, typeof input.offset === "number" && Number.isFinite(input.offset) ? Math.trunc(input.offset) : 1)
  const limit =
    typeof input.limit === "number" && Number.isFinite(input.limit) ? Math.max(1, Math.trunc(input.limit)) : limits.maxReadLines
  const slice = lines.slice(offset - 1, offset - 1 + Math.min(limit, limits.maxReadLines))
  const numbered = slice.map((line, i) => `${offset + i}: ${line}`)
  const header = `read ${requested} (lines ${offset}-${offset + slice.length - 1} of ${lines.length})`
  return { text: clip(`${header}\n${numbered.join("\n")}`, limits.maxOutputChars) }
}

/* ------------------------------------------------------------------ *
 * glob
 * ------------------------------------------------------------------ */

function globToRegExp(glob: string): RegExp {
  let out = ""
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` matches zero or more directories; a trailing `**` matches anything.
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?"
          i += 2
        } else {
          out += ".*"
          i += 1
        }
      } else {
        out += "[^/]*"
      }
    } else if (c === "?") {
      out += "[^/]"
    } else if ("\\^$.|+()[]{}".includes(c)) {
      out += `\\${c}`
    } else {
      out += c
    }
  }
  return new RegExp(`^${out}$`)
}

async function walk(root: string, maxFiles: number): Promise<string[]> {
  const files: string[] = []
  const stack = [root]
  while (stack.length > 0 && files.length < maxFiles) {
    const dir = stack.pop()!
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) break
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue
        stack.push(full)
      } else if (entry.isFile()) {
        files.push(path.relative(root, full))
      }
    }
  }
  return files
}

export async function runGlob(
  root: string,
  input: { pattern?: unknown },
  limits = DEFAULT_LIMITS,
): Promise<ToolOutcome> {
  const pattern = typeof input.pattern === "string" && input.pattern.trim() ? input.pattern.trim() : ""
  if (!pattern) return { text: "glob: `pattern` is required", isError: true }

  const rg = await findRg()
  if (rg) {
    try {
      const { stdout } = await execFileAsync(rg, ["--files", "--hidden", "--glob", pattern, "--glob", "!.git"], {
        cwd: root,
        timeout: 15_000,
        maxBuffer: 8 * 1024 * 1024,
      })
      const matches = stdout.split("\n").filter(Boolean).slice(0, limits.maxMatches)
      return { text: matches.length ? clip(matches.join("\n"), limits.maxOutputChars) : `glob: no files match ${pattern}` }
    } catch (err) {
      const message = (err as { stdout?: string }).stdout?.trim()
      if (!message) return { text: `glob: ${(err as Error).message}`, isError: true }
    }
  }

  const re = globToRegExp(pattern)
  const files = await walk(root, limits.maxFiles)
  const matches = files.filter((file) => re.test(file) || re.test(`./${file}`)).slice(0, limits.maxMatches)
  return { text: matches.length ? clip(matches.join("\n"), limits.maxOutputChars) : `glob: no files match ${pattern}` }
}

/* ------------------------------------------------------------------ *
 * grep
 * ------------------------------------------------------------------ */

export async function runGrep(
  root: string,
  input: { pattern?: unknown; path?: unknown; glob?: unknown },
  limits = DEFAULT_LIMITS,
): Promise<ToolOutcome> {
  const pattern = typeof input.pattern === "string" ? input.pattern : ""
  if (!pattern) return { text: "grep: `pattern` is required", isError: true }
  const target = resolveInRoot(root, typeof input.path === "string" && input.path.trim() ? input.path.trim() : ".")
  if (!target) return { text: `grep: path escapes the project: ${String(input.path)}`, isError: true }

  const rg = await findRg()
  if (rg) {
    const args = ["--line-number", "--no-heading", "--color", "never", "--max-count", String(limits.maxMatches), "-e", pattern]
    if (typeof input.glob === "string" && input.glob.trim()) args.push("--glob", input.glob.trim())
    args.push(target)
    try {
      const { stdout } = await execFileAsync(rg, args, { cwd: root, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 })
      const text = stdout.trim()
      return { text: text ? clip(text, limits.maxOutputChars) : `grep: no matches for /${pattern}/` }
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string }
      if (e.code === 1) return { text: `grep: no matches for /${pattern}/` }
      if (e.code === 2 || (e.stderr && /regex parse error|unclosed|repetition|look-around|backreference/i.test(e.stderr))) {
        return { text: `grep: invalid pattern: ${(e.stderr ?? "").trim() || pattern}`, isError: true }
      }
      // fall through to the JS implementation on unexpected failures
    }
  }

  let re: RegExp
  try {
    re = new RegExp(pattern)
  } catch (err) {
    return { text: `grep: invalid pattern: ${(err as Error).message}`, isError: true }
  }
  const stat = await fs.stat(target).catch(() => undefined)
  const candidates = stat?.isDirectory() ? await walk(target, limits.maxFiles) : [path.relative(root, target)]
  const base = stat?.isDirectory() ? target : root
  const out: string[] = []
  for (const file of candidates) {
    if (out.length >= limits.maxMatches) break
    const full = path.isAbsolute(file) ? file : path.join(base, file)
    let content: string
    try {
      const buf = await fs.readFile(full)
      if (buf.includes(0)) continue // binary
      content = buf.toString("utf8")
    } catch {
      continue
    }
    const lines = content.split("\n")
    for (let i = 0; i < lines.length && out.length < limits.maxMatches; i++) {
      if (re.test(lines[i]!)) out.push(`${path.relative(root, full)}:${i + 1}: ${lines[i]}`)
    }
  }
  return { text: out.length ? clip(out.join("\n"), limits.maxOutputChars) : `grep: no matches for /${pattern}/` }
}

/** Dispatch one advisor tool request. Unknown/denied tools return an error text. */
export async function runTool(
  root: string,
  tool: string,
  input: Record<string, unknown>,
  granted: readonly string[],
  limits = DEFAULT_LIMITS,
): Promise<ToolOutcome> {
  if (!granted.includes(tool)) {
    return { text: `${tool}: not granted to this advisor (granted: ${granted.join(", ") || "none"})`, isError: true }
  }
  switch (tool) {
    case "read":
      return runRead(root, input, limits)
    case "grep":
      return runGrep(root, input, limits)
    case "glob":
      return runGlob(root, input, limits)
    default:
      return { text: `${tool}: unsupported tool`, isError: true }
  }
}
