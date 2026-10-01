/**
 * The advisor engine: observes a session, runs the reviewer model(s), and
 * routes admitted notes back into the session.
 *
 * Observation is pull-based. The engine subscribes to the event stream only as
 * a trigger (`session.idle`, `session.step.ended`, ...); when triggered it reads
 * the authoritative transcript with `ctx.session.context` and reviews the current
 * turn from its start, so a mid-turn pass is never reasoning off one step. The
 * reviewer itself is a stateless `ctx.generate.text`
 * call with a small JSON protocol, so it can request `read`/`grep`/`glob` before
 * advising without ever mutating the session or the repository.
 */
import {
  EmissionGuard,
  isSameNote,
  resolveChannel,
  severityRank,
  type DeliveryChannel,
  type Note,
  type Severity,
} from "./guard.ts"
import { buildReviewPrompt, buildSystemPrompt, formatAdvisoryBatch, parseAdvisorReply } from "./prompts.ts"
import type { AdvisorConfig, AdvisorSpec } from "./config.ts"
import { DEFAULT_TOOLS } from "./config.ts"
import { renderDelta, type SessionMessage } from "./transcript.ts"
import { liveInstances } from "./instances.ts"
import { runTool } from "./tools.ts"
import { parseSelector, type ModelRef } from "./model.ts"

export { parseSelector, type ModelRef } from "./model.ts"

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
  /** Identifies this plugin instance in status output and injected metadata. */
  instance?: string
  listMessages(sessionID: string): Promise<SessionMessage[]>
  generate(input: { model?: ModelRef; prompt: string; signal: AbortSignal }): Promise<string>
  inject(input: InjectInput): Promise<string | undefined>
  /** Resolve a `provider/model#variant` selector (or the default) to a usable model. */
  resolveModel(selector: string | undefined): Promise<ModelRef | undefined>
  /** Persist a per-session enable override so it survives a plugin reload. */
  onSessionOverride?(sessionID: string, enabled: boolean | undefined): Promise<void> | void
  /** Raise a user-facing notification (OpenChamber only; a no-op elsewhere). */
  notify?(input: NotifyInput): void
  log(level: "debug" | "warn", message: string, data?: Record<string, unknown>): void
}

export interface NotifyInput {
  title: string
  body: string
  sessionID: string
  directory: string
  /** Ask to show even when the user is looking at OpenChamber. */
  showWhenFocused: boolean
}

interface SessionState {
  sessionID: string
  seeded: boolean
  reviewedCount: number
  streaming: boolean
  completedTurns: number
  immuneTurnStart?: number
  guards: Map<string, EmissionGuard>
  priorNotes: Map<string, string[]>
  reviewInProgress: boolean
  queuedReview: { streaming: boolean } | null
  timer?: ReturnType<typeof setTimeout>
  enabled?: boolean
  notesDelivered: number
  lastReviewAt?: number
  lastError?: string
  /** Completed review passes, even those that raised no notes. */
  reviews: number
  /** Notes raised (not necessarily delivered) by the most recent pass. */
  lastNoteCount: number
  /** Human-readable outcome of the most recent pass, e.g. "no notes". */
  lastOutcome?: string
  backlog: number
  userMessageCount: number
  steersSinceUser: number
  /** Blockers delivered inside the current user turn (see the per-turn cap). */
  blockersThisUserTurn: number
  /** Why the configured reviewer model could not be used, if it could not. */
  lastModelWarning?: string
  /** Failure notices already delivered, so a broken reviewer is loud once. */
  noticesSent: Set<string>
}

const DEBOUNCE_MS = 350
/** Floor between mid-turn reviews: advice about a turn that is still moving is
 *  worth less the more of it there is, and a fast agent outruns the reviewer. */
const MIDTURN_MIN_INTERVAL_MS = 30_000
/** Ceiling on delivered blockers per user turn: past this a blocker is far more
 *  likely to be churn than signal, and the turn-end pass can re-raise it. */
