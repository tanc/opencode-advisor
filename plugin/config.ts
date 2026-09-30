/**
 * Configuration for the advisor plugin.
 *
 * Two layers, mirroring omp:
 *
 * 1. Plugin options (`ctx.options`) and environment variables — the runtime
 *    knobs (enabled, default model, syncBacklog, immuneTurns, ...).
 * 2. `WATCHDOG.md` / `WATCHDOG.{yml,yaml}` discovered on disk — advisor-only
 *    review guidance and an optional roster of specialist advisors.
 *
 * The discovery path follows OpenCode's own config convention: a user-level file
 * in the OpenCode config directory, plus `WATCHDOG.*` and `.opencode/WATCHDOG.*`
 * from the working directory up to the repository root (or the home directory
 * when there is no repository).
 */
import { execFile } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"
import { parse as parseYaml } from "yaml"

const execFileAsync = promisify(execFile)

/** Runtime options accepted from `ctx.options` (OpenChamber renders these as a card). */
export interface AdvisorOptions {
  /** Master switch. Default false — the advisor costs its own model requests. */
  enabled?: boolean
  /** Default model selector (`provider/model` or `provider/model#variant`). */
  model?: string
  /** Inline roster. When present it replaces the on-disk roster. */
  advisors?: AdvisorEntry[]
  /** Shared instructions prepended to every advisor's system prompt. */
  instructions?: string
  /** Default investigative tools. Omitted → `read`, `grep`, `glob`; `[]` → none. */
  tools?: string[]
  /** Max non-blocker notes accepted per review. Default 4. */
  maxNotesPerUpdate?: number
  /**
   * Bounded catch-up: pause the primary for up to 30s when the advisor has at
   * least this many unreviewed turns behind it. `off` (default) never waits.
   */
  syncBacklog?: "off" | "1" | "3" | "5" | number
  /** Turns after an interrupting note during which further notes do not steer. Default 3. */
  immuneTurns?: number
  /** Include assistant reasoning in the transcript shown to the advisor. Default true. */
  includeThinking?: boolean
  /** Discover `WATCHDOG.*` files on disk. Default true. */
  discover?: boolean
  /** Max tool rounds per review. Default 6. */
  maxToolRounds?: number
  /** Max characters of transcript sent per review. Default 60000. */
  maxTranscriptChars?: number
}

/** One roster entry (inline option or a `advisors[]` list item in `WATCHDOG.yml`). */
export interface AdvisorEntry {
  name: string
  model?: string
  enabled?: boolean
  tools?: string[]
  instructions?: string
  maxNotesPerUpdate?: number
}

/** A fully resolved advisor. */
export interface AdvisorSpec {
  name: string
  slug: string
  /** Explicit model selector; undefined falls back to the plugin default. */
  model?: string
  /** undefined → default subset; [] → no investigative tools. */
  tools?: string[]
  instructions?: string
  enabled: boolean
  maxNotesPerUpdate?: number
}

/** Resolved plugin configuration. */
export interface AdvisorConfig {
  enabled: boolean
  model?: string
  advisors: AdvisorSpec[]
  sharedInstructions?: string
  sharedMaxNotesPerUpdate?: number
  syncBacklog: 0 | 1 | 3 | 5
  immuneTurns: number
  includeThinking: boolean
  maxToolRounds: number
  maxTranscriptChars: number
  /** Blocks appended to every advisor system prompt (WATCHDOG.md content). */
  watchdogBlocks: string[]
  warnings: string[]
}

export const DEFAULT_TOOLS = ["read", "grep", "glob"] as const

const truthy = /^(1|true|yes|on)$/i

function envBool(name: string): boolean | undefined {
  const v = process.env[name]
  return v === undefined ? undefined : truthy.test(v)
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

function bool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value
  if (typeof value === "string") return truthy.test(value)
  return undefined
}

function parseSyncBacklog(value: unknown): 0 | 1 | 3 | 5 | undefined {
  if (value === undefined || value === null) return undefined
  const s = String(value).trim().toLowerCase()
  if (s === "off" || s === "0" || s === "false" || s === "none") return 0
  if (s === "1" || s === "3" || s === "5") return Number(s) as 1 | 3 | 5
  return undefined
}

/** Normalize an advisor name into a stable id/filesystem-safe slug. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug || "advisor"
}

/** Split `provider/model#variant` (variant optional) into a model reference. */
export function parseModelSelector(selector: string): { providerID: string; id: string; variant?: string } | undefined {
  const trimmed = selector.trim()
  if (!trimmed) return undefined
  const hash = trimmed.indexOf("#")
  const base = hash === -1 ? trimmed : trimmed.slice(0, hash)
  const variant = hash === -1 ? undefined : trimmed.slice(hash + 1).trim() || undefined
  const slash = base.indexOf("/")
  if (slash <= 0 || slash === base.length - 1) return undefined
  return { providerID: base.slice(0, slash).trim(), id: base.slice(slash + 1).trim(), variant }
}

