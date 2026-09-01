'use server';

// The kitchen's write surface. Thin, like the cart's: every rule lives in the
// state machine, and every argument here is untrusted input.
//
// Every action here is behind the `/kitchen/:path*` middleware (C-037), which
// fails closed when `STAFF_PASSCODE` is unset. That is the only thing standing
// between these writes and the internet, so nothing below may assume a caller
// came from a screen this app rendered.
import {
  canCollectPayment,
  CANCEL_REASONS,
  type CancelReason,
  type OrderAction,
} from '@countertop/core';
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

  // The button is UX; this is the rule. Asked of the status module, so the
  // queue card, the history receipt and a hand-rolled POST all get the same
  // answer to "is there money to collect on this?".
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { status: true, paymentState: true },
  });
  if (!order) return { ok: false, message: 'That order could not be found.' };
  if (!canCollectPayment(order.status, order.paymentState)) {
    return {
      ok: false,
      message:
        order.paymentState === 'unpaid'
          ? 'Nobody took this order, so there is nothing to collect on it.'
          : 'This order is already settled.',
    };
  }

  // Still guarded on `unpaid` in the WHERE: the read above is not in the same
  // transaction as the write, and two people tapping Collect at once is the
  // ordinary case, not the exotic one.
  await prisma.order.updateMany({
    where: { id: orderId, paymentState: 'unpaid' },
    data: { paymentState: 'paid' },
  });
  // The subtree, not the one page: this control now lives on the queue AND on
  // the history receipt, and collecting from either has to move both.
  revalidatePath('/kitchen', 'layout');
  return { ok: true };
}

/**
 * The same action, form-shaped, for the history receipt (P1-8).
 *
 * That page is a server component with no client JavaScript of its own, and
 * the reconciliation it exists for — an order handed over with the money not
 * collected — is a plain one-button post. A refusal is swallowed here rather
 * than rendered, which is honest only because every refusal this can produce
 * is legible in the re-render: the control is gone if it succeeded or if
 * someone else got there first, and still there if it did not apply.
 */
export async function collectPayment(formData: FormData): Promise<void> {
  await markOrderPaid(formData.get('orderId'));
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
