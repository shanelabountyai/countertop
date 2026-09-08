// The last-call warning (PRD 5 P0-3).
//
// ONE component, mounted on the menu, the cart and checkout — the same three
// screens that ask the gate. The gate is one code path with three triggers;
// this is one warning on three screens, and for the same reason. Three copies
// of `minutes <= 30` drift, and a menu that warns while checkout does not is
// worse than no warning at all: it teaches a customer that the countdown is
// decorative.
//
// It renders nothing it computed itself. Both numbers come off the open gate
// result, which measured them against the wall-clock reading it compared
// today's hours against — so the warning and the refusal that follows it can
// never disagree about what minute it is.
import { formatMinuteOfDay, type GateResult } from '@countertop/core';

/**
 * How early to start warning.
 *
 * Thirty minutes is a guess and the PRD says so — long enough to compose an
 * order and walk over, short enough not to read as pressure through the whole
 * afternoon. It is a Product Open Question, which is exactly why the number
 * lives in one place: answering it is one edit, not three.
 */
const LAST_CALL_MINUTES = 30;

export function LastCall({
  gate,
  className = '',
}: {
  gate: GateResult;
  className?: string;
}) {
  if (!gate.open || gate.minutesUntilLastOrder > LAST_CALL_MINUTES) return null;

  return (
    <p
      data-testid="last-call"
      data-minutes={gate.minutesUntilLastOrder}
      // Deliberately quieter than `GateNotice`: that one reports a door that is
      // shut, this one reports a door that is still open. Same amber family so
      // they read as the same voice, no heavy border so they cannot be mistaken
      // for each other at a glance.
      className={`rounded-lg bg-amber-50 px-4 py-3 font-medium text-amber-900 ${className}`}
    >
      Last online orders in {gate.minutesUntilLastOrder} min — we stop taking them at{' '}
      {formatMinuteOfDay(gate.lastOrderMinute)}.
    </p>
  );
}