/**
 * Resolve plugin options + environment into a config. The roster is only
 * validated here; on-disk discovery happens in {@link discoverAdvisorConfig}
 * and is merged by {@link resolveConfig}.
 */
export function resolveOptions(options: AdvisorOptions): Omit<AdvisorConfig, "advisors" | "watchdogBlocks" | "warnings"> & {
  configuredAdvisors: AdvisorEntry[] | undefined
  discover: boolean
  tools: string[] | undefined
} {
  const enabled = bool(options.enabled) ?? envBool("ADVISOR_ENABLED") ?? false
  const model = (options.model ?? process.env.ADVISOR_MODEL)?.trim() || undefined
  const maxNotesPerUpdate = num(options.maxNotesPerUpdate) ?? num(process.env.ADVISOR_MAX_NOTES)

  const sharedInstructions = options.instructions?.trim() || process.env.ADVISOR_INSTRUCTIONS?.trim() || undefined
  const configuredAdvisors = Array.isArray(options.advisors) ? options.advisors : undefined

  const tools = Array.isArray(options.tools) ? options.tools.map(String) : undefined

  return {
    enabled,
    model,
    sharedInstructions,
    sharedMaxNotesPerUpdate: maxNotesPerUpdate,
    syncBacklog: parseSyncBacklog(options.syncBacklog ?? process.env.ADVISOR_SYNC_BACKLOG) ?? 0,
    immuneTurns: Math.max(0, num(options.immuneTurns ?? process.env.ADVISOR_IMMUNE_TURNS) ?? 3),
    includeThinking: bool(options.includeThinking) ?? envBool("ADVISOR_INCLUDE_THINKING") ?? true,
    maxToolRounds: Math.max(0, num(options.maxToolRounds) ?? 6),
    maxTranscriptChars: Math.max(2_000, num(options.maxTranscriptChars) ?? 60_000),
    discover: bool(options.discover) ?? envBool("ADVISOR_DISCOVER") ?? true,
    configuredAdvisors,
    tools,
  }
}

/* ------------------------------------------------------------------ *
 * WATCHDOG discovery
 * ------------------------------------------------------------------ */

export interface ConfigFileCandidate {
  path: string
  content: string
  level: "user" | "project"
  depth: number
}

/** OpenCode's global config directory (`$XDG_CONFIG_HOME/opencode` by default). */
export function opencodeConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim()
  return xdg ? path.join(xdg, "opencode") : path.join(os.homedir(), ".config", "opencode")
}

async function gitRoot(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeout: 3000 })
    const root = stdout.trim()
    return root || undefined
  } catch {
    // Fall back to a filesystem walk so a missing git binary or a repo-less
    // directory still bounds discovery at the user's home.
    let current = path.resolve(cwd)
    while (true) {
      try {
        await fs.access(path.join(current, ".git"))
        return current
      } catch {
        const parent = path.dirname(current)
        if (parent === current) return undefined
        current = parent
      }
    }
  }
}

/**
 * Collect readable config candidates on the discovery path: the user config dir
 * plus every directory from `cwd` up to the repo root (or home), probing both
 * `<dir>/<name>` and `<dir>/.opencode/<name>`.
 */
export async function collectConfigCandidates(
  cwd: string,
  configDir: string,
  filenames: string[],
): Promise<ConfigFileCandidate[]> {
  const home = os.homedir()
  const stop = (await gitRoot(cwd)) ?? home
  const resolvedCwd = path.resolve(cwd)

  const seen = new Map<string, ConfigFileCandidate>()
  const add = async (file: string, level: "user" | "project", depth: number) => {
    const key = path.resolve(file)
    if (seen.has(key)) return
    try {
      const content = await fs.readFile(key, "utf8")
      seen.set(key, { path: key, content, level, depth })
    } catch {
      // unreadable / missing — skip
    }
  }

  for (const name of filenames) {
    await add(path.join(configDir, name), "user", -1)
  }

  let current = resolvedCwd
  while (true) {
    const relative = path.relative(resolvedCwd, current)
    const depth = relative === "" ? 0 : relative.split(path.sep).filter(Boolean).length
    for (const name of filenames) {
      await add(path.join(current, name), "project", depth)
      await add(path.join(current, ".opencode", name), "project", depth)
    }
    if (current === stop) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }

  // User first, then ancestors → leaf (so the leaf is most prominent/last).
  return [...seen.values()].sort((a, b) => {
    if (a.level !== b.level) return a.level === "user" ? -1 : 1
    return b.depth - a.depth
  })
}

