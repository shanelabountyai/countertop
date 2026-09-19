// Settling a hold (PRD 3 P1-1, C-069).
//
// THE HALF OF THE MONEY STORY THAT RUNS ITSELF. Everything C-067 and C-071
// built is somebody deciding: a person taps Refund, a person retries a failed
// one. This is the opposite — nobody decides to capture, because the customer
// already decided at checkout and the counter is only the moment it becomes
// true. So there is no control, no form and no bound to type: the hold names
// its own amount, and the transition into `picked_up` is the whole trigger.
//
// ONE FUNCTION, TWO EXITS, and that is the shape rather than an economy. A
// hold ends captured or released and never both, and the database says so with
// a unique index on the link. Two functions would be two places that both
// think they may write the row the other one already wrote.
//
// WHY IT IS NOT `settleRefund`. It is the same idea — a durable request row
// whose id is the idempotency key, settled later by a row that names it — and
// it deliberately reads like it. What it is not is the same PATH: money coming
// in is not money going out, the constraint behind it is plain where the
// refund's is partial, and the failure means the opposite thing (a refund that
// fails leaves money owed to the customer and needs a person; a capture that
// fails leaves money owed to the restaurant and needs the counter control that
// already exists). Folding them together would be one function with a
// direction flag threaded through nine decisions.
import {
  authorizationVoidedEvent,
  captureEvent,
  derivePaymentState,
  heldAuthorization,
  ORDER_STATUSES,
  salesRoleOf,
  type OrderStatus,
  type VoidReason,
} from '@countertop/core';
import { Prisma, prisma } from './index';
import { eventRow } from './event-row';
import { ORDER_RECEIPT, type OrderReceipt } from './placement';
import { mockPaymentProvider, type PaymentProvider } from './provider';

export type SettleAuthorizationReason =
  | 'order_not_found'
  /** No hold on this order, or it was already captured or released. Safe, and
   *  the ordinary answer for every order that was not prepaid. */
  | 'nothing_held'
  /** Somebody else settled this hold between the read and the write. The
   *  unique index said so; their row is the one that counts. */
  | 'raced'
  /** The provider would not let the hold go (C-145). Nothing is written, so
   *  the order keeps reading `authorized` and lands on `loadStuckHolds`. */
  | 'void_refused';

export type SettleAuthorizationResult =
  | { ok: true; kind: 'capture' | 'void'; amountCents: number }
  | { ok: false; reason: SettleAuthorizationReason; message: string };

const refuse = (
  reason: SettleAuthorizationReason,
  message: string,
): SettleAuthorizationResult => ({ ok: false, reason, message });

/**
 * What settling this order's hold means, given where the order ended up.
 *
 * DERIVED FROM THE SALES ROLE and never from `=== 'picked_up'`, which is the
 * rule the whole status module exists to enforce: a second sold status, or a
 * second way to not-sell, makes the compiler find this reader instead of
 * somebody grepping for a string. It is the same derivation the loyalty earn
 * uses one function over in `transitions.ts`, for the same reason.
 *
 * `in_flight` is `null` and not an oversight: an order still being cooked has
 * a live hold and that is the correct state for it to be in.
 */
export function authorizationOutcome(status: OrderStatus): 'capture' | VoidReason | null {
  switch (salesRoleOf(status)) {
    case 'sold':
      return 'capture';
    case 'no_show':
      return 'no_show';
    case 'cancelled':
      return 'cancelled';
    case 'in_flight':
      return null;
  }
}

/**
 * Take or release the hold on this order, and record which.
 *
 * Safe to call on any order in any state, which is what lets `applyOrderAction`
 * call it unconditionally after every transition: an order with no hold, or one
 * whose hold is already spent, answers `nothing_held` rather than failing. That
 * is deliberately the same property `settleRefund` has and for the same reason
 * — every caller reaches it from a screen that may be a few seconds behind.
 *
 * THE PROVIDER CALL IS OUTSIDE EVERY TRANSACTION (C-067's rule): a network call
 * inside a database transaction holds a row lock for as long as somebody else's
 * server feels like taking.
 *
 * AN UNDONE PICKUP DOES NOT GIVE THE MONEY BACK. Reverting `picked_up` lands on
 * `ready`, whose sales role is `in_flight`, so this writes nothing — the
 * capture stands and the order stays paid. That is deliberate: an automatic
 * refund triggered by a screen tap is the shape C-067 spent an item removing,
 * and the counter's answer is the deliberate refund control on the receipt,
 * with a reason and a name on it. What the unique index guarantees is the half
 * that has no honest manual fix — re-advancing charges nothing a second time.
 *
 * A FAILED CAPTURE RELEASES THE HOLD, and that is the design decision in this
 * file worth arguing with. The alternatives were a `capture_failed` kind with
 * an exceptions list of its own — machinery P1-1 did not ask for, and a second
 * queue for a person to work — or leaving the hold standing, which reads on
 * every screen as "the money is fine" while the card said no. Releasing it is
 * the honest end state: the restaurant is not holding anything it can use, the
 * order goes back to OWING, and `canCollectPayment` therefore lights up the
 * counter control that has existed since C-048. The food is already in the
 * customer's hands and they are standing at the till; asking them to pay is the
 * correct real-world move, and `reason: 'capture_failed'` plus the provider's
 * own words in `detail.note` is what tells the GM at close why.
 */
