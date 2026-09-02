'use server';

// The kitchen's write surface. Thin, like the cart's: every rule lives in the
// state machine, and every argument here is untrusted input.
//
// Every action here is behind the `/kitchen/:path*` middleware (C-037), which
// fails closed when `STAFF_PASSCODE` is unset. That is the only thing standing
// between these writes and the internet, so nothing below may assume a caller
// came from a screen this app rendered.
import {
  ADJUSTMENT_KINDS,
  CANCEL_REASONS,
  ORDER_STATUSES,
  isStaffAdjustmentReason,
  parsePriceInput,
  type AdjustmentKind,
  type AdjustmentReason,
  type AdjustmentRefusalReason,
  type CancelReason,
  type OrderAction,
  type OrderStatus,
} from '@countertop/core';
import { prisma } from '@countertop/db';
import { adjustOrder } from '@countertop/db/adjustment';
import { redeemReward } from '@countertop/db/loyalty';
import { remakeOrder } from '@countertop/db/remake';
import { collectOrderPayment } from '@countertop/db/payment';
import { isStaffPin, staffByPin } from '@countertop/db/staff';
import { cookies } from 'next/headers';
import {
  currentShiftId,
  ON_SHIFT_COOKIE,
  ON_SHIFT_COOKIE_MAX_AGE,
  shiftCookieValue,
} from '@/lib/shift';
import { applyOrderAction } from '@countertop/db/transitions';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { revalidateMenuSurfaces } from '@/lib/revalidate-menu';

export type KitchenResult = { ok: true } | { ok: false; message: string };

/**
 * The target a card was RENDERED against, as untrusted input.
 *
 * Both movement actions carry one. The state machine has had an
 * `unexpected_target` refusal since C-004 built exactly for the stale-screen
 * double-tap — and until now neither caller passed a `to`, so the guard could
 * not fire from a screen. The database's compare-and-set catches two taps
 * racing on the SAME read; it re-reads current status first, so a tap from a
 * card five seconds behind advanced from wherever the order had since got to.
 * Two screens and a five-second poll turned "Start cooking" into "Picked up".
 *
 * `undefined` stays legal: the seed, the rush and the db tests drive the
 * engine without a screen and have no rendered state to name.
 */
const readTarget = (to: unknown): OrderStatus | undefined | 'invalid' => {
  if (to === undefined || to === null || to === '') return undefined;
  return ORDER_STATUSES.includes(to as OrderStatus) ? (to as OrderStatus) : 'invalid';
};

async function run(orderId: unknown, action: OrderAction): Promise<KitchenResult> {
  if (typeof orderId !== 'string' || orderId === '') {
    return { ok: false, message: 'That order could not be read. Reload the queue.' };
  }

  // `now` is read HERE and passed down. Nothing below this line reads a clock,
  // and nothing above it is the client's (CLAUDE.md time rules).
  //
  // The same for WHO (C-086): every movement action on this screen routes
  // through this one function, so the shift is read once, here, and never
  // taken from the request. A staff id in a form field is a staff id anybody
  // can type, which is the opposite of accountability.
  const result = await applyOrderAction(orderId, action, new Date(), await currentShiftId());
  // Only on a real change — not on a refusal or a stale no-op. Revalidating
  // unconditionally re-renders the whole queue as part of THIS action's own
  // transition, which can move the order's card into a different status
  // section and remount `<QueueControls>` before the caller ever gets to show
  // the error it just set: the rejection was correct, but nobody saw why.
  if (result.ok) revalidatePath('/kitchen');
  return result.ok ? { ok: true } : { ok: false, message: result.failure.message };
}

/**
 * The forward tap. On a `placed` order this IS the acknowledgment (P0-12).
 *
 * `to` is the status the card was showing as next when it was drawn. A card
 * that has fallen behind names a target the order has already passed, and the
 * engine refuses it by reason instead of advancing from wherever the order got
 * to in the meantime.
 */
export async function advanceOrder(orderId: string, to?: unknown): Promise<KitchenResult> {
  const target = readTarget(to);
  if (target === 'invalid') {
    return { ok: false, message: 'That order could not be read. Reload the queue.' };
  }
  return run(orderId, { kind: 'advance', actor: 'staff', ...(target ? { to: target } : {}) });
}

/** The explicit, logged backward move — and the 5-second undo, which is the
 *  same action with a louder button (P0-4). Carries the same rendered target
 *  as the forward tap, for the same reason: "Move back" on a stale card must
 *  not walk an order back from a state the tapper never saw. */
