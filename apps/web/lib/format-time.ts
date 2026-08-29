// A placed-at instant, read out in the restaurant's own timezone (CLAUDE.md
// time rules) — display-only, next to `formatCents` and `describeSelection`.
// Never the server's timezone: `Intl.DateTimeFormat`'s `timeZone` option does
// the conversion, so nothing here reads or guesses an offset by hand.
export function formatPlacedAt(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(at);
}
