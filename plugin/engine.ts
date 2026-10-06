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
import { buildAdvicePrompt, buildReviewPrompt, buildSystemPrompt, formatAdvisoryBatch, parseAdvisorReply } from "./prompts.ts"
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
  /** The session's own agent and location; absent means "review everything". */
  getSession?(sessionID: string): Promise<{ agent?: string; location?: { directory?: string } } | undefined>
  /** The agent roster, so auxiliary agents can be skipped. */
  listAgents?(): Promise<{ id: string; mode?: string; hidden?: boolean }[]>
  /** Persist a per-session enable override so it survives a plugin reload. */
  onSessionOverride?(sessionID: string, enabled: boolean | undefined): Promise<void> | void
  /** Persist review counters so /advisor status survives a plugin reload. */
  persistCounters?(sessionID: string, counters: PersistedCounters): void
  /** Raise a user-facing notification (OpenChamber only; a no-op elsewhere). */
  notify?(input: NotifyInput): void
  /** Whether this instance still owns reviewing for its directory. */
  isClaimOwner?: () => boolean
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

/**
 * Review counters that outlive a plugin instance.
 *
 * Every reload builds a new instance with blank counters, which made status read
 * "Reviews 0 · no review yet" on sessions with dozens of reviews, and made
 * successive cards disagree with each other. Persisting them is what makes the
 * numbers mean "this session" rather than "this instance since it loaded".
 */
export interface PersistedCounters {
  reviews: number
  notesDelivered: number
  lastNoteCount: number
  lastReviewAt?: number
  lastOutcome?: string
  lastError?: string
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
/** Attempts per reviewer model call: one retry for a fast transient failure. */
const MAX_MODEL_ATTEMPTS = 2
/**
 * Failures worth one retry: the request never produced a usable answer for a
 * transport reason. Auth, model-resolution and configuration failures are
 * deliberately absent — retrying those only spends time to fail again.
 */
const TRANSIENT_FAILURE = /ECONN|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|getaddrinfo|network|stream ended|streaming response failed|finish_reason|premature close|connection (lost|reset|closed)|fetch failed|upstream service timeout|server_error|overloaded|service unavailable|internal server error|bad gateway|gateway timeout|\b(429|502|503|504)\b/i

function isTransientFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return TRANSIENT_FAILURE.test(message)
}

/**
 * Say what was attempted, so a failure notice is decodable on its own.
 *
 * "upstream service timeout" is ambiguous: it is the same text whether the
 * plugin is running a build that retries and lost both attempts, or one that
 * never retried at all. Naming the attempt count and the first failure removes
 * that ambiguity from every future occurrence.
 */
