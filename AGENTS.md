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
| `plugin/index.ts` | `Plugin.define`, event subscription, the `/advisor` command, the `advisor` pull tool, and the host: synthetic injection, model resolution, notifications, `ctx.storage` |
| `plugin/engine.ts` | observation → review → delivery; session state; routing; backlog |
| `plugin/guard.ts` | `EmissionGuard` (noise, duplicates, per-update budget) and `resolveChannel` (delivery routing) |
| `plugin/claims.ts` | file-based review ownership across processes |
| `plugin/context-line.ts` | the one standing line pushed into the agent's system prompt |
| `plugin/model.ts` | reviewer model selection: selector parsing and registry matching |
| `plugin/prompts.ts` | the advisor system prompt, the JSON tool/notes protocol, and review-prompt assembly |
| `scripts/mutate.ts` | mutation check: deliberate changes must be caught by the suite |
| `plugin/transcript.ts` | session messages → one markdown delta |
| `plugin/tools.ts` | `read` / `grep` / `glob`, executed by the plugin and jailed to the project directory |
| `test/*.test.ts` | 156 tests, no network and no real model |

## Commands

```bash
bun test              # 156 tests
bun run mutate       # 7 deliberate changes must each be caught by the suite
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
  up to `maxToolRounds` (3) per review, one model call each.
- **Advice has two channels.** Pushed reviews raise notes; the `advisor` tool lets the
  agent ask. A tool result renders in OpenChamber's timeline, so the pull channel is
  the only visible one. Pull answers are tombstoned and their tool results are kept
  out of the review delta, so neither channel re-litigates the other. The tool is
  registered `pinned`, though that option's effect is unverified (the schema types it
  only alongside `codemode` and the checkout has no consumer): the plugin cannot inject
  into the main agent's prompt, so the description and a project's `AGENTS.md` are the
  levers that certainly work.
- **One reviewer per directory, arbitrated by file.** `plugin/claims.ts` writes a claim
  (`~/.cache/opencode-advisor/claims/<key>-<pid>.json`) at setup; the newest claim from
  a live pid owns reviewing, and anyone else skips it — visibly, in `/advisor status`.
  File-based because in-memory state is per module evaluation: a reloaded module sees
  only itself and another process sees nothing at all, so only a file can coordinate
  the two-servers case. Every path fails open — a broken claim directory means "review
  anyway", never a silently disabled reviewer.
- **Delivery is `ctx.session.synthetic`** with `delivery: "steer" | "queue"` and
  `resume`. Notes carry `metadata.advisor`, and `isAdvisorMessage` makes the reviewer
  ignore its own output.
  A failed injection does not drop the pass: a steer is retried queued, a
  queue/preserve failure is logged and the note left *unrouted*, so a later pass can
  raise it again. Considered and rejected: post-hoc delivery verification against the
  inbox API (magic-context verifies admission in its own store). The returned id
  already gates the counters, `SessionInput.admit` accepts any delivery and promotes a
  pending steer on the next run, and zero losses were observed across the measured
  sessions — an HTTP round trip per note would add a failure mode to the delivery
  path to guard against one that has never occurred.
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
7. **A reviewer that cannot run says so.** A model selector that cannot be resolved,
   or a model call that fails, delivers one notice per distinct failure and records
   `modelWarning` for `/advisor status`. Silence must mean "nothing to report", never
   "failing quietly".
8. **A nit cannot outlive its turn.** Nits are dropped on a settled turn; a concern or
   blocker still lands.
9. **Only your work is reviewed.** A session is skipped when its agent is hidden
   (`historian`, `dreamer-*`, `compaction`, `title`) or subagent-mode (`explore`), or
   when its location is not this instance's directory. The verdict is cached per
   session and fails open on an unusable roster.
10. **Our own shutdown is not a failure.** A reload or dispose cancels an in-flight
    call, and the SDK reports that as a transport error; the review catch checks
    `this.#abort.signal.aborted` first and stays silent, because a notice per edit
    makes every save look like an outage.
11. **Review counters outlive a plugin instance.** They are persisted per session
    through `ctx.storage` and re-seeded at setup, so `/advisor status` after a reload
    reports the session's history rather than zero.
12. **Project docs are read per review.** AGENTS.md and WATCHDOG.md are re-read on
    a 10 s TTL, then carried through warnings included, so editing a doc lands within
    seconds instead of at the next plugin reload — and a malformed file is reported
    once rather than silently shrinking the reviewer's context.
13. **Injected items carry `raisedAt`.** Notes, notices and command replies stamp the
    moment they were raised (`metadata.advisor.raisedAt`), which is what makes delivery
    lag measurable: a queued item surfaces at the next turn boundary, not when raised.
14. **One reviewer per directory.** Reviewing is gated on a file-based claim
    (`plugin/claims.ts`); the newest live claim wins, and a non-owner says so in
    `/advisor status` rather than failing silently. Every path fails open.
