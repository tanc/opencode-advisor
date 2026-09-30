/**
 * The advisor engine: observes a session, runs the reviewer model(s), and
 * routes admitted notes back into the session.
 *
 * Observation is pull-based. The engine subscribes to the event stream only as
 * a trigger (`session.idle`, `session.step.ended`, ...); when triggered it reads
 * the authoritative transcript with `ctx.session.context` and reviews only the
 * slice it has not seen. The reviewer itself is a stateless `ctx.generate.text`
 * call with a small JSON protocol, so it can request `read`/`grep`/`glob` before
 * advising without ever mutating the session or the repository.
 */
import {
  EmissionGuard,
  resolveChannel,
  severityRank,
  type DeliveryChannel,
  type Note,
  type Severity,
} from "./guard.ts"
import { buildReviewPrompt, buildSystemPrompt, formatAdvisoryBatch, parseAdvisorReply } from "./prompts.ts"
import type { AdvisorConfig, AdvisorSpec } from "./config.ts"
import { DEFAULT_TOOLS } from "./config.ts"
import { renderDelta, tailIsTerminalAnswer, type SessionMessage } from "./transcript.ts"
import { runTool } from "./tools.ts"

export interface ModelRef {
  providerID: string
  id: string
  variant?: string
}

export interface AdvisorEvent {
  type?: string
  location?: { directory?: string }
  data?: Record<string, unknown>
}

export interface InjectInput {
  sessionID: string
  text: string
  description?: string
  metadata?: Record<string, unknown>
  delivery: "steer" | "queue"
  resume: boolean
}

/** Everything the engine needs from the OpenCode plugin context. */
export interface EngineHost {
  directory: string
  listMessages(sessionID: string): Promise<SessionMessage[]>
  generate(input: { model?: ModelRef; prompt: string; signal: AbortSignal }): Promise<string>
  inject(input: InjectInput): Promise<string | undefined>
  /** Resolve a `provider/model#variant` selector (or the default) to a usable model. */
  resolveModel(selector: string | undefined): Promise<ModelRef | undefined>
  /** Persist a per-session enable override so it survives a plugin reload. */
  onSessionOverride?(sessionID: string, enabled: boolean | undefined): Promise<void> | void
  log(level: "debug" | "warn", message: string, data?: Record<string, unknown>): void
}

interface SessionState {
  sessionID: string
  seeded: boolean
  reviewedCount: number
  streaming: boolean
  terminalAnswer: boolean
  completedTurns: number
  immuneTurnStart?: number
  autoResumeSuppressed: boolean
  guards: Map<string, EmissionGuard>
  priorNotes: Map<string, string[]>
  reviewInProgress: boolean
  queuedReview: { streaming: boolean } | null
  timer?: ReturnType<typeof setTimeout>
  enabled?: boolean
  notesDelivered: number
  lastReviewAt?: number
  lastError?: string
  backlog: number
  userMessageCount: number
  steersSinceUser: number
  waiters: (() => void)[]
}

const DEBOUNCE_MS = 350
const PRIOR_NOTE_LIMIT = 40
/** Bounded catch-up: the primary waits at most this long for the advisor. */
const SYNC_BACKLOG_CAP_MS = 30_000
/** Safety net: at most this many steering wake-ups per user turn, so a
 *  confused reviewer cannot loop the primary indefinitely. */
const MAX_STEERS_PER_USER_TURN = 4

function resolvedDirectory(directory: string | undefined): string | undefined {
  return directory ? directory.replace(/\/+$/, "") : undefined
}

export class AdvisorEngine {
  #config: AdvisorConfig
  #host: EngineHost
  #sessions = new Map<string, SessionState>()
  #abort = new AbortController()
  #sessionOrder: string[] = []
  #waiters: { threshold: number; resolve: () => void }[] = []

  constructor(config: AdvisorConfig, host: EngineHost) {
    this.#config = config
    this.#host = host
  }

  get enabled(): boolean {
    return this.#config.enabled
  }

  get config(): AdvisorConfig {
    return this.#config
  }

