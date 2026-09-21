'use client';

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
//
// It ticks (C-149). The screen never reads the wall clock: it counts elapsed
// monotonic time since the server's number arrived and subtracts that. The
// server's figure is floored to the minute, so the display can lag the truth by
// under two minutes and never lead it — when it reaches zero the cutoff has passed,
// and the screen asks the server again rather than deciding it is closed. The
// gate stays the only thing that says "closed".
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
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
  const router = useRouter();
  const served = gate.open ? gate.minutesUntilLastOrder : null;
  // Tagged with the figure it counted from, so a fresh server figure (a
  // refresh) wins the moment it arrives instead of one tick later.
  const [tick, setTick] = useState({ from: served, left: served });
  const minutes = tick.from === served ? tick.left : served;

  useEffect(() => {
    if (served === null) return;
    const since = performance.now();
    const timer = setInterval(() => {
      // Elapsed, not counted ticks: a background tab's throttled interval
      // still lands on the right minute when it does fire.
      const left = served - Math.floor((performance.now() - since) / 60_000);
      setTick({ from: served, left });
      if (left <= 0) {
        clearInterval(timer);
        router.refresh();
      }
    }, 1_000);
    return () => clearInterval(timer);
  }, [served, router]);

  if (!gate.open || minutes === null || minutes <= 0 || minutes > LAST_CALL_MINUTES)
    return null;

  return (
    <p
      data-testid="last-call"
      data-minutes={minutes}
      // Deliberately quieter than `GateNotice`: that one reports a door that is
      // shut, this one reports a door that is still open. Same amber family so
      // they read as the same voice, no heavy border so they cannot be mistaken
      // for each other at a glance.
      className={`rounded-lg bg-amber-50 px-4 py-3 font-medium text-amber-900 ${className}`}
    >
      Last online orders in {minutes} min — we stop taking them at{' '}
      {formatMinuteOfDay(gate.lastOrderMinute)}.
    </p>
  );
}
