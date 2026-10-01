/**
 * Reviewer model selection.
 *
 * `ctx.generate.text` resolves models from the location registry, so a selector
 * that is not in that registry cannot be used at all. Matching happens here so
 * it can be unit-tested, and so the two ways a hand-written selector goes wrong
 * are handled instead of failing silently:
 *
 * - **Case.** Pickers show display names (`GLM-5.3-Flash`) while the registry id
 *   is often lowercase (`glm-5.3-flash`). Half of a selector is matched
 *   case-insensitively, and the registry's own spelling is what gets returned.
 * - **Naming.** A registry entry carries both `id` (the catalog key selectors
 *   use) and `modelID` (the name sent to the provider, defaulting to `id`).
 *   Either is accepted for the model half.
 */

export interface ModelRef {
  providerID: string
  id: string
  variant?: string
  /** Set when the selector could not be used as written; surfaced by `/advisor status`. */
  warning?: string
}

/** A model as the location registry reports it. */
export interface RegistryModel {
  providerID: string
  id: string
  modelID?: string
}

export interface ModelMatch {
  model?: ModelRef
  warning?: string
}

/** Parse `provider/model#variant` into a model reference. */
export function parseSelector(selector: string): ModelRef | undefined {
  const trimmed = selector.trim()
  const hash = trimmed.indexOf("#")
  const base = hash === -1 ? trimmed : trimmed.slice(0, hash)
  const variant = hash === -1 ? undefined : trimmed.slice(hash + 1).trim() || undefined
  const slash = base.indexOf("/")
  if (slash <= 0 || slash === base.length - 1) return undefined
  return { providerID: base.slice(0, slash).trim(), id: base.slice(slash + 1).trim(), variant }
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

const MAX_WARNING = 260

function clip(text: string): string {
  return text.length <= MAX_WARNING ? text : `${text.slice(0, MAX_WARNING - 1)}…`
}

/**
 * Match a selector against the location registry. Returns the canonical model,
 * or a warning explaining why the selector cannot be used as written.
 */
export function matchModel(available: readonly RegistryModel[], selector: string): ModelMatch {
  const parsed = parseSelector(selector)
  if (!parsed) {
    return { warning: `the configured model "${selector}" is not a valid selector (expected provider/model, optionally #variant)` }
  }
  if (!available.some((m) => same(m.providerID, parsed.providerID))) {
    const providers = [...new Set(available.map((m) => m.providerID))].sort()
    return {
      warning: clip(
        `the configured model "${selector}" is not in this location's model registry: ` +
          `no provider "${parsed.providerID}" (available: ${providers.join(", ") || "none"})`,
      ),
    }
  }
  const match = available.find(
    (m) =>
      same(m.providerID, parsed.providerID) &&
      (same(m.id, parsed.id) || (m.modelID !== undefined && same(m.modelID, parsed.id))),
  )
  if (!match) {
    const ids = available
      .filter((m) => same(m.providerID, parsed.providerID))
      .map((m) => m.id)
      .sort()
    return {
      warning: clip(
        `the configured model "${selector}" is not in provider "${parsed.providerID}" (it has: ` +
          `${ids.slice(0, 10).join(", ")}${ids.length > 10 ? ", …" : ""})`,
      ),
    }
  }
  return { model: { providerID: match.providerID, id: match.id, variant: parsed.variant } }
}