export async function revertOrder(
  orderId: string,
  reason?: string,
  to?: unknown,
): Promise<KitchenResult> {
  const target = readTarget(to);
  if (target === 'invalid') {
    return { ok: false, message: 'That order could not be read. Reload the queue.' };
  }
  return run(orderId, {
    kind: 'revert',
    actor: 'staff',
    ...(reason ? { reason } : {}),
    ...(target ? { to: target } : {}),
  });
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
 * The rule, the column and the event all live in `packages/db/payment.ts`
 * (C-085) — a column and its event have to move in one transaction, which is
 * something only a database module can promise. This is the boundary: it
 * reads the clock once, checks the argument, and revalidates.
 */
export async function markOrderPaid(orderId: unknown): Promise<KitchenResult> {
  if (typeof orderId !== 'string' || orderId === '') {
    return { ok: false, message: 'That order could not be read. Reload the queue.' };
  }

  // `now` and WHO, read here and passed down, like every other write on this
  // screen. A cash control is the one that most needs a name on it — which is
  // the operator's own argument for this whole item.
  const result = await collectOrderPayment(orderId, new Date(), await currentShiftId());
  if (!result.ok) return result;
  // The subtree, not the one page: this control lives on the queue AND on the
  // history receipt, and collecting from either has to move both.
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
 * Refusals this action is willing to REPEAT BACK to the screen (C-065).
 *
 * The four a person can actually cause by filling the form in — a number too
 * big, an order with nothing left, a missing note, a note too long. Their
 * messages are composed entirely of server-side values, so echoing one through
 * a query string says nothing the server did not already know.
 *
 * The two omitted refusals interpolate the CALLER'S OWN STRING into their
 * message ("\"foo\" is not an adjustment"), and neither is reachable from the
 * rendered form — reaching them means a hand-made request. Allow-listing the
 * kinds rather than trusting the message is C-084's rule applied a second
 * time: a message is a free-text channel, and the fix is to name what may
 * travel down it rather than to sanitise what does.
 */
const ECHOABLE_REFUSALS: readonly AdjustmentRefusalReason[] = [
  'adjustment_exceeds_total',
  'nothing_left_to_adjust',
  'adjustment_note_required',
  'adjustment_note_too_long',
];

/**
 * Spend a punch-card reward on this order (PRD 7 P0-4).
 *
 * THE ORDER ID IS THE ONLY INPUT. No amount, no member, no points — the reward
 * is worth what the settings row says it is worth, and who it belongs to is
 * whoever enrolled under the order's own phone. There is nothing here for a
 * hand-crafted POST to inflate, which is the shape the server-is-the-price-
 * authority rule takes when the price is the restaurant's own giveaway.
 *
 * Every refusal is echoed, unlike `adjustOrderForm`'s. That rule exists
 * because an adjustment's message can quote a number a person typed; a
 * redemption takes no typed number, so all four messages are strings written
 * here and none is a channel for anything a caller supplied.
 */
export async function redeemRewardForm(formData: FormData): Promise<void> {
  const orderId = formData.get('orderId');
  if (typeof orderId !== 'string' || orderId === '') {
    return redirect('/kitchen/orders');
  }
  const back = `/kitchen/orders/${encodeURIComponent(orderId)}`;

  const result = await redeemReward(orderId, new Date(), await currentShiftId());
  if (!result.ok) {
    return redirect(`${back}?redeemError=${encodeURIComponent(result.message)}`);
  }

  // The subtree, for the same reason the adjustment revalidates it: a
  // redemption is an adjustment, so the queue card's "still owed" moved too.
  revalidatePath('/kitchen', 'layout');
  redirect(back);
}

/**
 * Make an order right (PRD 3 P0-3).
 *
 * Form-shaped, like `collectPayment`, because the receipt is a server
 * component with no client JavaScript. Unlike `collectPayment` this one CANNOT
 * swallow a refusal: "you typed $50 on a $13.75 order" is not legible in a
 * re-render — the form comes back looking exactly as it did, and the counter
 * believes the comp landed. So the refusal goes in the URL, which is the shape
 * the sign-in, the settings save and the menu confirm already use.
 *
 * Everything here is untrusted input, including the amount. The amount in
 * particular is never written as given: `adjustOrder` re-reads the order and
 * bounds it against that order's own snapshotted total (CLAUDE.md — the server
 * is the price authority), and the parse below only turns text into cents.
 */
export async function adjustOrderForm(formData: FormData): Promise<void> {
  const orderId = formData.get('orderId');
  if (typeof orderId !== 'string' || orderId === '') {
    return redirect('/kitchen/orders');
  }
  const back = `/kitchen/orders/${encodeURIComponent(orderId)}`;
  const refuse = (message: string): never =>
    redirect(`${back}?adjustError=${encodeURIComponent(message)}`);

  const kind = formData.get('kind');
  const reason = formData.get('reason');
  if (typeof kind !== 'string' || !ADJUSTMENT_KINDS.includes(kind as AdjustmentKind)) {
    return refuse('Pick comp or a partial amount.');
  }
  if (typeof reason !== 'string' || !isStaffAdjustmentReason(reason)) {
    return refuse('Pick a reason.');
  }

  // Dollars in, cents out, and `parsePriceInput` is the one that already
  // exists — the menu editor has parsed prices with it since C-015. A second
  // parser here would be a second set of edge cases (a bare `$`, `1.5`, `1.555`)
  // to get right twice. Only the `partial` needs it: a comp's amount is
  // DERIVED by the engine from the order and is never sent by the client.
  let amountCents: number | undefined;
  if (kind === 'partial') {
    const raw = formData.get('amount');
    const parsed = typeof raw === 'string' ? parsePriceInput(raw) : null;
    if (parsed === null) return refuse('Enter an amount like 3.50.');
    amountCents = parsed;
  }

  const note = formData.get('note');
  const result = await adjustOrder(
    orderId,
    {
      kind: kind as AdjustmentKind,
      reason: reason as AdjustmentReason,
      ...(amountCents === undefined ? {} : { amountCents }),
      ...(typeof note === 'string' && note !== '' ? { note } : {}),
    },
    // `now` read here and passed down, and WHO read from the shift rather than
    // from the form — the same rule every other write on this screen follows.
    new Date(),
    await currentShiftId(),
  );

  if (!result.ok) {
    return refuse(
      ECHOABLE_REFUSALS.includes(result.reason as AdjustmentRefusalReason)
        ? result.message
        : 'That adjustment could not be applied.',
    );
  }

  // The subtree: an adjustment changes what the queue card says is owed as
  // well as what this receipt says, because both ask `orderBalance`.
  revalidatePath('/kitchen', 'layout');
  redirect(back);
}

/**
 * Cook it again, on the house (PRD 3 P0-3, C-066).
 *
 * Decision 7 of 2026-09-02: this creates a REAL second order — its own number,
 * its own ticket, its own place in the queue — linked back to the one it
 * replaces and comped in full. The kitchen needs something to cook, and a
 * remake nobody is told to make is the transcription failure the whole product
 * exists to kill.
 *
 * Lands the operator on the NEW order rather than leaving them on the old one:
 * the next thing that happens is a ticket going to the line, and the number to
 * call out is the new one.
 */
export async function remakeOrderForm(formData: FormData): Promise<void> {
  const orderId = formData.get('orderId');
  if (typeof orderId !== 'string' || orderId === '') {
    return redirect('/kitchen/orders');
  }
  const back = `/kitchen/orders/${encodeURIComponent(orderId)}`;

  const reason = formData.get('reason');
  if (typeof reason !== 'string' || !isStaffAdjustmentReason(reason)) {
    return redirect(`${back}?adjustError=${encodeURIComponent('Pick a reason.')}`);
  }

  const note = formData.get('note');
  const result = await remakeOrder(
    orderId,
    reason as AdjustmentReason,
    new Date(),
    typeof note === 'string' && note !== '' ? note : undefined,
    await currentShiftId(),
  );

  if (!result.ok) {
    return redirect(
      `${back}?adjustError=${encodeURIComponent(
        ECHOABLE_REFUSALS.includes(result.reason as AdjustmentRefusalReason)
          ? result.message
          : 'That order could not be remade.',
      )}`,
    );
  }

  // The whole subtree: a remake puts a new card on the queue AND changes what
  // both receipts say.
  revalidatePath('/kitchen', 'layout');
  redirect(`/kitchen/orders/${result.order.id}`);
}

/**
 * Start a shift on this tablet (C-086).
 *
 * A PIN once per shift, not once per tap: thirty orders in twenty minutes
 * rules out the alternative, and a control staff route around is a control
 * that records nothing. The PIN is a stamp, not a second sign-in — the
 * passcode is still the only thing keeping this screen off the internet.
 */
export async function startShift(pin: unknown): Promise<KitchenResult> {
  if (typeof pin !== 'string' || !isStaffPin(pin)) {
    return { ok: false, message: 'A PIN is four digits.' };
  }

  const staff = await staffByPin(pin);
  // One message for "no such PIN" and for "that person is deactivated". The
  // difference is not something a keypad should teach whoever is typing at it.
  if (!staff) return { ok: false, message: 'That PIN did not match anybody on the list.' };

  (await cookies()).set(ON_SHIFT_COOKIE, shiftCookieValue(staff.id), {
    httpOnly: true,
    sameSite: 'lax',
    // The passcode cookie's own rule: secure in production, settable over the
    // plain-HTTP dev server.
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: ON_SHIFT_COOKIE_MAX_AGE,
  });
  revalidatePath('/kitchen', 'layout');
  return { ok: true };
}

/** End it. Deliberately not a sign-out: the passcode session is untouched, so
 *  the queue stays on the wall and the next person starts their own shift. */
export async function endShift(): Promise<KitchenResult> {
  (await cookies()).delete(ON_SHIFT_COOKIE);
  revalidatePath('/kitchen', 'layout');
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
