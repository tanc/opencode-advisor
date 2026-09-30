# opencode-advisor

An optional **reviewer model** for OpenCode v2 (and OpenChamber 2.x). A second
model watches a session as it unfolds, can inspect the workspace with read-only
`read`/`grep`/`glob` to verify claims, and injects severity-graded
`<advisory>` notes back into the session before mistakes get expensive.

It is the OpenCode port of omp's [advisor / WATCHDOG
subsystem](https://omp.sh/docs/advisor): a peer-shadow reviewer that enforces the
user's ask, challenges thin verification, and prefers silence over noise. Its
advice is *advice* — the main agent is told to weigh each note against the
user's request, not to obey it blindly.

> The advisor makes its own model requests, uses its own context, and is billed
> separately. It is **off by default**. Use it for long or high-stakes changes,
> unfamiliar repositories, security-sensitive work, or whenever independent
> review is worth more than maximum speed.

## What it does

- **Watches** a session through the event stream. It reads the authoritative
  transcript (`ctx.session.context`) and reviews only the slice it has not seen.
- **Verifies** with read-only tools. `ctx.generate.text` is a stateless one-shot
  call, so the plugin runs a small JSON tool loop itself: the reviewer may ask
  for `read` / `grep` / `glob` before it advises. All tool paths are jailed to the
  project directory and nothing is ever written.
- **Grades** each note `nit` / `concern` / `blocker` and routes it:
  - `nit` — a non-interrupting aside at the next step boundary.
  - `concern` — steers a running turn; a late note after a completed answer is
    preserved as a visible card instead of re-waking the agent.
  - `blocker` — may steer and wake the agent even after a nominally completed
    answer.
- **Filters noise.** Duplicates, content-free self-talk (`"Stop."`, `"LGTM"`,
  `"No issue; continue."`), and over-budget notes are dropped before they reach
  the transcript. Severity escalations (`nit` → `concern` → `blocker`) are
  admitted; equal/lower repeats are not.
- **Injects visibly** as a synthetic message so notes are distinguishable from
  user input and never re-reviewed by the advisor:

  ```text
  <advisory advisor="Security" severity="concern" guidance="weigh, don't blindly obey">
  The token in `src/auth.ts:42` is compared with `==`, not a constant-time comparison.
  </advisory>
  ```

- **Sees the project's standing instructions.** Discovered `AGENTS.md` files are
  added to the reviewer prompt as a `<project-context>` block, so the advisor can
  hold the main agent to the user's own project rules.

- **Registers `/advisor`** — `/advisor` toggles for the session, `/advisor on`
  / `off` set it explicitly, `/advisor default` clears the session override,
  `/advisor status` reports each advisor, its model, and notes delivered, and
  `/advisor dump` lists the advice raised so far. Session toggles are persisted,
  so they survive a plugin reload; set `options.enabled` for a persistent default.

  > **Visibility.** OpenCode v2 gives a plugin no free-form output channel:
  > `command.execute` returns `void`, and OpenChamber's timeline deliberately
  > hides `synthetic`/`system` messages (only `user`, `assistant`, `compaction`
  > and `shell` render). The command result and the advisor's own notes are
  > therefore written as synthetic messages, which render in the OpenCode TUI
  > but not in OpenChamber's timeline — see the note about rendering advisor
  > notices in OpenChamber below.

## Install

**Local path (recommended while developing).** Clone, install, and register the
local `plugin/` directory in `opencode.jsonc`:

```sh
git clone git@github.com:tanc/opencode-advisor.git
cd opencode-advisor
bun install   # or: npm install
```

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/abs/path/to/opencode-advisor/plugin",
      "options": { "enabled": true, "model": "anthropic/claude-sonnet-4-5" }
    }
  ]
}
```

**Any project.** Install straight from the repo; OpenCode fetches it and adds it
to your configuration:

```sh
opencode plugin add github:tanc/opencode-advisor
opencode plugin list
opencode plugin update github:tanc/opencode-advisor
opencode plugin remove github:tanc/opencode-advisor
```

A local plugin must resolve `@opencode/plugin` from its own `node_modules`, which
is why the install step is required; cache-installed packages get it
automatically.

> **Register it in exactly one place.** OpenCode does not dedupe: a plugin that
> is both listed in `plugins` and auto-discovered from `.opencode/plugins/` loads
> **twice**. This repo keeps its source in `plugin/` (not `.opencode/plugins/`)
> precisely so it is never auto-discovered. The explicit entry is also what makes
> **OpenChamber** render an editable options card for it.

## Options

Pass these in the `options` object of the `plugins` entry (or via the
`ADVISOR_*` environment variables).

| option               | default    | meaning                                                                 |
| -------------------- | ---------- | ----------------------------------------------------------------------- |
| `enabled`            | `false`    | Master switch. The advisor costs model requests.                        |
| `model`              | *(default)*| Reviewer model selector `provider/model` (optional `#variant`).         |
| `advisors`           | —          | Inline roster; when present it replaces the on-disk roster.             |
| `instructions`       | —          | Shared guidance prepended to every advisor's system prompt.             |
| `tools`              | `read,grep,glob` | Default investigative tools; `[]` grants none.                    |
| `maxNotesPerUpdate`  | `4`        | Max non-blocker notes accepted per review (`blocker` exempt).           |
| `syncBacklog`        | `off`      | `off`, `1`, `3`, `5`: pause the primary up to 30 s when this many turns behind. |
| `immuneTurns`        | `3`        | After a steering note, how many turns further notes stop steering.      |
| `includeThinking`    | `true`     | Include assistant reasoning in the transcript sent to the reviewer.     |
| `discover`           | `true`     | Discover `WATCHDOG.*` files on disk.                                    |
| `maxToolRounds`      | `6`        | Max tool rounds per review.                                             |
| `maxTranscriptChars` | `60000`    | Max characters of transcript sent per review.                           |