export async function settleAuthorization(
  orderId: string,
  status: OrderStatus,
  now: Date,
  provider: PaymentProvider = mockPaymentProvider,
  staffId: string | null = null,
): Promise<SettleAuthorizationResult> {
  const outcome = authorizationOutcome(status);
  if (outcome === null) return refuse('nothing_held', 'This order is still in flight.');

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      // The `AuthorizationEvent` shape: the hold's id, and the link a
      // settlement carries back to it. This is a question about the SHAPE of
      // the log — which hold is unspent — and not about the amounts, which is
      // why `MoneyEvent` never had to grow these two columns.
      events: { select: { id: true, kind: true, amountCents: true, authorizationId: true } },
    },
  });
  if (!order) return refuse('order_not_found', 'That order could not be found.');

  const held = heldAuthorization(order.events);
  if (!held) return refuse('nothing_held', 'There is no hold on this order to settle.');

  // The hold's own row id, which is also the key. Durable long before this
  // call — a key invented at the moment of the call has already failed at its
  // job (C-067).
  let providerRef: string | null = null;
  let failure: string | null = null;
  try {
    providerRef = await provider(
      outcome === 'capture' ? 'capture' : 'void',
      held.id,
      held.amountCents,
    );
  } catch (error) {
    if (outcome !== 'capture') {
      // A void that the provider refused is the one case with nothing honest
      // to write: the hold is still live on the customer's card, and a
      // `authorization_voided` row would say it is not. Left standing, so the
      // order keeps reading `authorized` and the log keeps telling the truth.
      // What chases it is the order's own state (C-145): a settled status still
      // `authorized` is exactly `loadStuckHolds`' question, so the history
      // page lists it and the receipt offers the retry — no failure row needed.
      return refuse(
        'void_refused',
        `The hold could not be released: ${describeFailure(error)}`,
      );
    }
    failure = describeFailure(error);
  }

  // Three ways in and two rows out: a capture that worked, a void that worked,
  // and a capture that did not — which becomes a void naming why.
  const draft =
    outcome === 'capture'
      ? providerRef === null
        ? authorizationVoidedEvent(
            now,
            held.amountCents,
            held.id,
            'capture_failed',
            failure ?? undefined,
          )
        : captureEvent(now, held.amountCents, held.id, providerRef)
      : authorizationVoidedEvent(now, held.amountCents, held.id, outcome);

  try {
    await prisma.$transaction(async (tx) => {
      // A person's retry is a person's row (C-145), the same rule `settleRefund`
      // follows: the automatic attempt stays `system`.
      const row = staffId ? { ...draft, actor: 'staff' as const } : draft;
      await tx.orderEvent.create({ data: { orderId, ...eventRow(row, staffId) } });
      // The column written FROM THE LOG rather than to a literal, exactly as
      // `settleRefund` writes it and for the same reason: `paid`, `unpaid` and
      // `authorized` are all answers `derivePaymentState` already knows how to
      // give, and re-reading inside the transaction means a counter payment
      // landing mid-attempt cannot leave a stale one.
      const settled = await tx.orderEvent.findMany({
        where: { orderId },
        select: { kind: true, amountCents: true },
      });
      await tx.order.update({
        where: { id: orderId },
        data: { paymentState: derivePaymentState(settled) },
      });
    });
  } catch (error) {
    // P2002 is the unique index on the link: somebody else settled this hold
    // while the provider was thinking, or an undo-and-re-advance came back
    // round. Their row is the one that counts, and it carried the same key, so
    // the card was touched once.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return refuse('raced', 'This hold was already settled. Reload the receipt.');
    }
    throw error;
  }

  return failure === null && outcome === 'capture'
    ? { ok: true, kind: 'capture', amountCents: held.amountCents }
    : { ok: true, kind: 'void', amountCents: held.amountCents };
}

/** Every status whose hold should already be spent — derived, so a new sold or
 *  not-sold status joins the stuck-hold list without anybody editing it. */
const SETTLED_HOLD_STATUSES = ORDER_STATUSES.filter((s) => authorizationOutcome(s) !== null);

/**
 * A hold the order should no longer have (C-145): the order has finished, one
 * way or the other, and its money still reads `authorized`. A void the provider
 * refused leaves exactly this, and so does a process that died mid-call. The
 * receipt's retry button and the history page's list both ask this one
 * question, the second one as a query.
 */
export const holdIsStuck = (order: { status: OrderStatus; paymentState: string }): boolean =>
  order.paymentState === 'authorized' && SETTLED_HOLD_STATUSES.includes(order.status);

/** Same cap as the refund list, for the same reason. */
const STUCK_HOLD_LIMIT = 50;

export function loadStuckHolds(): Promise<OrderReceipt[]> {
  return prisma.order.findMany({
    where: { paymentState: 'authorized', status: { in: SETTLED_HOLD_STATUSES } },
    orderBy: { placedAt: 'desc' },
    take: STUCK_HOLD_LIMIT,
    ...ORDER_RECEIPT,
  });
}

/**
 * The receipt's retry (C-145). THE ORDER ID IS THE ONLY INPUT: the status is
 * read here, never taken from the form, so a stale screen cannot ask for a
 * capture on an order that was cancelled. Same function as the automatic
 * attempt, and the same key goes to the provider, so it cannot release twice.
 */
export async function retryHold(
  orderId: string,
  now: Date,
  staffId: string | null,
  provider: PaymentProvider = mockPaymentProvider,
): Promise<SettleAuthorizationResult> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { status: true } });
  if (!order) return refuse('order_not_found', 'That order could not be found.');
  return settleAuthorization(orderId, order.status, now, provider, staffId);
}

/** A message from something thrown across a boundary this code does not own —
 *  the same helper `settleRefund` needed, for the same reason. */
const describeFailure = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.trim() === '' ? 'The provider gave no reason.' : message.slice(0, 140);
};
