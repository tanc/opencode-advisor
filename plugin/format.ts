/**
 * Presentation helpers for command output.
 */

/**
 * Render a moment for the status card.
 *
 * Today shows only the time; any other day also shows the date. That is the
 * whole point: a card generated yesterday must not read as live state, and the
 * only other time in the card ("last review") cannot carry the card's age.
 *
 * Both this and every other time in the card go through the same local clock,
 * so there is never a UTC-versus-local mismatch inside one card.
 */
export function stamp(ms: number, now: number = Date.now()): string {
  const then = new Date(ms)
  const today = new Date(now)
  const sameDay =
    then.getFullYear() === today.getFullYear() && then.getMonth() === today.getMonth() && then.getDate() === today.getDate()
  return sameDay ? then.toLocaleTimeString() : then.toLocaleString()
}
