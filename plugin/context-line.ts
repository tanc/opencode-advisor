/**
 * The prompt-time context line.
 *
 * OpenCode 2 hands a plugin the request it is about to send through
 * `ctx.session.hook("context", …)`: `system` and `messages` are mutable, the hook
 * is dispatched for an external `{id, setup}` plugin, and the callback is NOT
 * awaited — a 25-second sleep inside it delayed nothing. A push made synchronously
 * does land: with a token that was never written to any log or tool result, the
 * outgoing body (835 KB, cloned and read in an `http.request` hook) contained it.
 *
 * So this is a delivery channel that needs no synthetic and wakes nobody, which
 * is why the advisor uses it for a single standing line rather than for notes.
 * Two measured constraints shape the implementation:
 *
 * - The callback runs once per provider request, i.e. once per step, so anything
 *   variable here would rewrite the provider's cached prefix on every step of a
 *   turn. The line is therefore constant, byte for byte.
 * - Several instances share one draft — six registrations were observed inside a
 *   single 100 ms window — so the hook is registered by every instance and the
 *   line is injected at most once per request: per-draft idempotence, not a claim
 *   gate. The claim arbitrates reviewing, not prompt-building, and the process
 *   that serves a session's prompts need not be the one that reviews it — gating
 *   on ownership left the line absent exactly where it mattered.
 */

export const STANDING_PREFIX = "[advisor]"

export const STANDING_LINE =
  STANDING_PREFIX +
  " If a reviewer note arrives after you have written your final answer, deal with it and then finish with a complete restatement of that answer, so the latest one stands on its own."

export interface SystemPart {
  type?: string
  text?: string
}

/**
 * Append the standing line to a draft's system parts, at most once per request.
 * Returns whether it was added. Never throws: a hook that throws would be the
 * plugin's fault arriving in the middle of the host's request path.
 */
export function injectStandingLine(system: unknown): boolean {
  if (!Array.isArray(system)) return false
  const parts = system as SystemPart[]
  const present = parts.some((p) => typeof p?.text === "string" && p.text.startsWith(STANDING_PREFIX))
  if (present) return false
  parts.push({ type: "text", text: STANDING_LINE })
  return true
}

export interface ContextLineDeps {
  /** Whether the advisor is on for a session; off leaves its prompt untouched. */
  isActive: (sessionID: string) => boolean
  onError?: (error: Error) => void
}

export interface ContextLineDraft {
  sessionID?: string
  system?: unknown
}

export type ContextLineHook = (draft: ContextLineDraft) => void

/**
 * Ownership is re-read on a TTL rather than trusted forever: it can move to a
 * newer instance, and a hook still injecting on a former owner would double the
 * line instead of stepping aside.
 */
export function createContextLineHook(deps: ContextLineDeps): ContextLineHook {
  return (draft) => {
    try {
      if (!draft.sessionID) return
      if (!deps.isActive(draft.sessionID)) return
      injectStandingLine(draft.system)
    } catch (err) {
      deps.onError?.(err as Error)
    }
  }
}
