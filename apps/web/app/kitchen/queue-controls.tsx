'use client';

// The buttons on a queue card (P0-4, P0-11).
//
// What each one is allowed to do comes from `STATUS_FACTS` — the ONE status
// module — so a new state adds itself to the card rather than needing a grep.
// The advance button is deliberately the largest control here: greasy gloves
// and knuckle-taps are the input device.
import { useEffect, useState, useTransition } from 'react';
import { CANCEL_REASONS, STATUS_FACTS, type CancelReason, type OrderStatus } from '@countertop/core';
import { abandonOrder, advanceOrder, cancelOrder, revertOrder, type KitchenResult } from './actions';

/** A `Record<OrderStatus, …>`, so a new state does not compile until someone
 *  decides what its button says. */
const ADVANCE_LABEL: Record<OrderStatus, string> = {
  // Accepting IS acknowledging the new-order alert (P0-12). Never a separate
  // chore, and never a second button.
  placed: 'Accept',
  accepted: 'Start cooking',
  preparing: 'Food is ready',
  ready: 'Picked up',
  picked_up: '',
  cancelled: '',
  abandoned: '',
};

const REASON_LABEL: Record<CancelReason, string> = {
  out_of_item: 'Out of an item',
  too_busy: 'Too busy',
  other: 'Other',
};

export function QueueControls({
  orderId,
  status,
  undoMs,
}: {
  orderId: string;
  status: OrderStatus;
  /** Milliseconds left on the undo, computed by the SERVER from the event log.
   *  A duration, not an instant — nothing here reads a clock to decide. */
  undoMs: number;
}) {
  const facts = STATUS_FACTS[status];
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState('');
  const [otherNote, setOtherNote] = useState('');

  // The undo hides itself when the window runs out. Adjusted DURING render on
  // a prop change (React's documented pattern) rather than in the effect: a
  // fresh `undoMs` means the server re-rendered this card after a new advance,
  // and the countdown starts over.
  const [undoBaseline, setUndoBaseline] = useState(undoMs);
  const [undoExpired, setUndoExpired] = useState(undoMs <= 0);
  if (undoMs !== undoBaseline) {
    setUndoBaseline(undoMs);
    setUndoExpired(undoMs <= 0);
  }
  useEffect(() => {
    if (undoMs <= 0) return;
    const timer = setTimeout(() => setUndoExpired(true), undoMs);
    return () => clearTimeout(timer);
  }, [undoMs]);

  function act(run: () => Promise<KitchenResult>) {
    setError('');
    startTransition(async () => {
      const result = await run();
      if (!result.ok) setError(result.message);
    });
  }

  const previous = facts.previous;

  return (
    <div className="mt-4 flex flex-col gap-2">
      {facts.next && (
        <button
          type="button"
          disabled={pending}
          onClick={() => act(() => advanceOrder(orderId))}
          className="min-h-16 w-full rounded-lg bg-neutral-900 px-6 text-xl font-bold text-white disabled:opacity-60"
        >
          {ADVANCE_LABEL[status]}
        </button>
      )}

      {!undoExpired && previous && (
        <button
          type="button"
          disabled={pending}
          onClick={() => act(() => revertOrder(orderId, 'undo'))}
          className="min-h-12 w-full rounded-lg border-2 border-amber-600 bg-amber-50 px-4 text-lg font-semibold text-amber-900"
        >
          Undo — back to {previous.replace('_', ' ')}
        </button>
      )}

      <div className="flex flex-wrap gap-2">
        {previous && undoExpired && (
          <button
            type="button"
            disabled={pending}
            onClick={() => act(() => revertOrder(orderId))}
            className="min-h-12 rounded-lg border border-neutral-400 px-4"
          >
            Move back
          </button>
        )}

        {facts.abandonable && (
          <button
            type="button"
            disabled={pending}
            onClick={() => act(() => abandonOrder(orderId))}
            className="min-h-12 rounded-lg border border-neutral-400 px-4"
          >
            No-show
          </button>
        )}

        {facts.cancellableByStaff && (
          <details className="w-full">
            <summary className="flex min-h-12 w-fit cursor-pointer list-none items-center rounded-lg border border-neutral-400 px-4">
              Cancel…
            </summary>
            <div className="mt-2 flex flex-col gap-2">
              {CANCEL_REASONS.filter((reason) => reason !== 'other').map((reason) => (
                <button
                  key={reason}
                  type="button"
                  disabled={pending}
                  onClick={() => act(() => cancelOrder(orderId, reason))}
                  className="min-h-12 rounded-lg border border-red-400 px-4 text-red-800"
                >
                  {REASON_LABEL[reason]}
                </button>
              ))}
              {/* "Other" with no text is the reason nobody can act on later,
                  so the engine refuses it — the input is not optional here. */}
              <label className="flex flex-col gap-1">
                <span>{REASON_LABEL.other} — say what happened</span>
                <input
                  value={otherNote}
                  maxLength={140}
                  onChange={(event) => setOtherNote(event.target.value)}
                  className="min-h-12 rounded-lg border border-neutral-400 px-3"
                />
              </label>
              <button
                type="button"
                disabled={pending}
                onClick={() => act(() => cancelOrder(orderId, 'other', otherNote))}
                className="min-h-12 rounded-lg border border-red-400 px-4 text-red-800"
              >
                Cancel this order
              </button>
            </div>
          </details>
        )}
      </div>

      <p aria-live="polite" className="text-sm font-medium text-red-700">
        {error}
      </p>
    </div>
  );
}
