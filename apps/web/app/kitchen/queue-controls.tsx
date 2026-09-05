'use client';

// The buttons on a queue card (P0-4, P0-11).
//
// What each one is allowed to do comes from `STATUS_FACTS` — the ONE status
// module — so a new state adds itself to the card rather than needing a grep.
// The advance button is deliberately the largest control here: greasy gloves
// and knuckle-taps are the input device.
import { useEffect, useState, useTransition } from 'react';
import {
  canCollectPayment,
  CANCEL_REASONS,
  MAX_CANCEL_NOTE_LENGTH,
  MAX_SHELF_LOCATION_LENGTH,
  STATUS_FACTS,
  type OrderStatus,
} from '@countertop/core';
import { CANCEL_REASON_LABEL } from '@/lib/status-labels';
import {
  abandonOrder,
  addOrderNote,
  advanceOrder,
  cancelOrder,
  markOrderPaid,
  revertOrder,
  saveShelfLocation,
  type KitchenResult,
} from './actions';

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

export function QueueControls({
  orderId,
  status,
  outstandingCents,
  undoMs,
  shelfLocation,
}: {
  orderId: string;
  status: OrderStatus;
  /** What is still owed, from `orderBalance` on the server (C-064). A number
   *  rather than `paymentState`: "unpaid" cannot describe an order that has
   *  been half refunded, and "is anything owed" can. */
  outstandingCents: number;
  /** Milliseconds left on the undo, computed by the SERVER from the event log.
   *  A duration, not an instant — nothing here reads a clock to decide. */
  undoMs: number;
  /** Where the bag is, on a card that is holding one (PRD 2 P0-5). The card
   *  RENDERS it in large type; this component only edits it. */
  shelfLocation: string | null;
}) {
  const facts = STATUS_FACTS[status];
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState('');
  const [otherNote, setOtherNote] = useState('');
  const [note, setNote] = useState('');
  // What is in the shelf box right now. Seeded from the server's value and
  // re-seeded when the server sends a different one, so a poll that lands
  // between two taps does not overwrite what somebody is mid-way through
  // typing — the same adjust-during-render pattern the undo countdown uses.
  const [shelf, setShelf] = useState(shelfLocation ?? '');
  const [shelfBaseline, setShelfBaseline] = useState(shelfLocation);
  if (shelfLocation !== shelfBaseline) {
    setShelfBaseline(shelfLocation);
    setShelf(shelfLocation ?? '');
  }

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

  function act(run: () => Promise<KitchenResult>, onOk?: () => void) {
    setError('');
    startTransition(async () => {
      const result = await run();
      if (result.ok) onOk?.();
      else setError(result.message);
    });
  }

  const previous = facts.previous;

  return (
    <div className="mt-4 flex flex-col gap-2">
      {/* Every movement button hands the server the target this card was DRAWN
          against, never letting it advance from whatever it finds. A card five
          seconds behind names a state the order has already left, and the
          engine's `unexpected_target` refusal — which existed since C-004 and
          had never once fired from a screen — turns it into a message instead
          of a skipped state. */}
      {/* Where the bag is GOING, typed before the tap that puts it there
          (PRD 2 P0-5). Which card offers it is `onShelf` on the state this tap
          leads to, never `status === 'preparing'` — a second shelf-holding
          state joins this surface by setting the fact.

          Optional, and above the button rather than blocking it: the tap that
          marks food ready is the one control on this screen that must never
          wait for a text field. Leaving it blank marks the order ready with no
          shelf, which is what happens today. */}
      {facts.next && STATUS_FACTS[facts.next].onShelf && (
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">Shelf (optional)</span>
          <input
            value={shelf}
            maxLength={MAX_SHELF_LOCATION_LENGTH}
            placeholder="shelf 3"
            onChange={(event) => setShelf(event.target.value)}
            className="min-h-12 rounded-lg border border-neutral-400 px-3 text-lg"
          />
        </label>
      )}

      {facts.next && (
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            act(() =>
              // The shelf rides with the tap. It is only ever sent on the tap
              // that lands the order on a shelf; the server ignores an empty
              // one rather than clearing a value it was not asked about.
              advanceOrder(
                orderId,
                facts.next,
                STATUS_FACTS[facts.next!].onShelf ? shelf : undefined,
              ),
            )
          }
          className="min-h-16 w-full rounded-lg bg-neutral-900 px-6 text-xl font-bold text-white disabled:opacity-60"
        >
          {ADVANCE_LABEL[status]}
        </button>
      )}

      {/* The bag moved (PRD 2 P0-5). Its own Save, because a shelf correction
          is not a state change and must not need one — and because clearing
          the box has to mean cleared, which a tap-to-advance cannot express. */}
      {facts.onShelf && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-sm font-medium">Shelf</span>
            <input
              value={shelf}
              maxLength={MAX_SHELF_LOCATION_LENGTH}
              placeholder="shelf 3"
              onChange={(event) => setShelf(event.target.value)}
              className="min-h-12 rounded-lg border border-neutral-400 px-3 text-lg"
            />
          </label>
          <button
            type="button"
            disabled={pending}
            onClick={() => act(() => saveShelfLocation(orderId, shelf))}
            className="min-h-12 rounded-lg border border-neutral-400 px-4 font-semibold disabled:opacity-60"
          >
            Save shelf
          </button>
        </div>
      )}

      {/* Directly under the advance button, because "Picked up" is the tap
          that lets the bag leave and this is the one that must happen first
          (P1-8). Not a blocker: the PRD says flag, and a cook who cannot hand
          over food because a screen disagrees about money will find a way
          around the screen. Asked of the status module rather than of the
          amount alone, so a no-show sitting in the "Just finished" strip does
          not offer to collect for food nobody took. */}
      {canCollectPayment(status, outstandingCents) && (
        <button
          type="button"
          disabled={pending}
          onClick={() => act(() => markOrderPaid(orderId))}
          className="min-h-12 w-full rounded-lg border-2 border-amber-700 bg-amber-100 px-4 text-lg font-bold text-amber-900 disabled:opacity-60"
        >
          Collected — mark paid
        </button>
      )}

      {!undoExpired && previous && (
        <button
          type="button"
          disabled={pending}
          onClick={() => act(() => revertOrder(orderId, 'undo', previous))}
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
            onClick={() => act(() => revertOrder(orderId, undefined, previous))}
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

        {/* Somebody can write on the ticket (PRD 2 P0-6).

            On EVERY card, with no `facts` guard, and that is the point: the
            operator's finding is a note about a customer who has not turned
            up, which is a `ready` order, and one about a substitution, which
            is a `preparing` one. There is no state where "write down what
            just happened" is meaningless — including the just-finished tile,
            where the note is how the next person learns why.

            Behind a disclosure like the cancel control, because it is typing
            and the card is read at arm's length: the tap targets that matter
            on this screen are the ones a gloved knuckle hits without looking,
            and a text box is never one of them. */}
        <details className="w-full">
          <summary className="flex min-h-12 w-fit cursor-pointer list-none items-center rounded-lg border border-neutral-400 px-4">
            Add note…
          </summary>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-sm font-medium">Note for the shift</span>
              <input
                value={note}
                maxLength={MAX_CANCEL_NOTE_LENGTH}
                placeholder="customer called, arriving 7:40"
                onChange={(event) => setNote(event.target.value)}
                className="min-h-12 w-full rounded-lg border border-neutral-400 px-3 text-lg"
              />
            </label>
            {/* Cleared only on success, so a refused note is still in the box
                to fix rather than retyped. */}
            <button
              type="button"
              disabled={pending}
              onClick={() => act(() => addOrderNote(orderId, note), () => setNote(''))}
              className="min-h-12 rounded-lg border border-neutral-400 px-4 font-semibold disabled:opacity-60"
            >
              Save note
            </button>
          </div>
        </details>

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
                  {CANCEL_REASON_LABEL[reason]}
                </button>
              ))}
              {/* "Other" with no text is the reason nobody can act on later,
                  so the engine refuses it — the input is not optional here. */}
              <label className="flex flex-col gap-1">
                <span>{CANCEL_REASON_LABEL.other} — say what happened</span>
                <input
                  value={otherNote}
                  maxLength={MAX_CANCEL_NOTE_LENGTH}
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
