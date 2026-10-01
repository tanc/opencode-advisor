/**
 * Admission and routing policy for advisor notes.
 *
 * The system prompt tells the reviewer a per-review advice budget and the
 * no-repeat rule, but real reviewer models violate both. This module makes the
 * rules load-bearing instead of prose: duplicates, content-free self-talk, and
 * over-budget notes are dropped at admission, so the primary transcript stays
 * clean even when the advisor misbehaves. It also decides how an admitted note
 * reaches the primary (steer / queue / preserve), mirroring omp.
 */

export type Severity = "nit" | "concern" | "blocker"
export const SEVERITIES: readonly Severity[] = ["nit", "concern", "blocker"]

/** Whether two notes are the same advice, allowing for rewording. */
export function isSameNote(a: string, b: string): boolean {
  const keyA = normalizeNote(a)
  const keyB = normalizeNote(b)
  if (!keyA || !keyB) return false
  if (keyA === keyB) return true
  return isNearDuplicate(tokensOf(keyA), tokensOf(keyB))
}

export interface Note {
  note: string
  severity?: Severity
}

/** Case-insensitive, punctuation-folded key. Exported for tests. */
export function normalizeNote(note: string): string {
  return note
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
}

/** Significant words of a normalized note; short words carry no signal. */
function tokensOf(key: string): Set<string> {
  return new Set(key.split(" ").filter((word) => word.length > 3))
}

/**
 * Near-duplicate test for reworded repeats.
 *
 * Reviewer models defeat exact-match dedupe by paraphrasing: one confused note
 * can return as eight reworded ones. Token overlap closes that, while notes too
 * short to judge safely are never matched, so distinct advice still gets through.
 */
function isNearDuplicate(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size < 4 || b.size < 4) return false
  let shared = 0
  for (const word of a) if (b.has(word)) shared += 1
  return shared / (a.size + b.size - shared) >= 0.6
}

/** Short, content-free phrases that carry no actionable advice. */
const NOISE: ReadonlySet<string> = new Set([
  "stop",
  "stop here",
  "stop now",
  "halt",
  "abort",
  "done",
  "task done",
  "task complete",
  "complete",
  "finished",
  "ok",
  "okay",
  "ok done",
  "no issue",
  "no issues",
  "no issue continue",
  "no concerns",
  "no concern",
  "nothing to add",
  "nothing to flag",
  "nothing to report",
  "no notes",
  "no further input",
  "no further input needed",
  "no further input required",
  "no further advice",
  "no further advice needed",
  "lgtm",
  "looks good",
  "all good",
  "agent is on track",
  "agent on track",
  "on track",
  "continue",
  "carry on",
])

export type SuppressionReason = "empty" | "noise" | "duplicate" | "rate-limit"

export interface Admission {
  accepted: boolean
  reason?: SuppressionReason
  /** A still-pending note from this review that a higher-severity admission displaced. */
  displacedKey?: string
}

const RANK: Record<Severity, number> = { nit: 1, concern: 2, blocker: 3 }
export function severityRank(severity: Severity | undefined): number {
  return RANK[severity ?? "nit"]
}

const DEFAULT_HISTORY_CAPACITY = 4096
const DEFAULT_BUDGET = 4
const MAX_BUDGET = 32

/**
 * Session-scoped admission gate. Dedupe is rank-aware (a strict escalation
 * nit→concern→blocker is admitted; an equal/lower re-raise is dropped). The
 * per-review budget covers non-blockers only; a higher-severity admission may
 * displace the lowest-rank still-pending note of the same review.
 */
export class EmissionGuard {
  #seen = new Map<string, number>()
  #tokens = new Map<string, Set<string>>()
  #order: string[] = []
  #slots: { key: string; rank: number; pending: boolean }[] = []
  readonly #capacity: number
  readonly #budget: number

  constructor(opts: { budgetPerUpdate?: number; capacity?: number } = {}) {
    const budget = opts.budgetPerUpdate
    this.#budget =
      typeof budget === "number" && Number.isFinite(budget) ? Math.min(MAX_BUDGET, Math.max(1, Math.trunc(budget))) : DEFAULT_BUDGET
    this.#capacity = opts.capacity && opts.capacity > 0 ? Math.trunc(opts.capacity) : DEFAULT_HISTORY_CAPACITY
  }

