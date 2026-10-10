/**
 * Render an OpenCode session transcript into the markdown the advisor reviews.
 *
 * `ctx.session.context({sessionID})` returns the whole conversation, including
 * assistant reasoning and every tool call with its input and result. The engine
 * diffs that list by message id and renders only the new slice, so each review
 * sees a delta rather than the full history (cheap and prompt-cache friendly).
 */

interface ToolContent {
  type: string
  text?: string
  uri?: string
  name?: string | null
}

interface ToolState {
  status?: string
  input?: unknown
  content?: ToolContent[]
  error?: { message?: string; type?: string } | string
}

interface ContentPart {
  type: string
  text?: string
  id?: string
  name?: string
  state?: ToolState
}

/** Our own pull-tool output, kept out of the review delta. */
const ADVISOR_TOOL_NAME = "advisor"

export interface SessionMessage {
  id?: string
  type?: string
  text?: string
  description?: string
  metadata?: Record<string, unknown>
  agent?: string
  content?: ContentPart[]
  finish?: string
  error?: { message?: string; type?: string }
}

/** True when a message is an advisory this plugin injected (never re-review it). */
export function isAdvisorMessage(message: SessionMessage): boolean {
  const meta = message.metadata
  return !!(meta && typeof meta === "object" && "advisor" in meta)
}

function renderInput(input: unknown): string {
  if (input === undefined) return ""
  if (typeof input === "string") return input
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return String(input)
  }
}

function renderToolContent(content: ToolContent[] | undefined): string {
  if (!content || content.length === 0) return ""
  const parts: string[] = []
  for (const part of content) {
    if (part.type === "text" && typeof part.text === "string") parts.push(part.text)
    else if (part.type === "file") parts.push(`[file ${part.name ?? part.uri ?? ""}]`)
  }
  return parts.join("\n")
}

function renderAssistant(message: SessionMessage, includeThinking: boolean): string {
  const blocks: string[] = []
  for (const part of message.content ?? []) {
    if (part.type === "text" && part.text?.trim()) {
      blocks.push(part.text.trim())
    } else if (part.type === "reasoning" && includeThinking && part.text?.trim()) {
      blocks.push(`<thinking>\n${part.text.trim()}\n</thinking>`)
    } else if (part.type === "tool") {
      // Our own pull-tool answers never feed the pushed review: the reviewer
      // would otherwise re-litigate advice it gave on request.
      if (part.name === ADVISOR_TOOL_NAME) continue
      const state = part.state ?? {}
      const input = renderInput(state.input)
      let block = `**Tool** \`${part.name ?? "?"}\` (${state.status ?? "?"})`
      if (input) block += `\n\`\`\`json\n${input}\n\`\`\``
      if (state.status === "completed") {
        const result = renderToolContent(state.content)
        if (result) block += `\nResult:\n${result}`
      } else if (state.status === "error") {
        const err = typeof state.error === "string" ? state.error : state.error?.message
        if (err) block += `\nError: ${err}`
      }
      blocks.push(block)
    }
  }
  return blocks.join("\n\n")
}

function renderOne(message: SessionMessage, includeThinking: boolean): string {
  switch (message.type) {
    case "user":
      return `**User**\n${message.text?.trim() ?? ""}`
    case "assistant":
      return renderAssistant(message, includeThinking)
    case "synthetic":
      return message.description ? `**${message.description}**\n${message.text?.trim() ?? ""}` : `**Notice**\n${message.text?.trim() ?? ""}`
    case "system":
      return `**System** (${message.description ?? "notice"}): ${message.text?.trim() ?? ""}`
    case "shell":
      return `**Shell** ${message.description ?? ""}`.trim()
    default:
      return ""
  }
}

export interface RenderOptions {
  includeThinking: boolean
  maxChars: number
  /** Drop the oldest blocks first when the delta exceeds `maxChars`. */
  wip?: boolean
}

/**
 * Render a slice of messages into one markdown block. Returns "" when nothing
 * reviewable is present. The caller passes only messages it has not reviewed.
 */
export function renderDelta(messages: readonly SessionMessage[], options: RenderOptions): string {
  const sections: string[] = []
  for (const message of messages) {
    if (isAdvisorMessage(message)) continue
    const rendered = renderOne(message, options.includeThinking).trim()
    if (rendered) sections.push(rendered)
  }
  if (sections.length === 0) return ""

  let body = sections.join("\n\n")
  if (body.length > options.maxChars) {
    const marker = `…[earlier part of this update elided: ${body.length - options.maxChars} chars]\n\n`
    body = marker + body.slice(body.length - options.maxChars)
  }
  const heading = "### Session update"
  const wip = options.wip ? `\n\n---\n\n[in progress — more steps follow]` : ""
  return `${heading}\n\n${body}${wip}`
}
