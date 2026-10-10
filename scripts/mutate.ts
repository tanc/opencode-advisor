/**
 * Mutation check: apply one deliberate change at a time to a throwaway copy of
 * the repo and assert the test suite catches it.
 *
 * Why this exists: every verification failure in this repo's recent history was
 * a measurement that passed for the wrong reason — a probe whose "masked" token
 * was fully logged, a fixture that assumed a delivery rule the code didn't have.
 * A mutation the suite fails to catch points at exactly that class: a claim no
 * test is pinning. Borrowed from magic-context's `mutations.toml` culture.
 *
 * Run with `bun run mutate`. Not part of `bun test`: each mutation runs the full
 * suite (~300 ms) in a copy of the repo, so the live plugin is never running
 * mutated code — edits to `plugin/` hot-reload in place, and a mutated guard
 * briefly live in real sessions is exactly the kind of noise this repo exists
 * to remove.
 */
import { spawnSync } from "node:child_process"
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

interface Mutation {
  name: string
  file: string
  find: string
  replace: string
}

const MUTATIONS: Mutation[] = [
  {
    name: "duplicate detection weakened (Jaccard 0.6 -> 0.99)",
    file: "plugin/guard.ts",
    find: "0.6",
    replace: "0.99",
  },
  {
    name: "our own shutdown reported as a failure (abort guard removed)",
    file: "plugin/engine.ts",
    find: "if (!this.#abort.signal.aborted) this.#host.persistCounters?.(sessionID, this.#countersOf(state))",
    replace: "this.#host.persistCounters?.(sessionID, this.#countersOf(state))",
  },
  {
    name: "close-out hint rides every note (tail gate removed)",
    file: "plugin/engine.ts",
    find: "formatAdvisoryBatch(group, advisor.name, tailFinal)",
    replace: "formatAdvisoryBatch(group, advisor.name, false)",
  },
  {
    name: "a note may resume an idle session (never-resume broken)",
    file: "plugin/engine.ts",
    find: 'resume: to === "steer",',
    replace: "resume: true,",
  },
  {
    name: "standing line injected repeatedly (idempotence removed)",
    file: "plugin/context-line.ts",
    find: "if (present) return false",
    replace: "if (present) return true",
  },
  {
    name: "nits survive a settled turn",
    file: "plugin/engine.ts",
    find: 'if (!streaming && (severity === "nit" || severity === undefined)) {',
    replace: "if (false) {",
  },
  {
    name: "model resolution case-sensitive again",
    file: "plugin/model.ts",
    find: "toLowerCase()",
    replace: "toString()",
  },
]

const root = process.cwd()
const lab = join(tmpdir(), "advisor-mutation-lab")

function runSuite(cwd: string, file?: string): number {
  const args = ["test", "--no-coverage"]
  if (file) args.push(file)
  const result = spawnSync("bun", args, { cwd, stdio: "ignore" })
  return result.status ?? 1
}

// Baseline once, in the lab: a clean copy must pass, or every mutation verdict
// is meaningless.
cpSync(root, lab, { recursive: true, filter: (src) => !src.includes(".git") && !src.includes("node_modules/.cache") })
const baseline = runSuite(lab)
if (baseline !== 0) {
  console.error(`baseline suite FAILED in the lab copy (exit ${baseline}); mutation verdicts would be meaningless`)
  process.exit(1)
}
console.log(`baseline: clean (${lab})`)

let survived = 0
for (const mutation of MUTATIONS) {
  const path = join(lab, mutation.file)
  const original = readFileSync(path, "utf8")
  if (!original.includes(mutation.find)) {
    console.error(`SKIP ${mutation.name}: pattern not found in ${mutation.file} (stale mutation?)`)
    continue
  }
  writeFileSync(path, original.replace(mutation.find, mutation.replace))
  const status = runSuite(lab)
  writeFileSync(path, original)
  if (status === 0) {
    survived += 1
    console.error(`SURVIVED  ${mutation.name} — no test catches this change`)
  } else {
    console.log(`caught    ${mutation.name}`)
  }
}

rmSync(lab, { recursive: true, force: true })
if (survived > 0) {
  console.error(`\n${survived} of ${MUTATIONS.length} mutations survived — those claims are unpinned`)
  process.exit(1)
}
console.log(`\nall ${MUTATIONS.length} mutations caught`)