Environment overrides (useful when auto-discovered, since discovery passes no
options): `ADVISOR_ENABLED`, `ADVISOR_MODEL`, `ADVISOR_INSTRUCTIONS`,
`ADVISOR_MAX_NOTES`, `ADVISOR_SYNC_BACKLOG`, `ADVISOR_IMMUNE_TURNS`,
`ADVISOR_INCLUDE_THINKING`, `ADVISOR_DISCOVER`.

### Model selection

`ctx.generate.text` resolves models from the location's model registry. Custom
providers defined **only** in `opencode.json` (for example a private
OpenAI-compatible endpoint) are *not* in that registry and cannot be used for
plugin generation, even though a session can run on them. If the configured
selector is not available, the advisor logs a warning and falls back to the
default model — so review still works everywhere.

## Give the reviewer project-specific priorities

Put reviewer-only guidance in `WATCHDOG.md`. This is the best place for
architectural boundaries, dangerous APIs, recurring failure modes, and the
evidence you expect before a change is called complete. It guides advisors
without adding the same material to the main agent's ordinary context.

```markdown
# Review priorities

Especially watch for:

- Writes that bypass the durable queue in `src/jobs/`.
- User-controlled text rendered without escaping.
- Schema changes without a backwards-compatible rollout.
- Claims of success that are not supported by a focused runtime check.
```

Every readable `WATCHDOG.md` on this path is loaded, user first then ancestors →
current directory (narrower guidance is most prominent):

1. the OpenCode config directory, normally `~/.config/opencode/WATCHDOG.md`;
2. `WATCHDOG.md` and `.opencode/WATCHDOG.md` in the working directory;
3. the same two locations in each parent directory up to the Git root (or your
   home directory when there is no Git root).

A line such as `@review/security.md` imports another file; relative paths resolve
beside the importing file and imports inside code fences stay literal.

## Configure several specialist advisors

Use `WATCHDOG.yml` (or `WATCHDOG.yaml`) when one reviewer is not enough. Once any
roster entry is discovered, the roster replaces the single default advisor.

```yaml
instructions: |
  Prefer fixes that preserve public APIs and keep tests focused.

maxNotesPerUpdate: 4

advisors:
  - name: Architecture
    enabled: true
    model: anthropic/claude-sonnet-4-5#high
    tools: [read, grep, glob]
    instructions: |
      Watch module boundaries, dependency direction, and public API growth.

  - name: Security
    enabled: true
    tools: [read, grep, glob]
    instructions: |
      Trace untrusted input through authentication, storage, and rendering.

  - name: Release
    enabled: false
    tools: []
    instructions: |
      Check migrations, compatibility, and rollback instructions.
```

| field                | purpose                                                                       |
| -------------------- | ----------------------------------------------------------------------------- |
| top-level `instructions` | Shared guidance prepended to every advisor from all discovered files.     |
| `name`               | Required display name; slugified for the session id.                          |
| `enabled`            | Per-advisor switch, default `true`; `false` leaves it visible as paused.      |
| `model`              | Optional selector; omitted uses the plugin default model.                     |
| `tools`              | Optional read-only tool subset; omitted gives `read,grep,glob`, `[]` gives none. |
| `instructions`       | This advisor's specialization; supports `@` imports.                          |
| `maxNotesPerUpdate`  | Per-advisor (or top-level) non-blocker budget.                                |

Roster files use the same discovery path as `WATCHDOG.md`. A more specific file
(project leaf > project ancestor > user) replaces an earlier entry with the same
slug. Invalid YAML or an invalid entry is logged and skipped; it never breaks the
session.

## How a review runs

1. An event (`session.step.ended`, `session.execution.succeeded`, ...) schedules
   a debounced review for that session.
2. The plugin reads the session transcript, diffs by message id, and renders the
   new slice as markdown (user turns, assistant text, reasoning, and every tool
   call with its input and result). Advisor-injected messages are skipped.