15. **A model call cannot wedge a session.** Every reviewer call carries a deadline
    (`requestTimeoutMs`, 90 s) and is retried once on a fast transient transport
    failure — not on a timeout, which would double the wait. A hung endpoint used to
    block that session's review queue for minutes; it now fails and is reported.
    The notice names the attempt count and the first error, so "upstream service
    timeout" is decodable without knowing which build produced it.
16. **Advice that arrives after the answer asks for a restatement.** Any note raised
    on a turn whose tail was a terminal answer carries an `advisory-closeout` line,
    so the agent ends with a complete restatement rather than leaving the answer
    buried above the exchange, whatever the delivery channel. The channel gate was
    removed after the household session falsified its premise: queued nits landed
    33 s after the answer and were acted on within the same turn — "queued means
    read next turn" described the delivery mechanism, not the agent's behaviour.
    The standing context line (invariant 17) instructs the restatement for any note
    after a final answer too; no per-note "what to do next" copy exists, or it would
    repeat that line on every note.
17. **The prompt-time line is constant and single.** `plugin/context-line.ts` pushes
    one byte-identical line per request, only on a session whose advisor is on, from
    every instance that loads the plugin. Three properties force that shape: the
    callback runs once per provider request, several instances share one draft, and a
    varying system block rewrites the provider's cached prefix every step. Claim
    ownership is deliberately **not** consulted: it arbitrates reviewing, not
    prompt-building, and the process that serves a session's prompts need not be the
    one that reviews it — the ownership gate left the line absent exactly where it
    mattered, which the household session then demonstrated end to end (no
    restatement after two queued nits).

## Platform constraints (learned the hard way)

- `ctx.generate.text` takes **`{ prompt, model }` only** — no `system` field, no cache
  controls — and resolves models **solely from `ctx.model.list()`**, matched against
  the registry's exact ids and case-sensitively at the platform level. Custom
  providers defined only in `opencode.json` (e.g. `bifrost`) are absent from that
  registry. `plugin/model.ts` matches case-insensitively on `id`/`modelID` and
  returns the registry's canonical spelling, so a display-name-shaped selector
  (`GLM-5.3-Flash` for id `glm-5.3-flash`) still resolves.
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
- Agents carry `mode` (`primary` / `subagent` / `all`) and `hidden`; companion plugins
  add hidden primary agents that run background sessions (Magic Context's `historian`
  and `dreamer-*`, which alone accounted for ~18 of the 40 most recent sessions on this
  machine). Reviewing those is what makes the advisor look like it never stops.
- **Two OpenCode servers can be running at once** — OpenChamber's managed service and
  the desktop app's own bundled CLI (`~/.config/openchamber/managed-opencode/<pid>.json`).
  Because `OPENCODE_CONFIG` is additive, both read the global config and both load the
  plugin, so duplication can span processes, where only a file-based claim could
  coordinate it. `/advisor status` reports the live instance count for one process;
  it cannot see the other.
- `ctx.session.hook(name, cb)` accepts a plain `async` callback and **does not validate
  the name**: a deliberately bogus name (`definitely-not-a-hook`) loads exactly like a
  real one, so a typo fails silently rather than loudly.
- **The `"context"` hook is dispatch-and-forget, and a synchronous `draft.system` push
  reaches the request.** Measured on
  the app's bundled server: the callback receives `{sessionID, system[], messages[],
  options, model, agent, tools}` and runs once per provider request (per step); a 25 s
  sleep inside it delayed nothing, so the host does not await it; and a synchronous
  `draft.system.push(...)` **does reach the wire** — a token written to no log and no
  tool result was found in the outgoing body (835 KB, cloned from
  `http.request`'s `Request` and read there). Because it is not awaited, anything
  needing an `await` (storage, session context) arrives after the request is built, so
  a *blocking* catch-up hook is still impossible — which is why `syncBacklog` stayed
  removed. The per-step cadence is why the one thing pushed there
  (`plugin/context-line.ts`) is a constant, byte-identical line, and why only the
  claim owner registers it.
  Only `system` was tested: nothing here proves that mutating `messages` behaves the
  same way, and no reader should infer it.
- **Probe hygiene, learned twice the hard way.** Log a hash of a secret, never the
  secret; and read the in-hook "the callback ran" line before reading a negative as a
  result — a `pushed len=` line was once deleted unread, and a marker already present
  in the transcript produced a false positive that briefly reversed a conclusion.
  A probe that logged the first 12 characters of its own token was not echo-free
  either: `PROBE-` is six characters, so the "prefix" was the entire nonce. Of the
  model-side negative runs only the second is defensibly clean, and the conclusion
  finally rested on the later push-only wire test, which logged booleans and lengths
  and never the token.

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
