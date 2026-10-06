/**
 * Review ownership across processes.
 *
 * Two OpenCode servers can run at once (OpenChamber's managed service and the
 * app's own bundled CLI), and a reload can leave the previous plugin instance
 * alive for a while. Each instance keeps its own session state — its own dedupe
 * history, note budget and immune window — so two live instances review a
 * session twice, one of them possibly on older code.
 *
 * In-memory state cannot coordinate that: it is per module evaluation, so a
 * reloaded instance sees only itself, and another process sees nothing at all.
 * A file can, so each instance writes a claim beside the others and the newest
 * *live* claim owns reviewing for its directory.
 *
 * Everything here fails open. A missing, unreadable or unwritable claim
 * directory means "review anyway": a coordination mechanism that can silently
 * switch the reviewer off is worse than the duplication it prevents.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"

interface Claim {
  pid: number
  instance: string
  startedAt: number
  directory: string
}

const CLAIM_DIR = join(homedir(), ".cache", "opencode-advisor", "claims")

function claimDir(base?: string): string {
  return base ?? CLAIM_DIR
}

/** Stable key for a directory, so its claims never collide with another's. */
export function claimKey(directory: string): string {
  return createHash("sha1").update(directory).digest("hex").slice(0, 12)
}

function claimPath(base: string, key: string, pid: number): string {
  return join(base, `${key}-${pid}.json`)
}

function alive(pid: number): boolean {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Claims for this directory whose process is still alive, newest unusable ones dropped. */
function liveClaims(key: string, base?: string): Claim[] {
  const dir = claimDir(base)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const claims: Claim[] = []
  for (const name of names) {
    if (!name.startsWith(`${key}-`) || !name.endsWith(".json")) continue
    const path = join(dir, name)
    try {
      const claim = JSON.parse(readFileSync(path, "utf8")) as Claim
      if (typeof claim?.pid !== "number" || typeof claim?.startedAt !== "number") throw new Error("malformed")
      if (alive(claim.pid)) claims.push(claim)
      else rmSync(path, { force: true })
    } catch {
      rmSync(path, { force: true })
    }
  }
  return claims
}

/** Record this instance's claim for a directory. */
export function writeClaim(input: { directory: string; instance: string; pid?: number; base?: string }): void {
  const pid = input.pid ?? process.pid
  try {
    mkdirSync(claimDir(input.base), { recursive: true })
    const claim: Claim = { pid, instance: input.instance, startedAt: Date.now(), directory: input.directory }
    writeFileSync(claimPath(claimDir(input.base), claimKey(input.directory), pid), JSON.stringify(claim))
  } catch {
    // fail open: no claim means this instance reviews, as before
  }
}

export function releaseClaim(input: { directory: string; pid?: number; base?: string }): void {
  try {
    rmSync(claimPath(claimDir(input.base), claimKey(input.directory), input.pid ?? process.pid), { force: true })
  } catch {
    // nothing to release
  }
}

/**
 * Whether this instance owns reviewing for its directory: the newest live claim
 * wins, so a reload (newer `startedAt`) takes over from an instance that is
 * still shutting down, and a second server loses to the first rather than
 * doubling every review.
 */
export function isClaimOwner(input: { directory: string; instance: string; pid?: number; base?: string }): boolean {
  const pid = input.pid ?? process.pid
  const claims = liveClaims(claimKey(input.directory), input.base)
  if (claims.length === 0) return true
  const newest = claims.reduce((a, b) => (b.startedAt > a.startedAt ? b : a))
  return newest.instance === input.instance && newest.pid === pid
}

export function activeClaimCount(directory: string, base?: string): number {
  return liveClaims(claimKey(directory), base).length
}