3. For each enabled advisor it builds the system prompt (baseline + shared and
   per-advisor instructions + `WATCHDOG.md` blocks) and calls the reviewer model.
4. The reviewer replies with exactly one JSON object: either a tool request
   (`{"tool":"grep","input":{...}}`) or findings
   (`{"notes":[{"severity":"concern","note":"..."}]}`). Tool requests are executed
   read-only and fed back, up to `maxToolRounds`.
5. Notes pass the emission guard, are routed by severity and session state, and
   are injected as `<advisory>` synthetic messages.

`syncBacklog` is implemented as a bounded wait inside the `context` model hook:
when the advisor is behind by the configured number of turns, the next primary
request waits up to 30 seconds for it to catch up.

## Cost, quietness, and safety

- The advisor has its own model usage and cost. Prefer a fast, inexpensive
  reviewer for routine work, or leave it off.
- Silence is the default outcome: the prompt tells the reviewer to advise only on
  concrete technical risk, and the guard drops noise and repeats in code.
- After a user interrupt the advisor never auto-resumes the stopped run; notes
  are preserved as visible cards for the next resume.
- After a steering note, `immuneTurns` downgrades further concerns to queued
  notes. A blocker is exempt.
- A per-user-turn steering cap (4) is a final safety net against loops.
- Reviewers are read-only. Mutating tool grants from omp (`edit`, `write`,
  `bash`, `eval`) are intentionally not supported.

## Differences from omp

- The reviewer is a stateless `ctx.generate.text` call with a JSON tool protocol,
  not a full forked agent loop.
- Notes are injected with `ctx.session.synthetic`. `steer`/`queue` schedule an
  agent turn; a `preserve` note arrives with `resume: false`, so it is durably
  enqueued and appears in the session's pending inbox, entering context on the
  next turn.
- Tool grants are limited to the read-only set.
- There is no `/advisor dump`, transcript persistence to `__advisor*.jsonl`, or
  per-advisor token/cost reporting (the generation API returns text only).

## Advisor notes in OpenChamber

OpenChamber's timeline renders only `user`, `assistant`, `compaction`, and
`shell` messages; every `synthetic`/`system` message is dropped as prompt
plumbing (`packages/ui/src/components/chat/lib/timelineRoles.ts`). Advisor notes
and `/advisor` output are synthetic, so they reach the model (and render in the
plain OpenCode TUI) but do not appear in OpenChamber's timeline. Command output
is posted with `resume: false`, so it also stays in the session inbox until the
next turn.

To show them, OpenChamber needs to treat a synthetic message tagged
`metadata.advisor` as a notice row — the same treatment `compaction`/`shell` get.
The plugin already tags every injected message (`metadata.advisor`), so the
change is entirely on the OpenChamber side:

- `components/chat/lib/timelineRoles.ts` — recognise advisor notices
- `components/chat/MessageList.tsx` — route them to `TimelineNotice`
- `components/chat/lib/attachSyntheticContext.ts` — don't consume them as plumbing
- `components/chat/message/TimelineNotice.tsx` — add an `AdvisorNotice` row

Because OpenChamber adds the message on `session.inbox.enqueued`, a notice would
appear immediately with no model call.

## Verified

Smoke-tested against **OpenCode v2.0.19** (the build OpenChamber ships) with
`@opencode/plugin` 2.0.20, driving a real model through a private server:

- the plugin loads from a `plugins` config entry and `/advisor` appears in the
  registered command list;
- a `WATCHDOG.md` directive (`"raise a blocker whenever the reply contains
  'banana'"`) was discovered and produced exactly one note;
- the note was injected as
  `<advisory advisor="Advisor" severity="blocker" guidance="weigh, don't blindly obey">`
  with `metadata.advisor`, and the main agent weighed it rather than obeying it —
  the full observe → review → inject → respond loop;
- `/advisor status` produced a status card (enqueued in the session inbox);
- `ctx.generate.text` rejects model refs outside the location registry (config-only
  custom providers), which the model resolver handles by falling back to the
  default with a warning.

60 unit/integration tests cover the emission guard, delivery routing, transcript
rendering, read-only tools, configuration discovery, and the review loop
(`bun test`).

## Limitations

- State lives in the OpenCode server process; a restart resets per-session
  history, cursors, and dedupe memory.
- The reviewer sees a bounded text delta; very large sessions are truncated from
  the front of each update.
- `syncBacklog` can delay a primary request by up to 30 seconds when enabled.
- Model, token, and cost reporting is not exposed by the generation API.

## Development

```sh
bun install
bun test        # 60 unit/integration tests
bunx tsc --noEmit
```

Source layout: `plugin/index.ts` (registration and wiring), `plugin/engine.ts`
(observation, review, delivery), `plugin/config.ts` (options + WATCHDOG
discovery), `plugin/guard.ts` (admission + routing), `plugin/transcript.ts`,
`plugin/tools.ts`, `plugin/prompts.ts`.
