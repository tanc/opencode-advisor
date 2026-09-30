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
import { AdvisorEngine, parseSelector, type AdvisorEvent, type EngineHost, type ModelRef } from "./engine.ts"
import type { SessionMessage } from "./transcript.ts"

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
        // `ctx.generate.text` resolves models from the location registry. A
        // selector that is not present there (for example a provider defined
        // only in config) cannot be used, so fall back to the default model.
        try {
          const list = await ctx.model.list()
          const available = (list?.data ?? []) as { providerID: string; id: string }[]
          if (selector) {
            const parsed = parseSelector(selector)
            if (parsed) {
              const match = available.find((m) => m.providerID === parsed.providerID && m.id === parsed.id)
              if (match) return { providerID: match.providerID, id: match.id, variant: parsed.variant }
              console.warn(`[advisor] model "${selector}" is not available to plugin generation; using the default model instead`)
            } else {
              console.warn(`[advisor] ignoring invalid model selector "${selector}" (expected provider/model)`)
            }
          }
          const fallback = await ctx.model.default()
          const model = fallback?.data
          return model ? { providerID: model.providerID, id: model.id } : undefined
        } catch (err) {
          console.warn(`[advisor] model resolution failed: ${(err as Error).message}`)
          return undefined
        }
      },
      log(level, message, data) {
        if (level === "warn") console.warn(`[advisor] ${message}`, data ?? "")
        else console.debug(`[advisor] ${message}`, data ?? "")
      },
    }

    const engine = new AdvisorEngine(config, host)

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
            body = "Advisor enabled for this session."
          } else if (args === "off") {
            engine.setSessionEnabled(sessionID, false)
            body = "Advisor disabled for this session."
          } else if (args === "") {
            const enabled = engine.toggleSession(sessionID)
            body = `Advisor ${enabled ? "enabled" : "disabled"} for this session.`
          } else {
            const status = engine.status(sessionID)
            const lines = [
              `Advisor: ${status.enabled ? "enabled" : "disabled"}`,
              ...status.advisors.map((a) => `- ${a.name}: ${a.enabled ? "on" : "paused"} · model ${a.model ?? "(default)"} · ${a.notes} notes`),
              `Notes delivered: ${status.notesDelivered}; backlog: ${status.backlog}`,
            ]
            if (status.lastReviewAt) lines.push(`Last review: ${new Date(status.lastReviewAt).toLocaleTimeString()}`)
            if (status.lastError) lines.push(`Last error: ${status.lastError}`)
            if (args === "dump") {
              for (const advisor of status.advisors) {
                if (advisor.items.length === 0) continue
                lines.push("", `${advisor.name} advice (${advisor.items.length}):`)
                for (const item of advisor.items) lines.push(`- ${item}`)
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

    // Optional bounded catch-up: wait for the advisor when it falls behind.
    if (config.syncBacklog > 0) {
      await ctx.session.hook("context", async () => {
        await engine.waitForBacklog(config.syncBacklog)
      })
    }

    return () => {
      controller.abort()
      engine.dispose()
    }
  },
})
