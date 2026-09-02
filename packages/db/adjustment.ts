// Writing an adjustment (PRD 3 P0-3, C-065).
//
// Here rather than in the server action for the reason C-085 moved payment
// here: a rule that guards money belongs next to the write it guards, in a
// module with a unit suite. `apps/web` has none.
//
// THERE IS NO COLUMN TO MOVE, and that is the design rather than an omission.
// A comp does not touch `subtotalCents`, `taxCents` or `totalCents` — those
// are the snapshot and they are write-once — and it does not touch
// `paymentState` either, because the enum is a cache over what the TILL did
// and an adjustment is not money arriving. So this writes exactly one
// append-only row, and `orderBalance` does the rest for every surface that
// shows what is owed.
import { adjustmentEvent, type AdjustmentInput, type AdjustmentRefusalReason } from '@countertop/core';
import { prisma } from './index';
import { eventRow } from './placement';

export type AdjustOrderResult =
  | { ok: true; amountCents: number }
  | { ok: false; reason: AdjustmentRefusalReason | 'order_not_found'; message: string };

/**
 * Record that the counter made an order right.
 *
 * The amount is validated against the order's OWN snapshot, re-read here — the
 * screen's idea of the total is never an input, exactly as the cart's total is
 * never an input to placement (CLAUDE.md: the server is the price authority).
 * `adjustmentEvent` does the validating and the building in one call, so there
 * is no path through this module that writes an amount nothing checked.
 *
 * Available in EVERY state, including `picked_up` and `abandoned` (P0-3). That
 * is the point of the requirement: those are precisely the states the product
 * had no money control for, and they are where a wrong order is discovered.
 * Money is decoupled from status here, which is what lets the state machine go
 * on refusing to cancel cooked food (P0-5) without that refusal being a dead
 * end.
 */
export async function adjustOrder(
  orderId: string,
  input: AdjustmentInput,
  now: Date,
  /** Who decided (C-086). Null where no shift is signed on — an honest null,
   *  and the reason decision 3 put identity ahead of this PRD. */
  staffId?: string | null,
): Promise<AdjustOrderResult> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { totalCents: true, events: { select: { kind: true, amountCents: true } } },
  });
  if (!order) return { ok: false, reason: 'order_not_found', message: 'That order could not be found.' };

  const decided = adjustmentEvent(order, input, now);
  if (!decided.ok) return decided;

  await prisma.orderEvent.create({
    data: { orderId, ...eventRow(decided.event, staffId) },
  });

  // Non-null by construction: `adjustmentEvent` only returns `ok` with an
  // amount, and the database's CHECK says the same thing a second time.
  return { ok: true, amountCents: decided.event.amountCents! };
}