  #state(sessionID: string): SessionState {
    let state = this.#sessions.get(sessionID)
    if (!state) {
      state = {
        sessionID,
        seeded: false,
        reviewedCount: 0,
        streaming: false,
        terminalAnswer: false,
        completedTurns: 0,
        autoResumeSuppressed: false,
        guards: new Map(),
        priorNotes: new Map(),
        reviewInProgress: false,
        queuedReview: null,
        notesDelivered: 0,
        backlog: 0,
        userMessageCount: 0,
        steersSinceUser: 0,
        waiters: [],
      }
      this.#sessions.set(sessionID, state)
      this.#sessionOrder.push(sessionID)
      if (this.#sessionOrder.length > 64) {
        const oldest = this.#sessionOrder.shift()
        if (oldest) this.#sessions.delete(oldest)
      }
    }
    return state
  }

  #isEnabled(sessionID: string): boolean {
    const state = this.#sessions.get(sessionID)
    return state?.enabled ?? this.#config.enabled
  }

  setSessionEnabled(sessionID: string, enabled: boolean | undefined, persist = true): boolean {
    this.#state(sessionID).enabled = enabled
    if (persist) void this.#host.onSessionOverride?.(sessionID, enabled)
    return this.#isEnabled(sessionID)
  }

  toggleSession(sessionID: string): boolean {
    return this.setSessionEnabled(sessionID, !this.#isEnabled(sessionID))
  }

  /* ---------------------------------------------------------------- *
   * Event intake
   * ---------------------------------------------------------------- */

  onEvent(event: AdvisorEvent): void {
    const type = event.type
    const sessionID = typeof event.data?.sessionID === "string" ? (event.data.sessionID as string) : undefined
    if (!type || !sessionID) return

    const directory = resolvedDirectory(event.location?.directory)
    if (directory && resolvedDirectory(this.#host.directory) && directory !== resolvedDirectory(this.#host.directory)) return

    const state = this.#state(sessionID)

    switch (type) {
      case "session.step.started": {
        state.streaming = true
        state.autoResumeSuppressed = false
        return
      }
      case "session.step.ended": {
        const finish = typeof event.data?.finish === "string" ? event.data.finish : undefined
        // A step that ended with tool calls is mid-run; anything else yields.
        state.streaming = finish === "tool-calls"
        this.#schedule(sessionID, state.streaming)
        return
      }
      case "session.execution.succeeded": {
        state.streaming = false
        state.completedTurns += 1
        this.#schedule(sessionID, false)
        return
      }
      case "session.execution.failed": {
        state.streaming = false
        this.#schedule(sessionID, false)
        return
      }
      case "session.execution.interrupted": {
        state.autoResumeSuppressed = true
        state.streaming = false
        return
      }
      case "session.idle": {
        // Belt and braces: some paths settle without an execution event.
        state.streaming = false
        this.#schedule(sessionID, false)
        return
      }
      default:
        return
    }
  }

  #schedule(sessionID: string, streaming: boolean): void {
    const state = this.#state(sessionID)
    if (!state.timer && !state.reviewInProgress) state.backlog += 1
    if (state.timer) clearTimeout(state.timer)
    state.timer = setTimeout(() => {
      state.timer = undefined
      void this.review(sessionID, streaming)
    }, DEBOUNCE_MS)
    // Keep the process from being held open by a pending review.
    state.timer.unref?.()
  }

  /* ---------------------------------------------------------------- *
   * Review
   * ---------------------------------------------------------------- */

  async review(sessionID: string, streaming: boolean): Promise<void> {
    const state = this.#state(sessionID)
    if (!this.#isEnabled(sessionID)) {
      state.backlog = 0
      this.#wakeWaiters()
      return
    }
    if (state.reviewInProgress) {
      state.queuedReview = { streaming }
      return
    }
    state.reviewInProgress = true
    try {
      const messages = await this.#host.listMessages(sessionID)
      state.terminalAnswer = tailIsTerminalAnswer(messages)
      state.streaming = streaming

      // A new user message resets the per-turn steering cap.
      const userMessages = messages.reduce((n, m) => (m.type === "user" ? n + 1 : n), 0)
      if (userMessages > state.userMessageCount) {
        state.userMessageCount = userMessages
        state.steersSinceUser = 0
      }

      if (!state.seeded) {
        // Seed to the last user turn so enabling mid-session does not replay the
        // entire conversation on the first review.
        const lastUser = findLastIndex(messages, (m) => m.type === "user")
        state.reviewedCount = lastUser >= 0 ? lastUser : messages.length
        state.seeded = true
        if (lastUser < 0) return
      }

      const slice = messages.slice(state.reviewedCount)
      const transcript = renderDelta(slice, {
        includeThinking: this.#config.includeThinking,
        maxChars: this.#config.maxTranscriptChars,
        wip: streaming,
      })
      state.reviewedCount = messages.length
      if (!transcript) return

      const advisors = this.#config.advisors.filter((a) => a.enabled)
      if (advisors.length === 0) return

      for (const advisor of advisors) {
        if (this.#abort.signal.aborted) return
        await this.#reviewWith(advisor, sessionID, transcript, streaming, state)
      }
      state.lastReviewAt = Date.now()
    } catch (err) {
      state.lastError = (err as Error).message
      this.#host.log("warn", "advisor review failed", { sessionID, error: (err as Error).message })
    } finally {
      state.reviewInProgress = false
      state.backlog = Math.max(0, state.backlog - 1)
      this.#wakeWaiters()
      const queued = state.queuedReview
      state.queuedReview = null
      if (queued) {
        scheduleMicrotask(() => void this.review(sessionID, queued.streaming))
      }
    }
  }

  async #reviewWith(
    advisor: AdvisorSpec,
    sessionID: string,
    transcript: string,
    streaming: boolean,
    state: SessionState,
  ): Promise<void> {
    const model = await this.#host.resolveModel(advisor.model ?? this.#config.model)

    const guard = state.guards.get(advisor.slug) ?? new EmissionGuard({ budgetPerUpdate: advisor.maxNotesPerUpdate ?? this.#config.sharedMaxNotesPerUpdate })
    state.guards.set(advisor.slug, guard)
    guard.beginUpdate()

    const prior = state.priorNotes.get(advisor.slug) ?? []
    const system = buildSystemPrompt({
      advisorName: advisor.name,
      maxNotes: advisor.maxNotesPerUpdate ?? this.#config.sharedMaxNotesPerUpdate ?? 4,
      maxToolRounds: this.#config.maxToolRounds,
      sharedInstructions: this.#config.sharedInstructions,
      advisorInstructions: advisor.instructions,
      watchdogBlocks: this.#config.watchdogBlocks,
      projectContext: this.#config.projectContext,
    })

    const granted = advisor.tools === undefined ? [...DEFAULT_TOOLS] : advisor.tools
    const toolResults: { tool: string; input: Record<string, unknown>; text: string }[] = []

    for (let round = 0; ; round++) {
      if (this.#abort.signal.aborted) return
      const prompt = buildReviewPrompt({ system, transcript, toolResults, priorNotes: prior.slice(-PRIOR_NOTE_LIMIT) })
      let text: string
      try {
        text = await this.#host.generate({ model, prompt, signal: this.#abort.signal })
      } catch (err) {
        state.lastError = (err as Error).message
        this.#host.log("warn", "advisor model call failed", { advisor: advisor.name, error: (err as Error).message })
        return
      }
      const reply = parseAdvisorReply(text)
      if (reply.kind === "tool" && reply.tool) {
        if (round >= this.#config.maxToolRounds) {
          this.#host.log("debug", "advisor exceeded tool round budget", { advisor: advisor.name })
          return
        }
        const outcome = await runTool(this.#host.directory, reply.tool, reply.input ?? {}, granted)
        toolResults.push({ tool: reply.tool, input: reply.input ?? {}, text: outcome.text })
        continue
      }
      if (reply.kind === "notes" && reply.notes) {
        await this.#routeNotes(advisor, reply.notes, sessionID, streaming, state, guard)
      } else {
        this.#host.log("debug", "advisor returned an unparseable reply", { advisor: advisor.name })
      }
      return
    }
  }

  /* ---------------------------------------------------------------- *
   * Delivery
   * ---------------------------------------------------------------- */

  async #routeNotes(
    advisor: AdvisorSpec,
    notes: Note[],
    sessionID: string,
    streaming: boolean,
    state: SessionState,
    guard: EmissionGuard,
  ): Promise<void> {
    if (notes.length === 0) return
    const immuneActive = isImmuneActive(state, this.#config.immuneTurns)

    const admitted: { note: string; severity?: Severity; channel: DeliveryChannel }[] = []
    for (const note of notes) {
      const severity = note.severity
      let channel = resolveChannel({
        severity,
        streaming,
        terminalAnswerNoQueuedWork: state.terminalAnswer,
        autoResumeSuppressed: state.autoResumeSuppressed,
        interruptImmuneTurnActive: immuneActive,
      })
      // Safety net: past the per-turn cap, a would-be steer becomes a queued
      // note, so the primary is never woken in an unbounded loop.
      if (channel === "steer" && state.steersSinceUser >= MAX_STEERS_PER_USER_TURN) channel = "queue"
      const decision = guard.admit(note.note, { rank: severityRank(severity), pending: channel !== "steer" })
      if (!decision.accepted) {
        this.#host.log("debug", "advisor note suppressed", { advisor: advisor.name, reason: decision.reason })
        continue
      }
      if (decision.displacedKey !== undefined) {
        const index = admitted.findIndex((a) => normalizeKey(a.note) === decision.displacedKey)
        if (index !== -1) admitted.splice(index, 1)
      }
      admitted.push({ note: note.note, severity, channel })
    }
    if (admitted.length === 0) return

    const groups: Record<DeliveryChannel, Note[]> = { steer: [], queue: [], preserve: [] }
    for (const entry of admitted) groups[entry.channel].push({ note: entry.note, severity: entry.severity })

    let steered = false
    const injectGroup = async (channel: DeliveryChannel, group: Note[]) => {
      if (group.length === 0) return
      const delivery: "steer" | "queue" = channel === "steer" ? "steer" : "queue"
      // Only a steering note may wake an idle agent. A queued note rides the
      // running turn (streaming) or waits; a preserve note is a visible card.
      const resume = channel === "steer"
      const text = formatAdvisoryBatch(group, advisor.name)
      const id = await this.#host.inject({
        sessionID,
        text,
        description: channel === "preserve" ? "advisor note" : "advisor",
        metadata: { advisor: { slug: advisor.slug, name: advisor.name, severities: group.map((n) => n.severity ?? "nit") } },
        delivery,
        resume,
      })
      if (id) state.notesDelivered += group.length
      for (const note of group) guard.markRouted(note.note)
      if (channel === "steer") steered = true
    }

    await injectGroup("steer", groups.steer)
    await injectGroup("queue", groups.queue)
    await injectGroup("preserve", groups.preserve)

    const prior = state.priorNotes.get(advisor.slug) ?? []
    for (const entry of admitted) prior.push(entry.note)
    state.priorNotes.set(advisor.slug, prior.slice(-PRIOR_NOTE_LIMIT))

    if (steered) state.immuneTurnStart = state.completedTurns
    if (groups.steer.length > 0) state.steersSinceUser += groups.steer.length
  }

  /* ---------------------------------------------------------------- *
   * Catch-up, status, lifecycle
   * ---------------------------------------------------------------- */

  /** Max unreviewed turns across all sessions (bounded catch-up input). */
  pendingBacklog(): number {
    let max = 0
    for (const state of this.#sessions.values()) max = Math.max(max, state.backlog)
    return max
  }

  /** Resolve once backlog drops below `threshold`, or after `timeoutMs`. */
  async waitForBacklog(threshold: number, timeoutMs = SYNC_BACKLOG_CAP_MS): Promise<void> {
    if (this.pendingBacklog() < threshold) return
    await new Promise<void>((resolve) => {
      const waiter = {
        threshold,
        resolve: () => {
          clearTimeout(timer)
          resolve()
        },
      }
      const timer = setTimeout(waiter.resolve, timeoutMs)
      timer.unref?.()
      this.#waiters.push(waiter)
    })
  }

  #wakeWaiters(): void {
    const backlog = this.pendingBacklog()
    for (let i = this.#waiters.length - 1; i >= 0; i--) {
      if (backlog < this.#waiters[i]!.threshold) {
        const waiter = this.#waiters.splice(i, 1)[0]!
        waiter.resolve()
      }
    }
  }

  status(sessionID: string): {
    enabled: boolean
    /** The plugin-default state (`options.enabled`). */
    defaultEnabled: boolean
    /** The per-session override, when one was set; undefined means "use the default". */
    override?: boolean
    advisors: {
      name: string
      slug: string
      model?: string
      /** The roster entry's own switch. */
      rosterEnabled: boolean
      /** Whether this advisor will actually review (session on AND roster on). */
      active: boolean
      notes: number
      items: string[]
    }[]
    notesDelivered: number
    backlog: number
    lastReviewAt?: number
    lastError?: string
  } {
    const state = this.#state(sessionID)
    const enabled = this.#isEnabled(sessionID)
    return {
      enabled,
      defaultEnabled: this.#config.enabled,
      override: state.enabled,
      advisors: this.#config.advisors.map((a) => {
        const items = state.priorNotes.get(a.slug) ?? []
        return {
          name: a.name,
          slug: a.slug,
          model: a.model,
          rosterEnabled: a.enabled,
          active: enabled && a.enabled,
          notes: items.length,
          items,
        }
      }),
      notesDelivered: state.notesDelivered,
      backlog: state.backlog,
      lastReviewAt: state.lastReviewAt,
      lastError: state.lastError,
    }
  }

  dispose(): void {
    this.#abort.abort()
    for (const state of this.#sessions.values()) {
      if (state.timer) clearTimeout(state.timer)
    }
    this.#wakeWaiters()
    this.#sessions.clear()
  }
}

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (predicate(items[i]!)) return i
  return -1
}

function isImmuneActive(state: SessionState, immuneTurns: number): boolean {
  if (state.immuneTurnStart === undefined || immuneTurns <= 0) return false
  return state.completedTurns < state.immuneTurnStart + immuneTurns
}

function normalizeKey(note: string): string {
  return note
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
}

function scheduleMicrotask(fn: () => void): void {
  queueMicrotask(fn)
}

/** Parse `provider/model#variant` into a model reference. */
export function parseSelector(selector: string): ModelRef | undefined {
  const trimmed = selector.trim()
  const hash = trimmed.indexOf("#")
  const base = hash === -1 ? trimmed : trimmed.slice(0, hash)
  const variant = hash === -1 ? undefined : trimmed.slice(hash + 1).trim() || undefined
  const slash = base.indexOf("/")
  if (slash <= 0 || slash === base.length - 1) return undefined
  return { providerID: base.slice(0, slash).trim(), id: base.slice(slash + 1).trim(), variant }
}
