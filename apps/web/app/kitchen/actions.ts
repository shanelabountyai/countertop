'use server';

// The kitchen's write surface. Thin, like the cart's: every rule lives in the
// state machine, and every argument here is untrusted input.
//
// There is no staff authentication in P0 — the queue screen is reachable by
// anyone who knows the path. That is a deliberate scope line, not an
// oversight, and it is recorded in the write-up.
import { CANCEL_REASONS, type CancelReason, type OrderAction } from '@countertop/core';
import { prisma } from '@countertop/db';
import { applyOrderAction } from '@countertop/db/transitions';
import { revalidatePath } from 'next/cache';
import { revalidateMenuSurfaces } from '@/lib/revalidate-menu';

export type KitchenResult = { ok: true } | { ok: false; message: string };

async function run(orderId: unknown, action: OrderAction): Promise<KitchenResult> {
  if (typeof orderId !== 'string' || orderId === '') {
    return { ok: false, message: 'That order could not be read. Reload the queue.' };
  }

  // `now` is read HERE and passed down. Nothing below this line reads a clock,
  // and nothing above it is the client's (CLAUDE.md time rules).
  const result = await applyOrderAction(orderId, action, new Date());
  // Only on a real change — not on a refusal or a stale no-op. Revalidating
  // unconditionally re-renders the whole queue as part of THIS action's own
  // transition, which can move the order's card into a different status
  // section and remount `<QueueControls>` before the caller ever gets to show
  // the error it just set: the rejection was correct, but nobody saw why.
  if (result.ok) revalidatePath('/kitchen');
  return result.ok ? { ok: true } : { ok: false, message: result.failure.message };
}

/** The forward tap. On a `placed` order this IS the acknowledgment (P0-12). */
export async function advanceOrder(orderId: string): Promise<KitchenResult> {
  return run(orderId, { kind: 'advance', actor: 'staff' });
}

/** The explicit, logged backward move — and the 5-second undo, which is the
 *  same action with a louder button (P0-4). */
export async function revertOrder(orderId: string, reason?: string): Promise<KitchenResult> {
  return run(orderId, { kind: 'revert', actor: 'staff', ...(reason ? { reason } : {}) });
}

export async function cancelOrder(
  orderId: string,
  reason: string,
  note?: string,
): Promise<KitchenResult> {
  if (!CANCEL_REASONS.includes(reason as CancelReason)) {
    return { ok: false, message: 'Pick a reason for the cancellation.' };
  }
  return run(orderId, {
    kind: 'cancel',
    actor: 'staff',
    reason: reason as CancelReason,
    ...(note ? { note } : {}),
  });
}

/** The no-show close-out. `abandoned`, never `cancelled` — the no-show rate is
 *  a number the owner acts on (P0-4, P1-1). */
export async function abandonOrder(orderId: string): Promise<KitchenResult> {
  return run(orderId, { kind: 'abandon', actor: 'staff' });
}

/**
 * The counter collected (P1-8).
 *
 * `updateMany` guarded on `unpaid`, not `update`: a card that has been open on
 * a second screen since before the customer paid must not be able to re-mark a
 * REFUNDED order as paid. Zero rows matched is not an error — it is the answer
 * "someone already handled this", and the queue re-renders with the truth.
 *
 * ponytail: the column is the record; there is no `payment` event, so a
 * counter-collected order carries no instant. A real provider makes this a
 * logged event with a provider reference, and that is where the timestamp
 * lands — the `refund` kind is the shape to copy.
 */
export async function markOrderPaid(orderId: unknown): Promise<KitchenResult> {
  if (typeof orderId !== 'string' || orderId === '') {
    return { ok: false, message: 'That order could not be read. Reload the queue.' };
  }
  await prisma.order.updateMany({
    where: { id: orderId, paymentState: 'unpaid' },
    data: { paymentState: 'paid' },
  });
  revalidatePath('/kitchen');
  return { ok: true };
}

/**
 * The manual half of the checkout gate (P0-6): "pause new orders".
 *
 * In-flight orders are untouched — this only answers the question the gate
 * asks about NEW ones. The switch always overrides the other two triggers, so
 * a cook who pauses because the fryer died does not have it lifted by the
 * queue draining below the auto-threshold.
 */
export async function setOrderingPaused(paused: unknown, message?: unknown): Promise<KitchenResult> {
  if (typeof paused !== 'boolean') {
    return { ok: false, message: 'That switch could not be read. Reload the queue.' };
  }
  const note = typeof message === 'string' ? message.trim().slice(0, 200) : '';

  await prisma.restaurantSettings.update({
    where: { id: 'singleton' },
    data: { ordersPaused: paused, pauseMessage: paused && note !== '' ? note : null },
  });
  revalidatePath('/kitchen');
  // The customer surfaces read the gate on every render, and both are
  // `force-dynamic`, so they pick this up on their next poll or navigation.
  revalidatePath('/checkout');
  revalidatePath('/cart');
  return { ok: true };
}

/**
 * The 86 board's two writes (P0-6). Both grains, one shape.
 *
 * `updateMany`, not `update`: a stale board tapping an id that has since been
 * deleted should change nothing, not throw a 500 at a cook mid-rush.
 *
 * These flip ONE boolean. Everything an 86 means is already downstream of it —
 * the menu renders "sold out", `validateComposition` refuses the composition,
 * `reviewCart` flags the lines already holding it, and placement refuses the
 * order. A placed order is untouched by construction: it is a snapshot.
 */
export async function setItemAvailable(itemId: unknown, available: unknown): Promise<void> {
  if (typeof itemId !== 'string' || typeof available !== 'boolean') return;
  await prisma.menuItem.updateMany({ where: { id: itemId }, data: { available } });
  revalidateMenuSurfaces();
}

export async function setOptionAvailable(optionId: unknown, available: unknown): Promise<void> {
  if (typeof optionId !== 'string' || typeof available !== 'boolean') return;
  await prisma.modifierOption.updateMany({ where: { id: optionId }, data: { available } });
  revalidateMenuSurfaces();
}
