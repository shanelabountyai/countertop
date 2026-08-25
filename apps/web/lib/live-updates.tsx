'use client';

// The polling half of P0-5. Renders nothing; it only decides when the server
// component above it should be asked to render again.
//
// Two things it deliberately does not do:
//   - It does not hold a copy of the queue. `router.refresh()` re-runs the
//     server component, so a card has exactly one renderer and a menu snapshot
//     never gets re-derived on the client.
//   - It does not read a clock to decide anything. The cursor is the server's,
//     and the once-a-minute re-render is counted in TICKS, not in elapsed
//     milliseconds.
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** The PRD's window is 5–10s; 5 is the fast end because a new order arriving
 *  is the event the kitchen is waiting on (P0-12). */
export const POLL_INTERVAL_MS = 5_000;

/** Elapsed minutes on a card are computed by the server, so they freeze
 *  between renders. Re-render once a minute even when nothing changed — that
 *  is the resolution the numbers are printed at, so it is the resolution they
 *  need to be refreshed at. It doubles as the backstop for a change that
 *  somehow slipped a cursor comparison. */
const TICKS_PER_IDLE_REFRESH = 60_000 / POLL_INTERVAL_MS;

export function LiveUpdates({
  cursor,
  active = true,
}: {
  /** The cursor the surrounding page was rendered at, issued by the server. */
  cursor: string;
  /** False stops polling outright. C-014's status page passes
   *  `!isTerminal(status)`: a picked-up order has no further news (P0-5). */
  active?: boolean;
}) {
  const router = useRouter();

  useEffect(() => {
    if (!active) return;

    // Restarted whenever the server hands down a new cursor, which is what
    // resets both of these after a refresh.
    let seen = cursor;
    let ticks = 0;
    let stopped = false;

    const poll = async () => {
      // Backgrounded: no fetch at all. A queue screen behind a POS window is
      // not asking anyone a question (P0-5).
      if (document.hidden || stopped) return;

      const response = await fetch(`/api/updates?cursor=${encodeURIComponent(seen)}`, {
        cache: 'no-store',
      });
      if (!response.ok || stopped) return;

      const update = (await response.json()) as { cursor: string; changed: boolean };
      if (stopped) return;

      seen = update.cursor;
      ticks += 1;
      if (update.changed || ticks >= TICKS_PER_IDLE_REFRESH) {
        ticks = 0;
        router.refresh();
      }
    };

    const timer = setInterval(poll, POLL_INTERVAL_MS);
    // Coming back to the tab polls immediately rather than waiting out the
    // interval — the whole reason to pause is that nothing was watched while
    // it was away.
    document.addEventListener('visibilitychange', poll);

    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', poll);
    };
  }, [cursor, active, router]);

  return null;
}
