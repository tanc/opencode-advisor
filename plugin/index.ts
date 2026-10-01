/**
 * advisor — an optional reviewer model for OpenCode v2.
 *
 * Registers a background reviewer that watches a session as it unfolds, can
 * inspect the workspace with read-only `read`/`grep`/`glob`, and injects
 * severity-graded `<advisory>` notes back into the session before mistakes get
 * expensive. It is the OpenCode port of omp's advisor / WATCHDOG subsystem.
 *
 * Loaded by registering this directory (`plugin/`) in `opencode.json` under
 * `plugins`, e.g. `{ "package": "/abs/path/to/opencode-advisor/plugin",
 * "options": { "enabled": true, "model": "anthropic/claude-sonnet-4-5" } }`. It
 * is deliberately *not* under `.opencode/plugins/`: OpenCode loads that
 * directory automatically and does not dedupe, so combining the two loads it
 * twice.
 */
import { Plugin } from "@opencode/plugin"
import { resolveConfig, type AdvisorOptions } from "./config.ts"
import { AdvisorEngine, type AdvisorEvent, type EngineHost, type ModelRef, type NotifyInput } from "./engine.ts"
import { matchModel, type RegistryModel } from "./model.ts"
import type { SessionMessage } from "./transcript.ts"

const AGENT_TOOL_SUFFIX = "/api/openchamber/agent-tool"

/**
 * Base URL for OpenChamber's server, derived from the agent-tool callback URL.
 *
 * `OPENCHAMBER_AGENT_TOOL_URL` is `http://host:port/api/openchamber/agent-tool`
 * in the managed setup, so the origin is usually enough. Stripping the known
 * suffix instead keeps any path prefix a proxied deployment may add (an
 * isolated space is addressed as `/api/spaces/<id>/...`), and falls back to the
 * origin when the URL has an unexpected shape.
 */
export function notificationBases(url: string): { base: string; origin: string } | undefined {
  try {
    const parsed = new URL(url)
    const origin = parsed.origin
    const path = parsed.pathname.replace(/\/+$/, "")
    const base = path.endsWith(AGENT_TOOL_SUFFIX) ? origin + path.slice(0, -AGENT_TOOL_SUFFIX.length) : origin
    return { base, origin }
  } catch {
    return undefined
  }
}

/**
 * Raise a notification through OpenChamber (`POST /api/notifications/emit`),
 * authorized by the managed plugin bearer token. Silent no-op when the plugin
 * is not running under OpenChamber, which is the normal case for other hosts.
 */
async function postNotification(input: NotifyInput): Promise<void> {
  const url = process.env.OPENCHAMBER_AGENT_TOOL_URL
  const token = process.env.OPENCHAMBER_AGENT_TOOL_TOKEN
  if (!url || !token) return
  const bases = notificationBases(url)
  if (!bases) return

  const body = JSON.stringify({
    title: input.title.slice(0, 120),
    body: input.body.slice(0, 500),
    tag: "advisor",
    sessionId: input.sessionID,
    directory: input.directory,
    showWhenFocused: input.showWhenFocused,
  })
  const send = (base: string) =>
    fetch(`${base}/api/notifications/emit`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body,
    })

  let response = await send(bases.base)
  if (response.status === 404 && bases.base !== bases.origin) response = await send(bases.origin)
  if (!response.ok) console.warn(`[advisor] notification emit failed: HTTP ${response.status}`)
}

