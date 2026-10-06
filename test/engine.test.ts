import { describe, expect, test } from "bun:test"
import type { AdvisorConfig } from "../plugin/config.ts"
import { AdvisorEngine, type EngineHost, type InjectInput, type ModelRef, type NotifyInput, type PersistedCounters } from "../plugin/engine.ts"
import type { SessionMessage } from "../plugin/transcript.ts"

function makeConfig(over: Partial<AdvisorConfig> = {}): AdvisorConfig {
  return {
    enabled: true,
    model: "p/m",
    advisors: [{ name: "Advisor", slug: "advisor", enabled: true, tools: [] }],
    immuneTurns: 3,
    includeThinking: true,
    maxToolRounds: 6,
    maxTranscriptChars: 60_000,
    requestTimeoutMs: 45_000,
    notify: "off",
    watchdogBlocks: [],
    warnings: [],
    ...over,
  }
}

interface FakeHost extends EngineHost {
  injections: InjectInput[]
  prompts: string[]
  responses: string[]
  listCalls: number
  persisted: PersistedCounters[]
  model?: ModelRef
  generateError?: string
  session?: { agent?: string; location?: { directory?: string } }
  agents?: { id: string; mode?: string; hidden?: boolean }[]
}

function makeHost(directory: string, messages: SessionMessage[]): FakeHost {
  const host: FakeHost = {
    directory,
    injections: [],
    prompts: [],
    responses: [],
    listCalls: 0,
    persisted: [],
    persistCounters(_sessionID, counters) {
      host.persisted.push(counters)
    },
    async listMessages() {
      host.listCalls += 1
      return messages
    },
    async generate({ prompt }) {
      host.prompts.push(prompt)
      if (host.generateError) throw new Error(host.generateError)
      return host.responses.shift() ?? '{"notes":[]}'
    },
    async inject(input) {
      host.injections.push(input)
      return `msg_${host.injections.length}`
    },
    async getSession() {
      return host.session
    },
    async listAgents() {
      return host.agents ?? []
    },
    async resolveModel(): Promise<ModelRef> {
      return host.model ?? { providerID: "p", id: "m" }
    },
    log() {},
  }
  return host
}

const user: SessionMessage = { id: "m1", type: "user", text: "do the thing" }
const terminal: SessionMessage = { id: "m2", type: "assistant", finish: "stop", content: [{ type: "text", text: "done" }] }
const midwork: SessionMessage = {
  id: "m3",
  type: "assistant",
  finish: "tool-calls",
  content: [{ type: "tool", name: "edit", state: { status: "completed", input: {}, content: [] } }],
}