  reset(): void {
    this.#seen.clear()
    this.#tokens.clear()
    this.#order = []
    this.#slots = []
  }

  /** Clear the per-review budget (notes still pending from earlier reviews keep their reservation). */
  beginUpdate(): void {
    this.#slots = []
  }

  markRouted(note: string): void {
    const slot = this.#slots.find((s) => s.key === normalizeNote(note))
    if (slot) slot.pending = false
  }

  escalatePending(note: string, rank: number): void {
    const key = normalizeNote(note)
    if (!key) return
    if (rank <= (this.#seen.get(key) ?? 0)) return
    this.#record(key, rank)
    const slot = this.#slots.find((s) => s.key === key)
    if (slot && slot.rank < rank) slot.rank = rank
  }

  #record(key: string, rank: number): void {
    const isNew = !this.#seen.has(key)
    this.#seen.set(key, rank)
    if (!isNew) return
    this.#order.push(key)
    this.#tokens.set(key, tokensOf(key))
    if (this.#order.length > this.#capacity) {
      const stale = this.#order.shift()
      if (stale !== undefined) {
        this.#seen.delete(stale)
        this.#tokens.delete(stale)
      }
    }
  }

  admit(note: string, opts: { rank: number; pending: boolean }): Admission {
    const key = normalizeNote(note)
    if (!key) return { accepted: false, reason: "empty" }
    if (NOISE.has(key)) return { accepted: false, reason: "noise" }
    if (opts.rank <= (this.#seen.get(key) ?? 0)) return { accepted: false, reason: "duplicate" }
    const tokens = tokensOf(key)
    for (const [seenKey, seenTokens] of this.#tokens) {
      if (opts.rank <= (this.#seen.get(seenKey) ?? 0) && isNearDuplicate(tokens, seenTokens)) {
        return { accepted: false, reason: "duplicate" }
      }
    }

    let displacedKey: string | undefined
    const own = this.#slots.find((s) => s.key === key)
    if (opts.rank >= 3) {
      if (own?.pending) this.#slots.splice(this.#slots.indexOf(own), 1)
    } else if (own) {
      own.rank = opts.rank
    } else if (this.#slots.length < this.#budget) {
      this.#slots.push({ key, rank: opts.rank, pending: opts.pending })
    } else {
      let minIndex = -1
      for (let i = 0; i < this.#slots.length; i++) {
        const slot = this.#slots[i]!
        if (!slot.pending) continue
        if (minIndex === -1 || slot.rank < this.#slots[minIndex]!.rank) minIndex = i
      }
      if (minIndex !== -1 && opts.rank > this.#slots[minIndex]!.rank) {
        displacedKey = this.#slots[minIndex]!.key
        this.#slots[minIndex] = { key, rank: opts.rank, pending: opts.pending }
      } else {
        return { accepted: false, reason: "rate-limit" }
      }
    }
    this.#record(key, opts.rank)
    return displacedKey === undefined ? { accepted: true } : { accepted: true, displacedKey }
  }
}

/** How one note reaches the primary. */
export type DeliveryChannel = "steer" | "queue" | "preserve"

export interface ChannelInput {
  severity: Severity | undefined
  /** A run is actively streaming right now. */
  streaming: boolean
  /** Inside the post-interrupt immune window. */
  interruptImmuneTurnActive: boolean
}

/**
 * Resolve how a note reaches the primary.
 *
 * - `preserve` records the note for the next turn and never starts one.
 * - `queue` waits for the next step boundary of a turn that is already running.
 * - `steer` goes into the turn that is already running.
 *
 * The invariant is that the reviewer never starts a turn: a note can only
 * reach `steer`/`queue` while work is streaming, so an idle session is never
 * woken and a completed turn is never restarted. While a turn runs a `concern`
 * or a `blocker` steers and a `nit` queues — but only until something has
 * steered: inside the post-interrupt immune window everything queues, blockers
 * included. One interruption stays one interruption, however it is reworded.
 */
export function resolveChannel(input: ChannelInput): DeliveryChannel {
  if (!input.streaming) return "preserve"
  if (input.severity === "nit" || input.severity === undefined) return "queue"
  if (input.interruptImmuneTurnActive) return "queue"
  return "steer"
}