export default Plugin.define({
  id: "advisor",
  async setup(ctx) {
    const options = (ctx.options ?? {}) as AdvisorOptions
    const directory = ctx.location.directory

    let config
    try {
      config = await resolveConfig(options, directory)
    } catch (err) {
      console.warn(`[advisor] configuration failed: ${(err as Error).message}`)
      return
    }
    for (const warning of config.warnings) console.warn(`[advisor] ${warning}`)

    const controller = new AbortController()

    // Per-session enable overrides are persisted so `/advisor on` survives a
    // plugin reload (OpenChamber reloads plugins on config/plugin changes).
    const storageKey = "sessionEnabled"
    const overrides: Record<string, boolean> = {}
    const persistOverrides = async () => {
      const keys = Object.keys(overrides)
      for (const stale of keys.slice(0, Math.max(0, keys.length - 200))) delete overrides[stale]
      try {
        await ctx.storage.set(storageKey, overrides)
      } catch (err) {
        console.warn(`[advisor] failed to persist session override: ${(err as Error).message}`)
      }
    }

    const host: EngineHost = {
      directory,
      async listMessages(sessionID) {
        const messages = await ctx.session.context({ sessionID })
        return messages as unknown as SessionMessage[]
      },
      async generate({ model, prompt, signal }) {
        const input = model ? { prompt, model } : { prompt }
        const result = await ctx.generate.text(input, { signal } as never)
        return result.text
      },
      async inject({ sessionID, text, description, metadata, delivery, resume }) {
        const message = await ctx.session.synthetic({ sessionID, text, description, metadata: metadata as never, delivery, resume })
        return message?.id
      },
      async resolveModel(selector): Promise<ModelRef | undefined> {
        // `ctx.generate.text` resolves models from the location registry, so a
        // selector that is not there cannot be used. Matching is case-insensitive
        // and canonicalises to the registry's own spelling, because pickers show
        // display names ("GLM-5.3-Flash") while ids are often lowercase.
        try {
          const list = await ctx.model.list()
          const available = (list?.data ?? []) as RegistryModel[]
          const withDefault = async (warning?: string): Promise<ModelRef | undefined> => {
            const model = (await ctx.model.default())?.data
            if (!model) return undefined
            const reachable = available.some(
              (m) => m.providerID === model.providerID && (m.id === model.id || m.modelID === model.id),
            )
            const notes = [
              warning,
              reachable ? undefined : `the location default "${model.providerID}/${model.id}" is not in this location's registry either`,
            ].filter((note): note is string => note !== undefined)
            return { providerID: model.providerID, id: model.id, warning: notes.length > 0 ? notes.join("; ") : undefined }
          }
          if (!selector) return await withDefault()
          const { model, warning } = matchModel(available, selector)
          if (model) return model
          if (warning) console.warn(`[advisor] ${warning}; using the default model instead`)
          return await withDefault(warning)
        } catch (err) {
          console.warn(`[advisor] model resolution failed: ${(err as Error).message}`)
          return undefined
        }
      },
      log(level, message, data) {
        if (level === "warn") console.warn(`[advisor] ${message}`, data ?? "")
        else console.debug(`[advisor] ${message}`, data ?? "")
      },
      async onSessionOverride(sessionID, enabled) {
        if (enabled === undefined) delete overrides[sessionID]
        else overrides[sessionID] = enabled
        await persistOverrides()
      },
      notify(input) {
        void postNotification(input).catch((err) => console.warn(`[advisor] notification failed: ${(err as Error).message}`))
      },
    }

    const engine = new AdvisorEngine(config, host)

    try {
      const stored = await ctx.storage.get(storageKey)
      if (stored && typeof stored === "object" && !Array.isArray(stored)) {
        for (const [id, value] of Object.entries(stored as Record<string, unknown>)) {
          if (typeof value === "boolean") {
            overrides[id] = value
            engine.setSessionEnabled(id, value, false)
          }
        }
      }
    } catch (err) {
      console.warn(`[advisor] failed to read session overrides: ${(err as Error).message}`)
    }

    if (!config.enabled) {
      console.info("[advisor] loaded but disabled; enable with /advisor on or the `enabled` option.")
    }

    // Event stream: a trigger source only (idle / step boundaries / interrupts).
    void (async () => {
      try {
        for await (const raw of ctx.event.subscribe({ signal: controller.signal })) {
          engine.onEvent(raw as unknown as AdvisorEvent)
        }
      } catch (err) {
        if (!controller.signal.aborted) console.warn(`[advisor] event stream ended: ${(err as Error).message}`)
      }
    })()

    // `/advisor [on|off|status|dump]` — session-scoped control and inspection.
    await ctx.command.transform((editor) => {
      editor.add({
        name: "advisor",
        description: "Toggle or inspect the advisor reviewer for this session",
        execute: async ({ sessionID, prompt }) => {
          const args = (prompt?.text ?? "").trim().toLowerCase()
          let body: string
          if (args === "on") {
            engine.setSessionEnabled(sessionID, true)
            body = "Advisor: on for this session. /advisor status for details."
          } else if (args === "off") {
            engine.setSessionEnabled(sessionID, false)
            body = "Advisor: off for this session. /advisor on to turn it back on."
          } else if (args === "default") {
            engine.setSessionEnabled(sessionID, undefined)
            body = `Advisor: back to the plugin default (${engine.status(sessionID).enabled ? "on" : "off"}).`
          } else if (args === "") {
            body = `Advisor: ${engine.toggleSession(sessionID) ? "on" : "off"} for this session.`
          } else {
            const status = engine.status(sessionID)
            const isDump = args === "dump"
            const lines = [
              status.enabled
                ? `Advisor: on${status.override === undefined ? " (plugin default)" : " (this session)"}`
                : "Advisor: off — run /advisor on to enable it for this session",
            ]
            if (status.enabled) {
              for (const a of status.advisors) {
                const state = a.active ? "active" : a.rosterEnabled ? "paused" : "disabled in config"
                lines.push(`${a.name}: ${state} · model ${a.model ?? "(default)"} · ${a.notes} notes`)
              }
            } else {
              lines.push(`Reviewers configured: ${status.advisors.length}`)
            }
            lines.push(
              `Reviews ${status.reviews} · delivered ${status.notesDelivered} · backlog ${status.backlog}` +
                (status.lastReviewAt
                  ? ` · last ${new Date(status.lastReviewAt).toLocaleTimeString()} (${status.lastOutcome ?? `${status.lastNoteCount} notes`})`
                  : " · no review yet"),
            )
            if (status.lastError) lines.push(`Last error: ${status.lastError}`)
            if (status.modelWarning) lines.push(`! ${status.modelWarning}`)
            if (isDump) {
              for (const a of status.advisors) {
                if (a.items.length === 0) continue
                lines.push("", `${a.name} advice (${a.items.length}):`)
                for (const item of a.items) lines.push(`- ${item}`)
              }
            }
            body = lines.join("\n")
          }
          await ctx.session.synthetic({
            sessionID,
            text: body,
            description: "advisor",
            metadata: { advisor: { kind: "command" } },
            delivery: "queue",
            resume: false,
          })
        },
      })
    })

    return () => {
      controller.abort()
      engine.dispose()
    }
  },
})