describe("AdvisorEngine", () => {
  test("preserves a concern as a visible note after a terminal answer", async () => {
    const host = makeHost("/repo", [user, terminal])
    host.responses.push('{"notes":[{"severity":"concern","note":"Off-by-one in foo.ts"}]}')
    const engine = new AdvisorEngine(makeConfig(), host)

    await engine.review("s1", false)

    expect(host.injections).toHaveLength(1)
    expect(host.injections[0]!.delivery).toBe("queue")
    expect(host.injections[0]!.resume).toBe(false)
    expect(host.injections[0]!.text).toContain('severity="concern"')
    expect(host.injections[0]!.text).toContain("Off-by-one in foo.ts")
    expect(host.injections[0]!.metadata?.advisor).toBeDefined()
    engine.dispose()
  })

  test("steers a concern while work is still streaming", async () => {
    const host = makeHost("/repo", [user, midwork])
    host.responses.push('{"notes":[{"severity":"concern","note":"Wrong path"}]}')
    const engine = new AdvisorEngine(makeConfig(), host)

    await engine.review("s1", true)

    expect(host.injections[0]!.delivery).toBe("steer")
    expect(host.injections[0]!.resume).toBe(true)
    engine.dispose()
  })

  test("does nothing while disabled", async () => {
    const host = makeHost("/repo", [user, terminal])
    const engine = new AdvisorEngine(makeConfig({ enabled: false }), host)

    await engine.review("s1", false)

    expect(host.listCalls).toBe(0)
    expect(host.injections).toHaveLength(0)
    engine.dispose()
  })

  test("suppresses content-free and repeated notes", async () => {
    const messages: SessionMessage[] = [user, terminal]
    const host = makeHost("/repo", messages)
    host.responses.push('{"notes":[{"note":"LGTM"},{"severity":"concern","note":"Real issue"}]}')
    const engine = new AdvisorEngine(makeConfig(), host)
    await engine.review("s1", false)
    expect(host.injections).toHaveLength(1)
    expect(host.injections[0]!.text).toContain("Real issue")

    // A second review sees the same note and drops it as a duplicate.
    messages.push({ id: "m4", type: "assistant", finish: "stop", content: [{ type: "text", text: "more" }] })
    host.responses.push('{"notes":[{"severity":"concern","note":"real issue"}]}')
    await engine.review("s1", false)
    expect(host.injections).toHaveLength(1)
    engine.dispose()
  })

  test("runs the read tool loop before advising", async () => {
    const host = makeHost("/repo", [user, midwork])
    host.responses.push('{"tool":"read","input":{"path":"src/foo.ts"}}')
    host.responses.push('{"notes":[{"severity":"concern","note":"Simpler approach available"}]}')
    const engine = new AdvisorEngine(makeConfig(), host)

    await engine.review("s1", false)

    expect(host.prompts).toHaveLength(2)
    expect(host.prompts[1]).toContain("<inspection")
    expect(host.injections).toHaveLength(1)
    engine.dispose()
  })

  test("respects the per-advisor note budget", async () => {
    const host = makeHost("/repo", [user, midwork])
    host.responses.push(
      '{"notes":[{"severity":"concern","note":"one"},{"severity":"concern","note":"two"},{"severity":"concern","note":"three"}]}',
    )
    const config = makeConfig({
      advisors: [{ name: "Advisor", slug: "advisor", enabled: true, tools: [], maxNotesPerUpdate: 2 }],
    })
    const engine = new AdvisorEngine(config, host)

    await engine.review("s1", false)

    const text = host.injections.flatMap((i) => i.text).join("\n")
    expect(text.match(/<advisory/g)?.length).toBe(2)
    engine.dispose()
  })

  test("seeds to the last user turn so enabling mid-session does not replay history", async () => {
    const messages: SessionMessage[] = [
      { id: "old1", type: "user", text: "old" },
      { id: "old2", type: "assistant", finish: "stop", content: [{ type: "text", text: "old done" }] },
      user,
      terminal,
    ]
    const host = makeHost("/repo", messages)
    host.responses.push('{"notes":[]}')
    const engine = new AdvisorEngine(makeConfig(), host)

    await engine.review("s1", false)

    const prompt = host.prompts[0]!
    expect(prompt).toContain("do the thing")
    expect(prompt).not.toContain("old done")
    engine.dispose()
  })

  test("status separates the session switch from the roster switch", () => {
    const host = makeHost("/repo", [user, terminal])
    const engine = new AdvisorEngine(makeConfig({ enabled: false }), host)

    let status = engine.status("s1")
    expect(status.enabled).toBe(false)
    expect(status.defaultEnabled).toBe(false)
    expect(status.override).toBeUndefined()
    expect(status.advisors[0]!.rosterEnabled).toBe(true)
    expect(status.advisors[0]!.active).toBe(false)

    engine.setSessionEnabled("s1", true)
    status = engine.status("s1")
    expect(status.enabled).toBe(true)
    expect(status.override).toBe(true)
    expect(status.advisors[0]!.active).toBe(true)

    engine.setSessionEnabled("s1", undefined, false)
    status = engine.status("s1")
    expect(status.enabled).toBe(false)
    expect(status.override).toBeUndefined()
    engine.dispose()
  })

  test("persists a session override when one is set", () => {
    const host = makeHost("/repo", [user, terminal])
    const calls: [string, boolean | undefined][] = []
    host.onSessionOverride = (sessionID, enabled) => {
      calls.push([sessionID, enabled])
    }
    const engine = new AdvisorEngine(makeConfig(), host)

    engine.setSessionEnabled("s1", true)
    engine.setSessionEnabled("s1", undefined, false)
    expect(calls).toEqual([["s1", true]])
    engine.dispose()
  })

  test("records a review pass even when it raises no notes", async () => {
    const host = makeHost("/repo", [user, terminal])
    host.responses.push('{"notes":[]}')
    const engine = new AdvisorEngine(makeConfig(), host)

    await engine.review("s1", false)

    const status = engine.status("s1")
    expect(status.reviews).toBe(1)
    expect(status.lastNoteCount).toBe(0)
    expect(status.lastReviewAt).toBeGreaterThan(0)
    expect(status.lastError).toBeUndefined()
    engine.dispose()
  })

  test("marks a mid-turn pass as in progress", async () => {
    const messages: SessionMessage[] = [user, terminal]
    const host = makeHost("/repo", messages)
    host.responses.push('{"notes":[]}')
    const engine = new AdvisorEngine(makeConfig(), host)

    await engine.review("s1", true)
    expect(engine.status("s1").lastOutcome).toBe("no notes (in progress)")

    messages.push({ id: "m4", type: "assistant", finish: "stop", content: [{ type: "text", text: "settled" }] })
    host.responses.push('{"notes":[]}')
    await engine.review("s1", false)
    expect(engine.status("s1").lastOutcome).toBe("no notes")
    engine.dispose()
  })

  test("notifies once when a note is delivered", async () => {
    const host = makeHost("/repo", [user, terminal])
    const calls: NotifyInput[] = []
    host.notify = (input) => {
      calls.push(input)
    }
    host.responses.push('{"notes":[{"severity":"concern","note":"Guard the empty case"}]}')
    const engine = new AdvisorEngine(makeConfig({ notify: "away" }), host)

    await engine.review("s1", false)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.title).toBe("Advisor · concern")
    expect(calls[0]!.body).toContain("Guard the empty case")
    expect(calls[0]!.showWhenFocused).toBe(false)
    expect(calls[0]!.directory).toBe("/repo")
    engine.dispose()
  })

  test("never notifies when notifications are off", async () => {
    const host = makeHost("/repo", [user, terminal])
    let calls = 0
    host.notify = () => {
      calls += 1
    }
    host.responses.push('{"notes":[{"severity":"blocker","note":"Stop"}]}')
    const engine = new AdvisorEngine(makeConfig({ notify: "off" }), host)

    await engine.review("s1", false)

    expect(calls).toBe(0)
    engine.dispose()
  })

  test("notify always asks to show while focused", async () => {
    const host = makeHost("/repo", [user, terminal])
    const calls: NotifyInput[] = []
    host.notify = (input) => {
      calls.push(input)
    }
    host.responses.push('{"notes":[{"severity":"concern","note":"Note"}]}')
    const engine = new AdvisorEngine(makeConfig({ notify: "always" }), host)

    await engine.review("s1", false)

    expect(calls[0]!.showWhenFocused).toBe(true)
    engine.dispose()
  })

  test("counts the notes a review pass raises", async () => {
    const host = makeHost("/repo", [user, terminal])
    host.responses.push('{"notes":[{"severity":"concern","note":"Guard the empty case"}]}')
    const engine = new AdvisorEngine(makeConfig(), host)

    await engine.review("s1", false)

    expect(engine.status("s1").lastNoteCount).toBe(1)
    expect(engine.status("s1").lastOutcome).toBe("1 notes")
    engine.dispose()
  })

  test("a blocker pages even while the user is looking", async () => {
    const host = makeHost("/repo", [user, terminal])
    const calls: NotifyInput[] = []
    host.notify = (input) => {
      calls.push(input)
    }
    host.responses.push('{"notes":[{"severity":"blocker","note":"This drops the last write"}]}')
    const engine = new AdvisorEngine(makeConfig({ notify: "away" }), host)

    await engine.review("s1", false)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.title).toBe("Advisor · blocker")
    expect(calls[0]!.showWhenFocused).toBe(true)
    engine.dispose()
  })

  test("suppresses a reworded repeat of an earlier note", async () => {
    const messages: SessionMessage[] = [user, midwork]
    const host = makeHost("/repo", messages)
    const engine = new AdvisorEngine(makeConfig(), host)

    host.responses.push('{"notes":[{"severity":"concern","note":"The emit URL is built from the origin so a path prefix is dropped"}]}')
    await engine.review("s1", true)
    expect(host.injections).toHaveLength(1)

    messages.push({ id: "m9", type: "assistant", finish: "stop", content: [{ type: "text", text: "more" }] })
    host.responses.push('{"notes":[{"severity":"concern","note":"Emit URL built from origin drops the path prefix"}]}')
    await engine.review("s1", true)

    expect(host.injections).toHaveLength(1)
    engine.dispose()
  })

  test("grounds each pass in the whole current turn, not just the last step", async () => {
    const messages: SessionMessage[] = [user, midwork]
    const host = makeHost("/repo", messages)
    host.responses.push('{"notes":[{"severity":"nit","note":"one"}]}')
    const engine = new AdvisorEngine(makeConfig(), host)
    await engine.review("s1", true)

    messages.push({ id: "m7", type: "assistant", finish: "tool-calls", content: [{ type: "text", text: "second step" }] })
    host.responses.push('{"notes":[]}')
    await engine.review("s1", true)

    // A one-step slice would have started after the tool call; the turn's user
    // message is what keeps a mid-turn reviewer from reasoning off partial evidence.
    expect(host.prompts[1]).toContain("do the thing")
    engine.dispose()
  })

  test("applies a retraction silently and stops replaying the note", async () => {
    const messages: SessionMessage[] = [user, terminal]
    const host = makeHost("/repo", messages)
    const note = "Reconsider the merge direction before pushing"
    host.responses.push(`{"notes":[{"severity":"blocker","note":"${note}"}]}`)
    const engine = new AdvisorEngine(makeConfig(), host)
    await engine.review("s1", false)
    expect(host.injections).toHaveLength(1)

    messages.push({ id: "m8", type: "assistant", finish: "stop", content: [{ type: "text", text: "more" }] })
    host.responses.push(`{"retractions":["${note}"],"notes":[]}`)
    await engine.review("s1", false)
    expect(host.injections).toHaveLength(1)

    messages.push({ id: "m9", type: "assistant", finish: "stop", content: [{ type: "text", text: "more" }] })
    host.responses.push('{"notes":[]}')
    await engine.review("s1", false)
    expect(host.prompts[2]).not.toContain("<already-raised>")
    engine.dispose()
  })

  test("caps delivered blockers per user turn", async () => {
    const host = makeHost("/repo", [user, midwork])
    const engine = new AdvisorEngine(makeConfig(), host)
    for (let i = 0; i < 3; i++) {
      host.responses.push(`{"notes":[{"severity":"blocker","note":"blocker number ${i}"}]}`)
      await engine.review("s1", true)
    }
    expect(host.injections).toHaveLength(2)
    engine.dispose()
  })

  test("says so once when the configured model cannot be resolved", async () => {
    const host = makeHost("/repo", [user, terminal])
    host.model = { providerID: "p", id: "m", warning: 'the configured model "opencode-go/GLM-5.3-Flash" is not in provider "opencode-go"' }
    host.responses.push('{"notes":[]}')
    const engine = new AdvisorEngine(makeConfig(), host)
    await engine.review("s1", false)

    const notices = host.injections.filter((i) => (i.metadata as { advisor?: { kind?: string } })?.advisor?.kind === "notice")
    expect(notices).toHaveLength(1)
    expect(notices[0]!.delivery).toBe("queue")
    expect(notices[0]!.resume).toBe(false)
    expect(notices[0]!.text).toContain("not in provider")
    expect(engine.status("s1").modelWarning).toContain("not in provider")

    host.responses.push('{"notes":[]}')
    await engine.review("s1", false)
    expect(host.injections.filter((i) => (i.metadata as { advisor?: { kind?: string } })?.advisor?.kind === "notice")).toHaveLength(1)
    engine.dispose()
  })

  test("says so once when the reviewer's model call fails", async () => {
    const host = makeHost("/repo", [user, terminal])
    host.generateError = "Model unavailable: opencode-go/GLM-5.3-Flash"
    const engine = new AdvisorEngine(makeConfig(), host)
    await engine.review("s1", false)

    const notices = host.injections.filter((i) => (i.metadata as { advisor?: { kind?: string } })?.advisor?.kind === "notice")
    expect(notices).toHaveLength(1)
    expect(notices[0]!.text).toContain("Model unavailable")

    await engine.review("s1", false)
    expect(host.injections).toHaveLength(1)
    expect(engine.status("s1").lastOutcome).toBe("model error")
    engine.dispose()
  })

  test("says nothing extra when the model resolves cleanly", async () => {
    const host = makeHost("/repo", [user, terminal])
    host.responses.push('{"notes":[]}')
    const engine = new AdvisorEngine(makeConfig(), host)
    await engine.review("s1", false)
    expect(host.injections).toHaveLength(0)
    expect(engine.status("s1").modelWarning).toBeUndefined()
    engine.dispose()
  })

  test("a nit does not survive a settled turn", async () => {
    const host = makeHost("/repo", [user, terminal])
    const engine = new AdvisorEngine(makeConfig(), host)

    host.responses.push('{"notes":[{"severity":"nit","note":"Consider renaming the flag"}]}')
    await engine.review("s1", false)
    expect(host.injections).toHaveLength(0)

    // The same note while a turn is running still shapes the next step.
    host.responses.push('{"notes":[{"severity":"nit","note":"Consider renaming the flag"}]}')
    await engine.review("s1", true)
    expect(host.injections).toHaveLength(1)
    engine.dispose()
  })

  test("a concern still lands after the turn settles", async () => {
    const host = makeHost("/repo", [user, terminal])
    host.responses.push('{"notes":[{"severity":"concern","note":"The retry loop can spin forever"}]}')
    const engine = new AdvisorEngine(makeConfig(), host)
    await engine.review("s1", false)
    expect(host.injections).toHaveLength(1)
    expect(host.injections[0]!.delivery).toBe("queue")
    engine.dispose()
  })

  test("skips sessions run by auxiliary agents", async () => {
    const roster = [
      { id: "build", mode: "primary", hidden: false },
      { id: "explore", mode: "subagent", hidden: false },
      { id: "historian", mode: "primary", hidden: true },
      { id: "dreamer-memory-mapper", mode: "primary", hidden: true },
    ]
    for (const agent of ["historian", "dreamer-memory-mapper", "explore"]) {
      const host = makeHost("/repo", [user, terminal])
      host.agents = roster
      host.session = { agent, location: { directory: "/repo" } }
      host.responses.push('{"notes":[{"severity":"concern","note":"should not run"}]}')
      const engine = new AdvisorEngine(makeConfig(), host)
      await engine.review("s1", false)
      expect(host.prompts).toHaveLength(0)
      expect(host.injections).toHaveLength(0)
      engine.dispose()
    }
  })

  test("reviews a session run by a visible primary agent", async () => {
    const host = makeHost("/repo", [user, terminal])
    host.agents = [{ id: "build", mode: "primary", hidden: false }]
    host.session = { agent: "build", location: { directory: "/repo" } }
    host.responses.push('{"notes":[{"severity":"concern","note":"real advice"}]}')
    const engine = new AdvisorEngine(makeConfig(), host)
    await engine.review("s1", false)
    expect(host.injections).toHaveLength(1)
    engine.dispose()
  })

  test("skips sessions that belong to another location", async () => {
    const host = makeHost("/repo", [user, terminal])
    host.agents = [{ id: "build", mode: "primary", hidden: false }]
    host.session = { agent: "build", location: { directory: "/elsewhere" } }
    host.responses.push('{"notes":[{"severity":"concern","note":"wrong repo"}]}')
    const engine = new AdvisorEngine(makeConfig(), host)
    await engine.review("s1", false)
    expect(host.injections).toHaveLength(0)
    engine.dispose()
  })

  test("reviews everything when the agent roster is unusable", async () => {
    const host = makeHost("/repo", [user, terminal])
    host.agents = []
    host.session = { agent: "build", location: { directory: "/repo" } }
    host.responses.push('{"notes":[{"severity":"concern","note":"still reviewed"}]}')
    const engine = new AdvisorEngine(makeConfig(), host)
    await engine.review("s1", false)
    expect(host.injections).toHaveLength(1)
    engine.dispose()
  })

  test("pull advice returns the tool answer and tombstones it", async () => {
    const host = makeHost("/repo", [user, terminal])
    host.responses.push("1. Merge feature into test first\n2. Push after CI")
    const engine = new AdvisorEngine(makeConfig(), host)

    const answer = await engine.pullAdvice("s1", "what merge order")
    expect(answer).toContain("Merge feature into test first")
    expect(host.prompts).toHaveLength(1)
    expect(host.prompts[0]).toContain("--- CONVERSATION TRANSCRIPT ---")
    expect(host.prompts[0]).toContain("do the thing")
    expect(host.prompts[0]).toContain("--- QUESTION ---\n\nwhat merge order")

    // The pushed reviewer must treat requested advice as already-raised, not
    // re-litigate it — and the tool result is filtered from the delta, so the
    // tombstone is the only way it knows the advice exists.
    host.responses.push('{"notes":[]}')
    await engine.review("s1", false)
    expect(host.prompts[1]).toContain("<already-raised>")
    expect(host.prompts[1]).toContain("Merge feature into test first")
    engine.dispose()
  })

  test("pull advice is gated by the session switch", async () => {
    const host = makeHost("/repo", [user, terminal])
    const engine = new AdvisorEngine(makeConfig(), host)
    engine.setSessionEnabled("s1", false)
    const answer = await engine.pullAdvice("s1", "anything")
    expect(answer).toContain("/advisor on")
    expect(host.prompts).toHaveLength(0)
    engine.dispose()
  })

  test("one pull at a time per session", async () => {
    const host = makeHost("/repo", [user, terminal])
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    host.generate = async ({ prompt }) => {
      host.prompts.push(prompt)
      await gate
      return "advice"
    }
    const engine = new AdvisorEngine(makeConfig(), host)

    const first = engine.pullAdvice("s1", "first")
    const second = await engine.pullAdvice("s1", "second")
    expect(second).toContain("already answering")
    release()
    expect(await first).toBe("advice")
    engine.dispose()
  })

  test("times out a hung model call instead of wedging the queue", async () => {
    const host = makeHost("/repo", [user, terminal])
    host.generate = ({ prompt, signal }) => {
      host.prompts.push(prompt)
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("The operation was aborted")))
      })
    }
    const engine = new AdvisorEngine(makeConfig({ requestTimeoutMs: 30 }), host)
    await engine.review("s1", false)

    const status = engine.status("s1")
    expect(status.lastOutcome).toBe("model error")
    expect(status.lastError).toContain("timed out after")
    // A timeout is not retried: one attempt, then report.
    expect(host.prompts).toHaveLength(1)
    engine.dispose()
  })

  test("retries a fast transient model failure once", async () => {
    const host = makeHost("/repo", [user, terminal])
    let attempts = 0
    host.generate = async ({ prompt }) => {
      host.prompts.push(prompt)
      attempts += 1
      if (attempts === 1) throw new Error("read ECONNRESET")
      return '{"notes":[{"severity":"concern","note":"recovered advice"}]}'
    }
    const engine = new AdvisorEngine(makeConfig(), host)
    await engine.review("s1", false)

    expect(host.prompts).toHaveLength(2)
    expect(host.injections).toHaveLength(1)
    expect(host.injections[0]!.text).toContain("recovered advice")
    engine.dispose()
  })

  test("retries a provider-side upstream failure once", async () => {
    const host = makeHost("/repo", [user, terminal])
    let attempts = 0
    host.generate = async ({ prompt }) => {
      host.prompts.push(prompt)
      attempts += 1
      // Observed verbatim from opencode-go: a transient upstream error, not a
      // request this plugin can fix.
      if (attempts === 1) throw new Error("Streaming response failed: [server_error] upstream service timeout")
      return '{"notes":[{"severity":"concern","note":"survived an upstream blip"}]}'
    }
    const engine = new AdvisorEngine(makeConfig(), host)
    await engine.review("s1", false)

    expect(host.prompts).toHaveLength(2)
    expect(host.injections).toHaveLength(1)
    expect(host.injections[0]!.text).toContain("survived an upstream blip")
    engine.dispose()
  })

  test("does not retry a permanent failure", async () => {
    const host = makeHost("/repo", [user, terminal])
    host.generate = async ({ prompt }) => {
      host.prompts.push(prompt)
      throw new Error("virtual key is required")
    }
    const engine = new AdvisorEngine(makeConfig(), host)
    await engine.review("s1", false)

    expect(host.prompts).toHaveLength(1)
    expect(engine.status("s1").lastOutcome).toBe("model error")
    engine.dispose()
  })

  test("pull advice fails gracefully instead of throwing", async () => {
    const host = makeHost("/repo", [user, terminal])
    host.generate = async ({ prompt }) => {
      host.prompts.push(prompt)
      throw new Error("socket hang up")
    }
    const engine = new AdvisorEngine(makeConfig(), host)

    const answer = await engine.pullAdvice("s1", "anything")
    expect(answer).toContain("Advisor unavailable")
    expect(answer).toContain("Do not invent advice")
    expect(host.prompts).toHaveLength(2)
    const notices = host.injections.filter((i) => (i.metadata as { advisor?: { kind?: string } })?.advisor?.kind === "notice")
    expect(notices).toHaveLength(1)
    engine.dispose()
  })

  test("a retried failure names the attempt count and the first error", async () => {
    const host = makeHost("/repo", [user, terminal])
    let attempts = 0
    host.generate = async ({ prompt }) => {
      host.prompts.push(prompt)
      attempts += 1
      if (attempts === 1) throw new Error("first: read ECONNRESET")
      throw new Error("last: upstream service timeout")
    }
    const engine = new AdvisorEngine(makeConfig(), host)
    await engine.review("s1", false)

    const notice = host.injections.find((i) => (i.metadata as { advisor?: { kind?: string } })?.advisor?.kind === "notice")
    expect(notice).toBeDefined()
    expect(notice!.text).toContain("2 attempts")
    expect(notice!.text).toContain("first: read ECONNRESET")
    expect(notice!.text).toContain("last: upstream service timeout")
    engine.dispose()
  })

  test("a failure that was not retried says so", async () => {
    const host = makeHost("/repo", [user, terminal])
    host.generate = async ({ prompt }) => {
      host.prompts.push(prompt)
      throw new Error("virtual key is required")
    }
    const engine = new AdvisorEngine(makeConfig(), host)
    await engine.review("s1", false)

    const notice = host.injections.find((i) => (i.metadata as { advisor?: { kind?: string } })?.advisor?.kind === "notice")
    expect(notice!.text).toContain("not retried: not a transient failure")
    engine.dispose()
  })

  test("a plugin shutdown does not page the user", async () => {
    const host = makeHost("/repo", [user, terminal])
    host.generate = ({ signal }) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () =>
          reject(new Error("Connection lost while reading the response: ECONNRESET")),
        )
      })
    const engine = new AdvisorEngine(makeConfig(), host)

    const pending = engine.review("s1", false)
    await new Promise((resolve) => setTimeout(resolve, 5))
    engine.dispose()
    await pending

    // Our own abort is not the endpoint failing: no notice at all.
    expect(host.injections).toHaveLength(0)
  })

  test("a pull during shutdown answers quietly", async () => {
    const host = makeHost("/repo", [user, terminal])
    host.generate = ({ signal }) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("ECONNRESET")))
      })
    const engine = new AdvisorEngine(makeConfig(), host)

    const pending = engine.pullAdvice("s1", "anything")
    await new Promise((resolve) => setTimeout(resolve, 5))
    engine.dispose()
    expect(await pending).toContain("shutting down")
    expect(host.injections).toHaveLength(0)
  })

  test("counters can be seeded, so a reload does not read as never-reviewed", () => {
    const host = makeHost("/repo", [user, terminal])
    const engine = new AdvisorEngine(makeConfig(), host)
    engine.seedCounters("s1", {
      reviews: 50,
      notesDelivered: 37,
      lastNoteCount: 0,
      lastReviewAt: 1_700_000_000_000,
      lastOutcome: "no notes",
    })

    const status = engine.status("s1")
    expect(status.reviews).toBe(50)
    expect(status.notesDelivered).toBe(37)
    expect(status.lastOutcome).toBe("no notes")
    engine.dispose()
  })

  test("a completed pass persists its counters", async () => {
    const host = makeHost("/repo", [user, terminal])
    host.responses.push('{"notes":[]}')
    const engine = new AdvisorEngine(makeConfig(), host)
    await engine.review("s1", false)

    const last = host.persisted.at(-1)
    expect(last?.reviews).toBe(1)
    expect(last?.lastOutcome).toBe("no notes")
    engine.dispose()
  })

  test("a failed pass persists its failure, not just its success", async () => {
    const host = makeHost("/repo", [user, terminal])
    host.generateError = "virtual key is required"
    const engine = new AdvisorEngine(makeConfig(), host)
    await engine.review("s1", false)

    expect(host.persisted.at(-1)?.lastError).toContain("virtual key is required")
    engine.dispose()
  })

  test("command replies are queued when idle and immediate while streaming", async () => {
    const host = makeHost("/repo", [user, terminal])
    host.responses.push('{"notes":[]}', '{"notes":[]}')
    const engine = new AdvisorEngine(makeConfig(), host)
    expect(engine.replyDelivery("s1")).toBe("queue")

    await engine.review("s1", true)
    expect(engine.replyDelivery("s1")).toBe("steer")
    engine.dispose()
  })

  test("a note never resumes an idle session", async () => {
    const host = makeHost("/repo", [user, terminal])
    host.responses.push('{"notes":[{"severity":"blocker","note":"Stop and fix the schema"}]}')
    const engine = new AdvisorEngine(makeConfig(), host)

    await engine.review("s1", false)

    expect(host.injections).toHaveLength(1)
    expect(host.injections[0]!.delivery).toBe("queue")
    expect(host.injections[0]!.resume).toBe(false)
    engine.dispose()
  })

  test("a mid-turn concern steers the running turn", async () => {
    const host = makeHost("/repo", [user, midwork])
    host.responses.push('{"notes":[{"severity":"concern","note":"Check the guard"}]}')
    const engine = new AdvisorEngine(makeConfig(), host)

    await engine.review("s1", true)

    expect(host.injections[0]!.delivery).toBe("steer")
    expect(host.injections[0]!.resume).toBe(true)
    engine.dispose()
  })
})