function describeFailure(error: unknown, attempts: number, firstError: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (attempts <= 1) return `${message} (one attempt; not retried: not a transient failure)`
  const first = firstError instanceof Error ? firstError.message : String(firstError)
  return `${message} (${attempts} attempts; first failure: ${first})`
}
/** How long a session's reviewability verdict is trusted. */
const SESSION_FILTER_TTL_MS = 5 * 60_000
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
  #reviewable = new Map<string, { ok: boolean; at: number }>()
  #agents?: { at: number; reviewable?: Set<string> }
  /** Sessions with a pull-tool answer in flight, one at a time. */
  #pullsInFlight = new Set<string>()

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

  /** Whether a turn is running, which is what routing keys off. */
  isStreaming(sessionID: string): boolean {
    return this.#sessions.get(sessionID)?.streaming ?? false
  }

  /**
   * How a command reply should be delivered. Queued synthetics drain at the next
   * turn boundary, which can leave an answer sitting for twenty minutes during a
   * long turn; while one is running, steer it in immediately instead. Never
   * resumes: a reply must not start a turn of its own.
   */
  replyDelivery(sessionID: string): "steer" | "queue" {
    return this.isStreaming(sessionID) ? "steer" : "queue"
  }

  /**
   * Restore review counters persisted before a reload. Deliberately excludes
   * `reviewedCount`: which transcript slice has been seen is per instance, and
   * a fresh instance should re-read the current turn rather than skip it.
   */
  seedCounters(sessionID: string, counters: Partial<PersistedCounters>): void {
    const state = this.#state(sessionID)
    if (typeof counters.reviews === "number") state.reviews = counters.reviews
    if (typeof counters.notesDelivered === "number") state.notesDelivered = counters.notesDelivered
    if (typeof counters.lastNoteCount === "number") state.lastNoteCount = counters.lastNoteCount
    if (typeof counters.lastReviewAt === "number") state.lastReviewAt = counters.lastReviewAt
    if (typeof counters.lastOutcome === "string") state.lastOutcome = counters.lastOutcome
    if (typeof counters.lastError === "string") state.lastError = counters.lastError
  }

  #countersOf(state: SessionState): PersistedCounters {
    return {
      reviews: state.reviews,
      notesDelivered: state.notesDelivered,
      lastNoteCount: state.lastNoteCount,
      lastReviewAt: state.lastReviewAt,
      lastOutcome: state.lastOutcome,
      lastError: state.lastError,
    }
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

  /**
   * Whether this session is worth reviewing at all.
   *
   * Auxiliary work is not: Magic Context and friends run historian, dreamer,
   * compaction and title sessions continuously — hidden agents, plus subagents
   * like `explore` — so reviewing them produces notes while the user's own
   * session sits idle, which is exactly how the advisor came to look like it
   * would not stop. Sessions outside this instance's location are skipped for
   * the same reason: their reviewer would inspect the wrong repository.
   *
   * Fails open: a host without the lookups, or an empty agent roster, reviews
   * everything rather than silently reviewing nothing.
   */
  async #isReviewable(sessionID: string): Promise<boolean> {
    if (!this.#host.getSession) return true
    const now = Date.now()
    const cached = this.#reviewable.get(sessionID)
    if (cached && now - cached.at < SESSION_FILTER_TTL_MS) return cached.ok
    let ok = true
    try {
      const session = await this.#host.getSession(sessionID)
      // An unknown session is not evidence of auxiliary work: skip only what
      // this lookup positively identifies as someone else's or not worth it.
      if (session) {
        const theirs = resolvedDirectory(session.location?.directory)
        const ours = resolvedDirectory(this.#host.directory)
        ok = (theirs === undefined || ours === undefined || theirs === ours) && (await this.#isReviewableAgent(session.agent))
      }
    } catch (err) {
      this.#host.log("warn", "advisor session lookup failed", { error: (err as Error).message })
    }
    this.#reviewable.set(sessionID, { ok, at: now })
    return ok
  }

  async #isReviewableAgent(agentID: string | undefined): Promise<boolean> {
    if (!this.#host.listAgents || agentID === undefined) return true
    const now = Date.now()
    if (!this.#agents || now - this.#agents.at > SESSION_FILTER_TTL_MS) {
      const list = await this.#host.listAgents()
      const reviewable = new Set(
        list.filter((agent) => agent.mode === "primary" && agent.hidden !== true).map((agent) => agent.id),
      )
      // An empty roster means "could not tell", not "nothing is reviewable".
      this.#agents = { at: now, reviewable: reviewable.size > 0 ? reviewable : undefined }
    }
    return this.#agents.reviewable === undefined || this.#agents.reviewable.has(agentID)
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
    // Losing the review claim is not a failure: another instance for this
    // directory is newer, and two reviewers means two sets of state, two
    // budgets and duplicate notes. Stay quiet and let the owner work.
    if (this.#host.isClaimOwner && !this.#host.isClaimOwner()) {
      state.backlog = 0
      return
    }
    if (!(await this.#isReviewable(sessionID))) {
      state.backlog = 0
      return
    }
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
      // Cleared before the pass, not after: a failed model call sets it from
      // inside the advisor, and clearing afterwards would erase exactly the
      // error /advisor status exists to report.
      state.lastError = undefined
      for (const advisor of advisors) {
        if (this.#abort.signal.aborted) return
        notes += await this.#reviewWith(advisor, sessionID, transcript, streaming, state)
      }
      state.reviews += 1
      state.lastNoteCount = notes
      state.lastReviewAt = Date.now()
    } catch (err) {
      if (this.#abort.signal.aborted) {
        state.lastOutcome = "aborted"
        return
      }
      state.lastError = (err as Error).message
      this.#host.log("warn", "advisor review failed", { sessionID, error: (err as Error).message })
    } finally {
      state.reviewInProgress = false
      state.backlog = Math.max(0, state.backlog - 1)
      // Persisted here rather than on the success path so a failed pass is
      // remembered too: /advisor status should survive a reload with the same
      // numbers, and a failure that vanishes on reload reads as "never ran".
      this.#host.persistCounters?.(sessionID, this.#countersOf(state))
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
        text = await this.#callModel(advisor, model, prompt)
      } catch (err) {
        // Our own abort means this instance is shutting down: a reload or a
        // dispose cancelled the call mid-flight, and the SDK reports that as a
        // transport error. That is not the endpoint failing, and paging the user
        // about our own shutdown makes every plugin edit look like an outage.
        if (this.#abort.signal.aborted) {
          state.lastOutcome = "aborted"
          return 0
        }
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
      // A nit is "a non-interrupting aside at the next step boundary". With no
      // running turn there is no next step boundary, so the aside can only
      // arrive stale: it would sit in the inbox until the next turn and then be
      // replayed as context about work already settled.
      if (!streaming && (severity === "nit" || severity === undefined)) {
        this.#host.log("debug", "advisor nit dropped on a settled turn", { advisor: advisor.name })
        continue
      }
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
   * Pull-mode advice: the agent asks via the `advisor` tool, and the answer is
   * returned as the tool's own result — which renders in OpenChamber's
   * timeline, unlike anything we push. One shot, no inspection loop: the
   * transcript is the evidence. The advice is also tombstoned, so the pushed
   * review pass treats it as already-raised instead of re-litigating it.
   */
  async pullAdvice(sessionID: string, question: string): Promise<string> {
    if (!this.#isEnabled(sessionID)) {
      return "Advisor is off for this session: run /advisor on to enable it."
    }
    if (this.#pullsInFlight.has(sessionID)) {
      return "Advisor is already answering a question for this session; wait for that answer before asking again."
    }
    this.#pullsInFlight.add(sessionID)
    try {
      const messages = await this.#host.listMessages(sessionID)
      const transcript = renderDelta(messages, {
        includeThinking: this.#config.includeThinking,
        maxChars: this.#config.maxTranscriptChars,
        wip: false,
      })
      if (!transcript) return "Advisor declined: there is no conversation to advise on yet."
      const advisor = this.#config.advisors.find((a) => a.enabled)
      const model = await this.#host.resolveModel(advisor?.model ?? this.#config.model)
      const prompt = buildAdvicePrompt({ advisorName: advisor?.name ?? "Advisor", transcript, question })
      if (this.#abort.signal.aborted) return "Advisor unavailable: the plugin is shutting down."
      let text: string
      try {
        text = (await this.#callModel(advisor, model, prompt)).trim()
      } catch (err) {
        if (this.#abort.signal.aborted) return "Advisor unavailable: the plugin is shutting down."
        // A pull that throws becomes a tool error the agent cannot interpret,
        // and an agent with a failed tool will sometimes invent the answer.
        const message = (err as Error).message
        await this.#noticeOnce(
          this.#state(sessionID),
          sessionID,
          `pull:${message}`,
          `Advisor: the reviewer's model call failed (${message}), so no advice was returned. /advisor status has the details.`,
        )
        return `Advisor unavailable: the reviewer's model call failed (${message}). Do not invent advice; continue on your own judgement.`
      }
      const answer = text || "Advisor returned no advice."
      if (advisor) {
        const state = this.#state(sessionID)
        const prior = state.priorNotes.get(advisor.slug) ?? []
        prior.push(answer)
        state.priorNotes.set(advisor.slug, prior.slice(-PRIOR_NOTE_LIMIT))
      }
      return answer
    } finally {
      this.#pullsInFlight.delete(sessionID)
    }
  }

  /**
   * One reviewer model call, bounded by a deadline and retried once on a fast
   * transient failure. Without the deadline a hung endpoint wedges the whole
   * review queue for that session — the failure mode that made notes arrive
   * minutes late. A timeout is not retried: the retry would double the wait for
   * an endpoint that has already proved it is not answering.
   */
  async #callModel(advisor: AdvisorSpec | undefined, model: ModelRef | undefined, prompt: string): Promise<string> {
    let firstError: unknown
    for (let attempt = 0; attempt < MAX_MODEL_ATTEMPTS; attempt++) {
      const controller = new AbortController()
      const onAbort = () => controller.abort()
      this.#abort.signal.addEventListener("abort", onAbort, { once: true })
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, this.#config.requestTimeoutMs)
      try {
        return await this.#host.generate({ model, prompt, signal: controller.signal })
      } catch (err) {
        if (firstError === undefined) firstError = err
        if (this.#abort.signal.aborted) throw err
        if (timedOut) {
          throw new Error(`timed out after ${Math.round(this.#config.requestTimeoutMs / 1000)}s (no retry: a timeout is not retried)`)
        }
        if (attempt < MAX_MODEL_ATTEMPTS - 1 && isTransientFailure(err)) {
          this.#host.log("debug", "advisor retrying a transient model failure", {
            advisor: advisor?.name,
            error: (err as Error).message,
          })
          continue
        }
        throw new Error(describeFailure(err, attempt + 1, firstError))
      } finally {
        clearTimeout(timer)
        this.#abort.signal.removeEventListener("abort", onAbort)
      }
    }
    throw new Error(describeFailure(firstError, MAX_MODEL_ATTEMPTS, firstError))
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
    /** False when another live instance owns reviewing for this directory. */
    owner: boolean
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
      owner: this.#host.isClaimOwner ? this.#host.isClaimOwner() : true,
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