const MAX_BLOCKERS_PER_USER_TURN = 2
const PRIOR_NOTE_LIMIT = 40
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
        completedTurns: 0,
        guards: new Map(),
        priorNotes: new Map(),
        reviewInProgress: false,
        queuedReview: null,
        notesDelivered: 0,
        reviews: 0,
        lastNoteCount: 0,
        backlog: 0,
        userMessageCount: 0,
        steersSinceUser: 0,
        blockersThisUserTurn: 0,
        noticesSent: new Set<string>(),
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
    // Mid-turn work is reviewed at most once per interval; later triggers ride
    // along with the pending one instead of stacking a note every step.
    const since = state.lastReviewAt === undefined ? Number.POSITIVE_INFINITY : Date.now() - state.lastReviewAt
    const gap = streaming ? MIDTURN_MIN_INTERVAL_MS - since : 0
    const delay = Math.max(DEBOUNCE_MS, gap)
    state.timer = setTimeout(() => {
      state.timer = undefined
      void this.review(sessionID, streaming)
    }, delay)
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
      return
    }
    if (state.reviewInProgress) {
      state.queuedReview = { streaming }
      return
    }
    state.reviewInProgress = true
    try {
      const messages = await this.#host.listMessages(sessionID)
      state.streaming = streaming

      // A new user message resets the per-turn steering cap.
      const userMessages = messages.reduce((n, m) => (m.type === "user" ? n + 1 : n), 0)
      if (userMessages > state.userMessageCount) {
        state.userMessageCount = userMessages
        state.steersSinceUser = 0
        state.blockersThisUserTurn = 0
      }

      if (!state.seeded) {
        // Seed to the last user turn so enabling mid-session does not replay the
        // entire conversation on the first review.
        const lastUser = findLastIndex(messages, (m) => m.type === "user")
        state.reviewedCount = lastUser >= 0 ? lastUser : messages.length
        state.seeded = true
        if (lastUser < 0) return
      }

      // Ground the pass in the whole current turn, not just the step that
      // triggered it: a one-step slice is partial evidence, and reviewers that
      // reason from it assert state they have not checked.
      const lastUser = findLastIndex(messages, (m) => m.type === "user")
      const base = lastUser >= 0 ? Math.min(state.reviewedCount, lastUser) : state.reviewedCount
      const transcript = renderDelta(messages.slice(base), {
        includeThinking: this.#config.includeThinking,
        maxChars: this.#config.maxTranscriptChars,
        wip: streaming,
      })
      state.reviewedCount = messages.length
      if (!transcript) return

      const advisors = this.#config.advisors.filter((a) => a.enabled)
      if (advisors.length === 0) return

      let notes = 0
      for (const advisor of advisors) {
        if (this.#abort.signal.aborted) return
        notes += await this.#reviewWith(advisor, sessionID, transcript, streaming, state)
      }
      state.reviews += 1
      state.lastNoteCount = notes
      state.lastError = undefined
      state.lastReviewAt = Date.now()
    } catch (err) {
      state.lastError = (err as Error).message
      this.#host.log("warn", "advisor review failed", { sessionID, error: (err as Error).message })
    } finally {
      state.reviewInProgress = false
      state.backlog = Math.max(0, state.backlog - 1)
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
  ): Promise<number> {
    const model = await this.#host.resolveModel(advisor.model ?? this.#config.model)
    state.lastModelWarning = model?.warning
    if (model?.warning) {
      const resolved = model.providerID + " at " + model.id
      const text = "Advisor: " + model.warning + ". Reviews are using " + resolved + " instead; run the advisor status command for details."
      await this.#noticeOnce(state, sessionID, model.warning, text)
    }

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
      if (this.#abort.signal.aborted) {
        state.lastOutcome = "aborted"
        return 0
      }
      const prompt = buildReviewPrompt({ system, transcript, toolResults, priorNotes: prior.slice(-PRIOR_NOTE_LIMIT) })
      let text: string
      try {
        text = await this.#host.generate({ model, prompt, signal: this.#abort.signal })
      } catch (err) {
        const message = (err as Error).message
        state.lastError = message
        this.#host.log("warn", "advisor model call failed", { advisor: advisor.name, error: message })
        state.lastOutcome = "model error"
        await this.#noticeOnce(
          state,
          sessionID,
          `error:${message}`,
          `Advisor: the reviewer's model call failed (${message}), so this session is getting no advice. /advisor status has the details.`,
        )
        return 0
      }
      const reply = parseAdvisorReply(text)
      if (reply.kind === "tool" && reply.tool) {
        if (round >= this.#config.maxToolRounds) {
          this.#host.log("debug", "advisor exceeded tool round budget", { advisor: advisor.name })
          state.lastOutcome = "tool budget exhausted"
          return 0
        }
        const outcome = await runTool(this.#host.directory, reply.tool, reply.input ?? {}, granted)
        toolResults.push({ tool: reply.tool, input: reply.input ?? {}, text: outcome.text })
        continue
      }
      if (reply.kind === "notes" && reply.notes) {
        if (reply.retractions?.length) this.#applyRetractions(advisor, reply.retractions, state)
        const routed = await this.#routeNotes(advisor, reply.notes, sessionID, streaming, state, guard)
        const count = reply.notes.length === 0 ? "no notes" : `${reply.notes.length} notes`
        // Mid-turn the reviewer is instructed to withhold non-blocking critique,
        // so "no notes (in progress)" is expected, not a clean bill of health.
        state.lastOutcome = streaming ? `${count} (in progress)` : count
        return routed
      }
      this.#host.log("debug", "advisor returned an unparseable reply", { advisor: advisor.name })
      state.lastOutcome = "unparseable reply"
      return 0
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
  ): Promise<number> {
    if (notes.length === 0) return 0
    const immuneActive = isImmuneActive(state, this.#config.immuneTurns)

    const admitted: { note: string; severity?: Severity; channel: DeliveryChannel }[] = []
    for (const note of notes) {
      const severity = note.severity
      let channel = resolveChannel({
        severity,
        streaming,
        interruptImmuneTurnActive: immuneActive,
      })
      // Safety net: past the per-turn cap, a would-be steer becomes a queued
      // note, so the primary is never woken in an unbounded loop.
      if (channel === "steer" && state.steersSinceUser >= MAX_STEERS_PER_USER_TURN) channel = "queue"
      // A third blocker inside one user turn is churn far more often than signal;
      // dropping it here keeps it out of the guard's history, so the turn-end
      // pass can still raise it if it survives.
      if (severity === "blocker" && state.blockersThisUserTurn >= MAX_BLOCKERS_PER_USER_TURN) {
        this.#host.log("debug", "advisor blocker suppressed by per-turn cap", { advisor: advisor.name })
        continue
      }
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
    if (admitted.length === 0) return 0

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
        metadata: { advisor: { slug: advisor.slug, name: advisor.name, severities: group.map((n) => n.severity ?? "nit"), instance: this.#host.instance } },
        delivery,
        resume,
      })
      if (id) state.notesDelivered += group.length
      for (const note of group) guard.markRouted(note.note)
      if (channel === "steer") steered = true
    }

    const deliveredBefore = state.notesDelivered
    await injectGroup("steer", groups.steer)
    await injectGroup("queue", groups.queue)
    await injectGroup("preserve", groups.preserve)

    // Page the user, because a note lands in the agent's context either way but
    // is invisible in OpenChamber's timeline until it renders advisor notices.
    if (state.notesDelivered > deliveredBefore && this.#config.notify !== "off" && this.#host.notify) {
      const top = admitted.reduce((best, entry) =>
        severityRank(entry.severity) > severityRank(best.severity) ? entry : best,
      )
      this.#host.notify({
        title: `Advisor · ${top.severity ?? "note"}`,
        body: admitted.map((entry) => entry.note).join(" · ").slice(0, 500),
        sessionID,
        directory: this.#host.directory,
        // A blocker pages even while the user is looking at OpenChamber. The
        // agent is still not woken: this only skips the away-only gate.
        showWhenFocused: this.#config.notify === "always" || top.severity === "blocker",
      })
    }

    const prior = state.priorNotes.get(advisor.slug) ?? []
    for (const entry of admitted) prior.push(entry.note)
    state.priorNotes.set(advisor.slug, prior.slice(-PRIOR_NOTE_LIMIT))

    if (steered) state.immuneTurnStart = state.completedTurns
    if (groups.steer.length > 0) state.steersSinceUser += groups.steer.length
    state.blockersThisUserTurn += admitted.filter((entry) => entry.severity === "blocker").length
    return admitted.length
  }

  /**
   * Tell the session once about a failure that otherwise leaves no trace. A
   * reviewer that cannot call its model is indistinguishable from one with
   * nothing to say, so "nothing happened" must never mean "it has been failing
   * all along". Keyed by message, so a *different* failure still speaks up.
   */
  async #noticeOnce(state: SessionState, sessionID: string, key: string, text: string): Promise<void> {
    if (state.noticesSent.has(key)) return
    state.noticesSent.add(key)
    try {
      await this.#host.inject({
        sessionID,
        text,
        description: "advisor notice",
        metadata: { advisor: { kind: "notice", instance: this.#host.instance } },
        delivery: "queue",
        resume: false,
      })
    } catch (err) {
      this.#host.log("warn", "advisor notice failed", { error: (err as Error).message })
    }
  }

  /**
   * Withdraw earlier notes silently. A retraction is bookkeeping: the agent
   * must never pay an interruption for the reviewer changing its mind, and the
   * note must stop being replayed as a tombstone.
   */
  #applyRetractions(advisor: AdvisorSpec, retractions: string[], state: SessionState): void {
    const prior = state.priorNotes.get(advisor.slug) ?? []
    let removed = 0
    for (const text of retractions) {
      for (let i = prior.length - 1; i >= 0; i--) {
        if (!isSameNote(prior[i]!, text)) continue
        prior.splice(i, 1)
        removed += 1
      }
    }
    if (removed === 0) return
    state.priorNotes.set(advisor.slug, prior)
    this.#host.log("debug", "advisor retracted earlier notes", { advisor: advisor.name, removed })
  }

  /* ---------------------------------------------------------------- *
   * Status and lifecycle
   * ---------------------------------------------------------------- */

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
    reviews: number
    lastReviewAt?: number
    lastNoteCount: number
    lastOutcome?: string
    lastError?: string
    /** Why the configured reviewer model could not be used, if it could not. */
    modelWarning?: string
    /** Live plugin instances in this process; more than one means duplicated reviewers. */
    instances: number
    /** This engine's instance id. */
    instance?: string
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
      reviews: state.reviews,
      lastReviewAt: state.lastReviewAt,
      lastNoteCount: state.lastNoteCount,
      lastOutcome: state.lastOutcome,
      lastError: state.lastError,
      modelWarning: state.lastModelWarning,
      instances: liveInstances(),
      instance: this.#host.instance,
    }
  }

  dispose(): void {
    this.#abort.abort()
    for (const state of this.#sessions.values()) {
      if (state.timer) clearTimeout(state.timer)
    }
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