/** Expand whole-line `@relative/path` imports, leaving fenced/inline code literal. */
export async function expandAtImports(content: string, sourcePath: string, seen = new Set<string>()): Promise<string> {
  const lines = content.split("\n")
  const out: string[] = []
  let fence: string | undefined
  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(```|~~~)/)
    if (fenceMatch) {
      if (fence === undefined) fence = fenceMatch[1]
      else if (line.trimStart().startsWith(fence)) fence = undefined
      out.push(line)
      continue
    }
    if (fence !== undefined) {
      out.push(line)
      continue
    }
    const importMatch = line.match(/^\s*@(.+?)\s*$/)
    if (!importMatch || importMatch[1].includes("`")) {
      out.push(line)
      continue
    }
    const target = importMatch[1].startsWith("~/")
      ? path.join(os.homedir(), importMatch[1].slice(2))
      : path.resolve(path.dirname(sourcePath), importMatch[1])
    if (seen.has(target)) {
      out.push(line)
      continue
    }
    try {
      const imported = await fs.readFile(target, "utf8")
      seen.add(target)
      out.push(await expandAtImports(imported, target, seen))
    } catch {
      out.push(line)
    }
  }
  return out.join("\n")
}

interface ParsedRoster {
  advisors: AdvisorEntry[]
  sharedInstructions?: string
  sharedMaxNotesPerUpdate?: number
  warnings: string[]
}

// This port implements the read-only investigative set. omp additionally
// allows mutating grants (edit/write/bash/eval); that is deliberately out of
// scope here so a reviewer can never change the repository it is reviewing.
const KNOWN_TOOLS = new Set(["read", "grep", "glob"])
const TOOL_ALIASES: Record<string, string> = { search: "grep", find: "glob" }

/** Keep only known tool names, normalizing legacy aliases. `[]` means "no tools". */
export function filterTools(tools: string[] | undefined, source: string, warn: (m: string) => void): string[] | undefined {
  if (tools === undefined) return undefined
  if (tools.length === 0) return []
  const out: string[] = []
  for (const raw of tools) {
    const name = TOOL_ALIASES[raw] ?? raw
    if (KNOWN_TOOLS.has(name)) {
      if (!out.includes(name)) out.push(name)
    } else {
      warn(`${source}: dropping unknown advisor tool "${raw}"`)
    }
  }
  return out.length > 0 ? out : undefined
}

function parseRoster(content: string, file: string, warn: (m: string) => void): ParsedRoster {
  let doc: unknown
  try {
    doc = parseYaml(content)
  } catch (err) {
    warn(`${file}: failed to parse YAML (${(err as Error).message}) — file skipped`)
    return { advisors: [], warnings: [] }
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    warn(`${file}: expected a YAML mapping — file skipped`)
    return { advisors: [], warnings: [] }
  }
  const record = doc as Record<string, unknown>
  const advisors: AdvisorEntry[] = []
  const entries = Array.isArray(record.advisors) ? record.advisors : []
  if (record.advisors !== undefined && !Array.isArray(record.advisors)) {
    warn(`${file}: advisors must be a list — ignored`)
  }
  for (const [index, raw] of entries.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      warn(`${file}: advisor #${index + 1} dropped — not a mapping`)
      continue
    }
    const entry = raw as Record<string, unknown>
    const name = typeof entry.name === "string" ? entry.name.trim() : ""
    if (!name) {
      warn(`${file}: advisor #${index + 1} dropped — missing name`)
      continue
    }
    const advisor: AdvisorEntry = { name }
    if (typeof entry.model === "string" && entry.model.trim()) advisor.model = entry.model.trim()
    if (typeof entry.instructions === "string" && entry.instructions.trim()) advisor.instructions = entry.instructions
    if (typeof entry.enabled === "boolean") advisor.enabled = entry.enabled
    if (Array.isArray(entry.tools)) {
      advisor.tools = filterTools(entry.tools.map(String), file, warn)
    }
    const maxNotes = num(entry.maxNotesPerUpdate)
    if (maxNotes !== undefined && maxNotes >= 1) advisor.maxNotesPerUpdate = Math.trunc(maxNotes)
    advisors.push(advisor)
  }
  const sharedMax = num(record.maxNotesPerUpdate)
  return {
    advisors,
    sharedInstructions: typeof record.instructions === "string" && record.instructions.trim() ? record.instructions : undefined,
    sharedMaxNotesPerUpdate: sharedMax !== undefined && sharedMax >= 1 ? Math.trunc(sharedMax) : undefined,
    warnings: [],
  }
}

