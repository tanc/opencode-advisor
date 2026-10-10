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
  - `nit` — a non-interrupting aside at the next step boundary. With no running
    turn there is no next step, so a nit about a settled turn is dropped rather
    than parked in the inbox to arrive stale.
  - `concern` — steers the turn that is already running.
  - `blocker` — steers the running turn; it is exempt from the note *budget*,
    not from the immune window.

  The reviewer never starts a turn: while nothing is streaming every grade is
  preserved for the next turn, so an idle session is never woken and a completed
  answer is never restarted.
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
  `/advisor dump` lists the advice raised so far. Every card is stamped with the
  moment it was generated (date included once it is not today), and is delivered
  immediately while a turn is running rather than queued behind it. Session toggles
  and review counters are persisted,
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
| `immuneTurns`        | `3`        | After a steering note, how many turns every severity stops steering.    |
| `includeThinking`    | `true`     | Include assistant reasoning in the transcript sent to the reviewer.     |
| `discover`           | `true`     | Discover `WATCHDOG.*` files on disk.                                    |
| `maxToolRounds`      | `3`        | Max tool rounds per review (one model call each).                       |
| `maxTranscriptChars` | `30000`    | Max characters of transcript sent per review (latency tracks this).     |
| `requestTimeoutMs`   | `90000`    | Deadline per reviewer model call; a fast transient failure is retried once. |
| `notify`             | `off`      | `off`/`away`/`always`: also raise an OpenChamber notification per note.  |
| `contextLine`        | `true`     | Push one constant line into the agent's system prompt: advice that lands after a final answer gets a restatement. |

Environment overrides (useful when auto-discovered, since discovery passes no
options): `ADVISOR_ENABLED`, `ADVISOR_MODEL`, `ADVISOR_INSTRUCTIONS`,
`ADVISOR_MAX_NOTES`, `ADVISOR_IMMUNE_TURNS`,
`ADVISOR_INCLUDE_THINKING`, `ADVISOR_DISCOVER`, `ADVISOR_NOTIFY`.

### Model selection

`ctx.generate.text` resolves models from the location's model registry. Custom
providers defined **only** in `opencode.json` (for example a private
OpenAI-compatible endpoint) are *not* in that registry and cannot be used for
plugin generation, even though a session can run on them.

The selector is `provider/model`, with `provider` and `model` matched
case-insensitively and resolved back to the registry's own spelling. That
matters in practice: model pickers display names like `GLM-5.3-Flash` while the
id is `glm-5.3-flash`, and a selector that does not match leaves the advisor
unable to run at all. Write the id when you can, and let the case-insensitivity
cover the rest.

If the configured selector cannot be resolved, the advisor **says so in the
session** (once per distinct failure) and in `/advisor status`, then falls back
to the location default. A reviewer that cannot call its model must never be
indistinguishable from one with nothing to say — silence is a valid outcome,
failing silently is not.

## Advice that lands after the answer

A review triggered at a step boundary finishes one model call after that step, so
a note can arrive while the agent is still finishing up — after it has already
written what looked like its final answer. Acting on the note then leaves the
answer buried above the rest of the exchange.

Two mechanisms address that, and neither wakes a settled session. A note steered
into a turn whose tail was a terminal answer carries an `advisory-closeout` line
asking the agent to finish with a complete restatement; a note that waits for the
next turn does not, since by then the reader already has the answer. And with
`contextLine` (default on) one constant line saying the same thing is pushed into
the agent's system prompt for the whole session — deliberately constant, because
the hook runs once per provider request and anything variable there would rewrite
the provider's cached prefix on every step of a turn.

## Pull advice on demand

Besides watching, the plugin registers an `advisor` tool the agent can call
itself. The tool ships the session transcript to the reviewer with the agent's
question and returns short, actionable advice (what to do next, in what order,
what to watch out for) as the tool's own result.

