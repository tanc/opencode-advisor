# Review priorities

Reviewer-only guidance. This file is appended to the advisor's system prompt and
is never added to the main agent's context. Keep it specific enough to change a
review decision.

Especially watch for:

- Writes that bypass the durable queue in `src/jobs/`.
- User-controlled text rendered without escaping.
- Schema changes without a backwards-compatible rollout.
- Claims of success that are not supported by a focused runtime check.

@review/security.md