/** Discover `WATCHDOG.md` blocks (expanded) and `WATCHDOG.{yml,yaml}` rosters. */
export async function discoverAdvisorFiles(
  cwd: string,
  configDir: string,
): Promise<{ watchdogBlocks: string[]; advisors: AdvisorEntry[]; sharedInstructions?: string; sharedMaxNotesPerUpdate?: number; warnings: string[] }> {
  const warnings: string[] = []
  const watchdogBlocks: string[] = []

  for (const candidate of await collectConfigCandidates(cwd, configDir, ["WATCHDOG.md"])) {
    const expanded = (await expandAtImports(candidate.content, candidate.path)).trim()
    if (expanded) watchdogBlocks.push(`Especially pay attention to:\n<attention>\n${expanded}\n</attention>`)
  }

  const advisors = new Map<string, AdvisorEntry>()
  const sharedParts: string[] = []
  let sharedMaxNotesPerUpdate: number | undefined

  const rosterCandidates = await collectConfigCandidates(cwd, configDir, ["WATCHDOG.yml", "WATCHDOG.yaml"])
  // Process ancestors first so a more specific (leaf) entry replaces by slug.
  for (const candidate of [...rosterCandidates].reverse()) {
    const parsed = parseRoster(candidate.content, candidate.path, (m) => warnings.push(m))
    warnings.push(...parsed.warnings)
    if (parsed.sharedInstructions) {
      const expanded = (await expandAtImports(parsed.sharedInstructions, candidate.path)).trim()
      if (expanded) sharedParts.push(expanded)
    }
    if (parsed.sharedMaxNotesPerUpdate !== undefined) sharedMaxNotesPerUpdate = parsed.sharedMaxNotesPerUpdate
    for (const entry of parsed.advisors) {
      const slug = slugify(entry.name)
      if (entry.instructions) {
        const expanded = (await expandAtImports(entry.instructions, candidate.path)).trim()
        entry.instructions = expanded || undefined
      }
      advisors.set(slug, entry)
    }
  }

  return {
    watchdogBlocks,
    advisors: [...advisors.values()],
    sharedInstructions: sharedParts.length > 0 ? sharedParts.join("\n\n") : undefined,
    sharedMaxNotesPerUpdate,
    warnings,
  }
}

/**
 * Merge options, environment, and on-disk discovery into one config. With no
 * discovered roster, one default advisor is created from the default model.
 */
export async function resolveConfig(
  options: AdvisorOptions,
  cwd: string,
  configDir = opencodeConfigDir(),
): Promise<AdvisorConfig> {
  const base = resolveOptions(options)
  const warnings: string[] = []

  let discovered: Awaited<ReturnType<typeof discoverAdvisorFiles>> = {
    watchdogBlocks: [],
    advisors: [],
    warnings: [],
  }
  if (base.discover) {
    try {
      discovered = await discoverAdvisorFiles(cwd, configDir)
    } catch (err) {
      warnings.push(`WATCHDOG discovery failed: ${(err as Error).message}`)
    }
  }
  warnings.push(...discovered.warnings)

  const rosterEntries = base.configuredAdvisors ?? discovered.advisors
  const defaultTools = base.tools

  let advisors: AdvisorSpec[]
  if (rosterEntries.length > 0) {
    advisors = rosterEntries.map((entry) => {
      const tools = filterTools(entry.tools !== undefined ? entry.tools : defaultTools, "options", (m) => warnings.push(m))
      return {
        name: entry.name,
        slug: slugify(entry.name),
        model: entry.model?.trim() || undefined,
        tools,
        instructions: entry.instructions?.trim() || undefined,
        enabled: entry.enabled ?? true,
        maxNotesPerUpdate:
          entry.maxNotesPerUpdate !== undefined && entry.maxNotesPerUpdate >= 1
            ? Math.trunc(entry.maxNotesPerUpdate)
            : undefined,
      }
    })
    // De-duplicate slugs (last definition wins, matching discovery precedence).
    const bySlug = new Map<string, AdvisorSpec>()
    for (const advisor of advisors) bySlug.set(advisor.slug, advisor)
    advisors = [...bySlug.values()]
  } else {
    const tools = filterTools(defaultTools, "options", (m) => warnings.push(m))
    advisors = [{ name: "Advisor", slug: "advisor", model: base.model, tools, enabled: true }]
  }

  return {
    enabled: base.enabled,
    model: base.model,
    advisors,
    sharedInstructions: base.sharedInstructions ?? discovered.sharedInstructions,
    sharedMaxNotesPerUpdate: base.sharedMaxNotesPerUpdate ?? discovered.sharedMaxNotesPerUpdate,
    syncBacklog: base.syncBacklog,
    immuneTurns: base.immuneTurns,
    includeThinking: base.includeThinking,
    maxToolRounds: base.maxToolRounds,
    maxTranscriptChars: base.maxTranscriptChars,
    watchdogBlocks: discovered.watchdogBlocks,
    warnings,
  }
}