That channel matters because a tool result renders in OpenChamber's timeline —
the one place plugin advice is visible without OpenChamber changes. The agent
is told to call it before committing to an approach, when stuck, and before
declaring done.

- Gated by the same per-session switch as the watcher: with the advisor off,
  the tool refuses (`/advisor on` to enable).
- One answer at a time per session.
- Requested advice is recorded as already-raised, so the pushed review pass
  never re-litigates it, and the tool's result is kept out of the review delta.
- The advice answers from the transcript only — it does not inspect files.

## Telling the agent when to consult the tool

There is no shipped `WATCHDOG.md`, and `WATCHDOG.md` is the wrong place for this
anyway: it is *reviewer-only* guidance, appended to the advisor's own system
prompt, and the main agent never sees it.

The plugin also cannot inject into the main agent's prompt — the v2 plugin
context has no config hook and no instructions domain, so guidance has to arrive
through one of these channels:

1. **The tool's own description** (shipped, always present). It already carries
the timing rules, and the tool is registered `pinned` in the hope of keeping it in front of
the model — its effect is unverified, so treat the description and `AGENTS.md`
as the levers that certainly work.
2. **Your project's `AGENTS.md`** (or `CLAUDE.md`) — read by the main agent, and
   by the reviewer as extra context. Add a short section:

   ```md
   ## Advisor
   Call the `advisor` tool before committing to an approach, when stuck, and
   before declaring a task complete. Weigh its advice; override only with
   primary-source evidence that contradicts a specific claim.
   ```

3. **A discovered `WATCHDOG.md`** if you want the *reviewer* to expect that
   behaviour (for example, to stop it re-raising what the advisor already said).

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
2. The plugin reads the session transcript and renders the slice from the start of
   the current turn as markdown (user turns, assistant text, reasoning, and every
   tool call with its input and result). Advisor-injected messages are skipped.
   Reviewing the whole turn rather than the last step matters: a one-step slice is
   partial evidence, and a reviewer reasoning from it asserts state it has not
   checked.
3. For each enabled advisor it builds the system prompt (baseline + shared and
   per-advisor instructions + `WATCHDOG.md` blocks) and calls the reviewer model.
4. The reviewer replies with exactly one JSON object: either a tool request
   (`{"tool":"grep","input":{...}}`), findings
   (`{"notes":[{"severity":"concern","note":"..."}]}`), or a silent retraction
   (`{"retractions":["..."],"notes":[]}`) that withdraws an earlier note without
   the agent ever seeing it. Tool requests are executed read-only and fed back, up
   to `maxToolRounds`.
5. Notes pass the emission guard, are routed by severity and session state, and
   are injected as `<advisory>` synthetic messages. Mid-turn reviews happen at most
   once every 30 s, and at most two blockers are delivered per user turn — past
   that a blocker is far more likely to be churn than signal, and the turn-end pass
   can still raise it.
6. Every reviewer model call has a deadline (`requestTimeoutMs`, 90 s) and is retried
   once on a fast transient transport failure. A call that times out is not retried —
   that only doubles the wait — so an unreachable endpoint costs one bounded pause and
   a visible notice, never a stuck review queue.

## Which sessions get reviewed

Only your own work. Before reviewing, the plugin reads the session and skips it when
the agent is not one you drive:

- **Hidden agents are skipped.** `compaction`, `title`, `summary`, and whatever a
  companion plugin adds — Magic Context's `historian` and `dreamer-*` sessions are
  the common case. They run continuously in the background, so reviewing them means
  producing notes while your own session sits idle.
- **Subagent sessions are skipped** (`mode: "subagent"`, e.g. `explore`), since a
  reviewer advising a subagent advises nobody.
- **Sessions in another location are skipped.** Each instance only reviews work in
  its own directory, so a reviewer is never jailed to the wrong repository.

The verdict is cached per session for five minutes, and it fails open: an
unreadable agent roster means everything is reviewed, rather than nothing.

## Cost, quietness, and safety

