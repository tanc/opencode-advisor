import { describe, expect, test } from "bun:test"
import type { AdvisorConfig } from "../plugin/config.ts"
import { AdvisorEngine, type EngineHost, type InjectInput, type ModelRef } from "../plugin/engine.ts"
import type { SessionMessage } from "../plugin/transcript.ts"

function makeConfig(over: Partial<AdvisorConfig> = {}): AdvisorConfig {
  return {
    enabled: true,
    model: "p/m",
    advisors: [{ name: "Advisor", slug: "advisor", enabled: true, tools: [] }],
    syncBacklog: 0,
    immuneTurns: 3,
    includeThinking: true,
    maxToolRounds: 6,
    maxTranscriptChars: 60_000,
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
}

function makeHost(directory: string, messages: SessionMessage[]): FakeHost {
  const host: FakeHost = {
    directory,
    injections: [],
    prompts: [],
    responses: [],
    listCalls: 0,
    async listMessages() {
      host.listCalls += 1
      return messages
    },
    async generate({ prompt }) {
      host.prompts.push(prompt)
      return host.responses.shift() ?? '{"notes":[]}'
    },
    async inject(input) {
      host.injections.push(input)
      return `msg_${host.injections.length}`
    },
    async resolveModel(): Promise<ModelRef> {
      return { providerID: "p", id: "m" }
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
    host.responses.push('{"notes":[{"severity":"nit","note":"Simpler approach available"}]}')
    const engine = new AdvisorEngine(makeConfig(), host)

    await engine.review("s1", false)

    expect(host.prompts).toHaveLength(2)
    expect(host.prompts[1]).toContain("<tool-result")
    expect(host.injections).toHaveLength(1)
    engine.dispose()
  })

  test("respects the per-advisor note budget", async () => {
    const host = makeHost("/repo", [user, midwork])
    host.responses.push(
      '{"notes":[{"severity":"nit","note":"one"},{"severity":"nit","note":"two"},{"severity":"nit","note":"three"}]}',
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
})
