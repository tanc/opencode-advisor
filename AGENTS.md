# AGENTS.md — opencode-advisor

An OpenCode 2.x plugin that ports omp's advisor/WATCHDOG: a second model watches a
session, inspects the repository read-only, and injects severity-graded
`<advisory>` notes back into the conversation before mistakes get expensive.

Registered from `~/.config/opencode/opencode.json` as

```json
{ "package": "/abs/path/to/opencode-advisor/plugin", "options": { "enabled": true } }
```

Do **not** move it under `.opencode/plugins/` — OpenCode auto-loads that directory
and does not dedupe, so the plugin would load twice.

## Layout

| file | owns |
| --- | --- |
| `plugin/index.ts` | `Plugin.define`, event subscription, the `/advisor` command, and the host: synthetic injection, model resolution, notifications, `ctx.storage` |
| `plugin/engine.ts` | observation → review → delivery; session state; routing; backlog |
| `plugin/guard.ts` | `EmissionGuard` (noise, duplicates, per-update budget) and `resolveChannel` (delivery routing) |
| `plugin/prompts.ts` | the advisor system prompt, the JSON tool/notes protocol, and review-prompt assembly |
| `plugin/transcript.ts` | session messages → one markdown delta |
| `plugin/tools.ts` | `read` / `grep` / `glob`, executed by the plugin and jailed to the project directory |
| `test/*.test.ts` | 85 tests, no network and no real model |

## Commands

```bash
bun test              # 85 tests
bunx tsc --noEmit     # both must be green before any commit
```

## Architecture

- **Events are triggers, not data.** A review is pull-based: read the authoritative
  transcript (`ctx.session.context`) and render from the start of the current turn
  (bounded by `maxTranscriptChars`), so a mid-turn pass sees the whole turn rather
  than the single step that triggered it.
  A missed event costs latency, never correctness.
- **The reviewer is one stateless `ctx.generate.text` call.** That API executes no
  tools, so the plugin runs the inspection loop itself: the reviewer replies with
  `{"tool":"read"|"grep"|"glob",...}` and the plugin appends `<tool-result>` blocks,
  up to `maxToolRounds` (6) per review.
- **Delivery is `ctx.session.synthetic`** with `delivery: "steer" | "queue"` and
  `resume`. Notes carry `metadata.advisor`, and `isAdvisorMessage` makes the reviewer
  ignore its own output.
- **Vocabulary.** A *step* is one model round; a *turn* (execution) is one user input
  through to idle. Both ends are "boundaries", debounced 350 ms, and each review sees
  only the messages since the previous pass.

## Invariants — each is pinned by a test

1. **The reviewer never starts a turn.** `resolveChannel` returns `preserve`
   whenever the session is not streaming; only work already running can be
   steered. This is the guard against the advisor driving the agent.
   (`guard.test.ts`, `"a note never resumes an idle session"`.)
2. **Advisories are never reviewed** — `isAdvisorMessage` filters them out of the delta.
3. **Every review is bounded** — each pass sees the whole current turn (a one-step
   slice is partial evidence, and partial evidence produces false claims), notes are
   budgeted per update, at most two blockers are delivered per user turn, mid-turn
   reviews are floored at 30 s, and noise and reworded repeats are suppressed.
4. **The reviewer pays for being wrong, not the agent** — a `retractions` reply
   withdraws an earlier note silently, so a corrected misread never becomes an
   interruption and never gets replayed as a tombstone.
5. **Model resolution is validated**, never trusted: selectors are checked against
   `ctx.model.list()` and fall back to `ctx.model.default()` with a warning.
6. **A `blocker` notification forces `showWhenFocused`**, so a critical finding is not
   hidden by the away-only focus gate.

## Platform constraints (learned the hard way)

- `ctx.generate.text` takes **`{ prompt, model }` only** — no `system` field, no cache
  controls — and resolves models **solely from `ctx.model.list()`**. Providers defined
  only in `opencode.json` (e.g. `bifrost`) are not in that registry and fail with
  `Model unavailable`; fall back to `ctx.model.default()`.