- The advisor has its own model usage and cost. Prefer a fast, inexpensive
  reviewer for routine work, or leave it off.
- Silence is the default outcome: the prompt tells the reviewer to advise only on
  concrete technical risk, and the guard drops noise and repeats in code.
- The reviewer never starts a turn. A note can only interrupt work that is
  already streaming; on an idle or settled session every grade is preserved for
  the next turn instead of resuming the agent.
- After a steering note, `immuneTurns` downgrades further notes to queued
  ones for the next few turns — blockers included. One interruption stays one
  interruption however it is reworded.
- A per-user-turn steering cap (4) is a final safety net against loops.
- Reviewers are read-only. Mutating tool grants from omp (`edit`, `write`,
  `bash`, `eval`) are intentionally not supported.

## Differences from omp

- The reviewer is a stateless `ctx.generate.text` call with a JSON tool protocol,
  not a full forked agent loop.
- Notes are injected with `ctx.session.synthetic`. A `steer`/`queue` note rides
  a turn that is already running; a `preserve` note arrives with `resume: false`,
  so it is durably enqueued and enters context on the next turn.
- Tool grants are limited to the read-only set.
- There is no transcript persistence to `__advisor*.jsonl` or per-advisor
  token/cost reporting (the generation API returns text only).

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

## Notifications (OpenChamber)

Because notes are invisible in OpenChamber's timeline, the advisor can also page
you. OpenChamber exposes `POST /api/notifications/emit` to plugins running in
the managed OpenCode, authorized by the agent-tool bearer token:

```ts
// what the plugin does when a note is delivered and `notify` is not `off`
await fetch(`${base}/api/notifications/emit`, {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.OPENCHAMBER_AGENT_TOOL_TOKEN}` },
  body: JSON.stringify({ title: "Advisor · concern", body, tag: "advisor", sessionId, directory, showWhenFocused }),
})
```

`base` is `OPENCHAMBER_AGENT_TOOL_URL` with its `/api/openchamber/agent-tool`
suffix removed, falling back to the URL's origin — so a deployment that adds a
path prefix keeps it. Set `notify` to `away` (only while OpenChamber is not
focused; the server's default) or `always` (`showWhenFocused: true`).

A `blocker` is treated as urgent: it sets `showWhenFocused: true` even under
`away`, so a critical finding pages you while you are looking at OpenChamber —
without waking the agent. `off` suppresses notifications entirely, blockers
included. The route is rate limited to 10 notifications per 10 s and respects
the `nativeNotificationsEnabled` setting. Outside OpenChamber the environment
variables are absent and the call is skipped.

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
- `ctx.generate.text` resolves model refs strictly from the location registry. Whether
  a config-defined provider appears there is location- and config-dependent: `bifrost`
  does here (id `glm_5_3_flash_bf`, with its virtual key in the provider's own
  `headers`), so it is not config-only as earlier notes claimed. A selector that cannot
  be found falls back to the default with a warning. Providers carry headers; the
  plugin cannot set one per call, because the generate API takes `{ prompt, model }`
  only.

156 unit/integration tests cover the emission guard, delivery routing, transcript
rendering, read-only tools, configuration discovery, and the review loop
(`bun test`).

## Limitations

- State lives in the OpenCode server process; a restart resets per-session
  history, cursors, and dedupe memory.
- The reviewer sees the whole current turn, bounded; very large turns are
  truncated from the front.
- Model, token, and cost reporting is not exposed by the generation API.

## Development

```sh
bun install
bun test        # 156 unit/integration tests
bun run mutate # 7 deliberate changes must each be caught by the suite
bunx tsc --noEmit
```

Source layout: `plugin/index.ts` (registration and wiring), `plugin/engine.ts`
(observation, review, delivery), `plugin/config.ts` (options + WATCHDOG
discovery), `plugin/guard.ts` (admission + routing), `plugin/transcript.ts`,
`plugin/tools.ts`, `plugin/prompts.ts`.
