/**
 * Process-wide bookkeeping for plugin instances.
 *
 * One OpenCode process can hold several instances of this plugin at once: a
 * reload creates a new one, and configuration changes fan out to every active
 * location. That multiplicity matters, because each engine keeps its own
 * session state — its own dedupe history, note budget, blocker cap and immune
 * window — so N instances review a session N times and every damper we build
 * only damps its owner.
 *
 * Module state is the only channel these instances share, which is why this
 * lives here: `liveInstances()` is the count that settles whether there really
 * is more than one reviewer, and it is the same channel a coordination fix
 * would have to use.
 */

let live = 0

export function instanceOpened(): void {
  live += 1
}

export function instanceClosed(): void {
  live = Math.max(0, live - 1)
}

export function liveInstances(): number {
  return live
}