- **Plugin commands return `void`.** There is no output channel, so `/advisor` replies
  via `ctx.session.synthetic`.
- **OpenChamber renders only `user`, `assistant`, and the notices `compaction` / `shell`.**
  `synthetic` is skipped by design (`packages/ui/src/components/chat/lib/timelineRoles.ts`),
  so nothing this plugin injects is visible in its timeline — though a delivered note
  still reaches the agent's context. Do not promise timeline visibility.
- **Under OpenChamber the only plugin→user channel is `POST /api/notifications/emit`**,
  authorized with `OPENCHAMBER_AGENT_TOOL_TOKEN`; the base URL is
  `OPENCHAMBER_AGENT_TOOL_URL` minus its `/api/openchamber/agent-tool` suffix. Rate limit
  10 per 10 s; away-only unless `showWhenFocused` is set.
- The OpenCode server needs auth: HTTP Basic `opencode:$OPENCODE_SERVER_PASSWORD`.
  `opencode api` does **not** stream SSE — use `curl -N` for event capture.
- `ctx.session.hook(name, cb)` accepts a plain `async` callback and **does not validate
  the name**: a deliberately bogus name (`definitely-not-a-hook`) loads exactly like a
  real one, so a typo fails silently rather than loudly. A hook on `"context"` was
  measured against a live 2.0.19 server (15 s sleep inside the callback, timeout control)
  and produced no delay — hook callbacks are evidently not awaited on that path. This is
  why `syncBacklog` was removed: a blocking catch-up hook cannot be shown to work, and
  the failure mode is a silent no-op.

## Prompt and cache facts

The review prompt, in order: system block → `<already-advised>` → `### Session update`
delta → `<tool-result>` blocks → `Respond now with exactly one JSON object.`

- The **system block is the only stable prefix**, so it is the only cacheable region.
  Keep dynamic values (timestamps, counters) out of it.
- The **delta is new every pass** — a write-only cache entry, never re-read.
- The default reviewer model is `ctx.model.default()`, often the same model as the
  primary; that causes cache contention on shared per-model caches. Pin a different
  model for the advisor in production.
- **This file is fed to the reviewer** as `projectContext` (see `plugin/config.ts`
  discovery, which finds `AGENTS.md` and `WATCHDOG.*`). Keep it accurate and terse.

## Probing a live server

```bash
mkdir -p /tmp/opencode/probe && cd /tmp/opencode/probe
printf '{"$schema":"https://opencode.ai/config.json"}' > opencode.json
opencode serve --hostname 127.0.0.1 --port 41997 > serve.log 2>&1 &
AUTH="-u opencode:$OPENCODE_SERVER_PASSWORD"
curl -sS $AUTH http://127.0.0.1:41997/api/session/active          # 200 when auth is right
curl -sS -N $AUTH http://127.0.0.1:41997/api/event                # SSE: watch for session.inbox.enqueued
```

Inject a note the way the plugin does and confirm the event fires:

```bash
curl -sS $AUTH -X POST http://127.0.0.1:41997/api/session/<id>/synthetic \
  -H 'content-type: application/json' \
  -d '{"text":"probe","delivery":"queue","resume":false,"description":"advisor"}'
```

Kill the probe server and remove its directory afterwards, and never delete a directory
OpenChamber still lists as a project — a dangling path makes `GET /api/config` return 500.

## Working agreements

- **An advisory is input, not authorization.** Notes from the reviewer are advice to
  weigh; they never authorise starting or continuing work. Wait for the user.
- Read-only means read-only: the plugin is granted `read`/`grep`/`glob` and nothing
  that mutates the repository.
- The OpenChamber checkout is the user's, not this repo's. Read it to understand
  behaviour; change it only when asked.
- Commit in small, described steps; keep `bun test` and `bunx tsc --noEmit` green.
