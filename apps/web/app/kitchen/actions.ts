'use server';

// The kitchen's write surface. Thin, like the cart's: every rule lives in the
// state machine, and every argument here is untrusted input.
//
// There is no staff authentication in P0 — the queue screen is reachable by
// anyone who knows the path. That is a deliberate scope line, not an
// oversight, and it is recorded in the write-up.
import { CANCEL_REASONS, type CancelReason, type OrderAction } from '@countertop/core';
import { applyOrderAction } from '@countertop/db/transitions';
import { revalidatePath } from 'next/cache';

export type KitchenResult = { ok: true } | { ok: false; message: string };

async function run(orderId: unknown, action: OrderAction): Promise<KitchenResult> {
  if (typeof orderId !== 'string' || orderId === '') {
    return { ok: false, message: 'That order could not be read. Reload the queue.' };
  }

  // `now` is read HERE and passed down. Nothing below this line reads a clock,
  // and nothing above it is the client's (CLAUDE.md time rules).
  const result = await applyOrderAction(orderId, action, new Date());
  revalidatePath('/kitchen');
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
