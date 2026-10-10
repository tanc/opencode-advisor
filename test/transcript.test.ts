import { describe, expect, test } from "bun:test"
import { isAdvisorMessage, renderDelta, type SessionMessage } from "../plugin/transcript.ts"

const user: SessionMessage = { id: "m1", type: "user", text: "do the thing" }

const assistant: SessionMessage = {
  id: "m2",
  type: "assistant",
  finish: "tool-calls",
  content: [
    { type: "reasoning", text: "thinking hard" },
    { type: "text", text: "I will edit the file." },
    {
      type: "tool",
      name: "edit",
      state: { status: "completed", input: { path: "a.ts", text: "x" }, content: [{ type: "text", text: "ok" }] },
    },
  ],
}

describe("renderDelta", () => {
  test("renders user, thinking, tools and results", () => {
    const text = renderDelta([user, assistant], { includeThinking: true, maxChars: 10_000 })
    expect(text).toContain("### Session update")
    expect(text).toContain("**User**")
    expect(text).toContain("<thinking>")
    expect(text).toContain("**Tool** `edit` (completed)")
    expect(text).toContain("Result:")
  })

  test("omits thinking when disabled", () => {
    const text = renderDelta([assistant], { includeThinking: false, maxChars: 10_000 })
    expect(text).not.toContain("<thinking>")
  })

  test("skips advisor-injected messages", () => {
    const advisory: SessionMessage = { id: "m3", type: "synthetic", text: "<advisory/>", metadata: { advisor: { slug: "a" } } }
    expect(isAdvisorMessage(advisory)).toBe(true)
    expect(renderDelta([advisory], { includeThinking: true, maxChars: 1000 })).toBe("")
  })

  test("keeps the pull-tool call out of the review delta", () => {
    const withPull: SessionMessage = {
      id: "m4",
      type: "assistant",
      finish: "tool-calls",
      content: [
        { type: "tool", name: "edit", state: { status: "completed", input: { path: "a.ts" }, content: [] } },
        {
          type: "tool",
          name: "advisor",
          state: { status: "completed", input: {}, content: [{ type: "text", text: "1. Do X first" }] },
        },
      ],
    }
    const text = renderDelta([withPull], { includeThinking: true, maxChars: 10_000 })
    expect(text).toContain("**Tool** `edit`")
    expect(text).not.toContain("**Tool** `advisor`")
    expect(text).not.toContain("Do X first")
  })

  test("elides the oldest content past the budget", () => {
    const big: SessionMessage = { id: "b", type: "assistant", content: [{ type: "text", text: "x".repeat(5000) }] }
    const text = renderDelta([big], { includeThinking: true, maxChars: 1000 })
    expect(text).toContain("elided")
    expect(text.length).toBeLessThan(1400)
  })
})

