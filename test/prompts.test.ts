import { describe, expect, test } from "bun:test"
import { formatAdvisoryBatch, parseAdvisorReply } from "../plugin/prompts.ts"

describe("parseAdvisorReply", () => {
  test("parses a notes response", () => {
    const reply = parseAdvisorReply('{"notes":[{"severity":"concern","note":"x"}]}')
    expect(reply.kind).toBe("notes")
    expect(reply.notes).toEqual([{ severity: "concern", note: "x" }])
  })

  test("parses a tool request", () => {
    const reply = parseAdvisorReply('{"tool":"grep","input":{"pattern":"foo","path":"src"}}')
    expect(reply.kind).toBe("tool")
    expect(reply.tool).toBe("grep")
    expect(reply.input).toEqual({ pattern: "foo", path: "src" })
  })

  test("accepts a bare array or single note", () => {
    expect(parseAdvisorReply('[{"note":"a"}]').notes).toEqual([{ note: "a", severity: undefined }])
    expect(parseAdvisorReply('{"note":"b","severity":"nit"}').notes).toEqual([{ note: "b", severity: "nit" }])
  })

  test("tolerates prose and json fences around the object", () => {
    const reply = parseAdvisorReply('Sure!\n```json\n{"notes":[{"note":"c"}]}\n```\n')
    expect(reply.notes?.[0]?.note).toBe("c")
  })

  test("ignores unknown severities and empty notes", () => {
    const reply = parseAdvisorReply('{"notes":[{"note":"d","severity":"catastrophe"},{"note":"  "}]}')
    expect(reply.notes).toEqual([{ note: "d", severity: undefined }])
  })

  test("flags unparseable output", () => {
    expect(parseAdvisorReply("I have no idea").kind).toBe("invalid")
  })
})

describe("formatAdvisoryBatch", () => {
  test("renders omp-style advisory elements with escaping", () => {
    const text = formatAdvisoryBatch([{ note: "Use A < B & C", severity: "blocker" }], "Security")
    expect(text).toContain('severity="blocker"')
    expect(text).toContain('advisor="Security"')
    expect(text).toContain("A &lt; B &amp; C")
    expect(text).toContain('guidance="weigh, don\'t blindly obey"')
  })
})
