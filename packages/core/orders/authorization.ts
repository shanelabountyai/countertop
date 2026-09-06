// Holding the money instead of taking it (PRD 3 P1-1, C-069).
//
// WHAT WAS WRONG. A `paidNow` checkout wrote a `payment` — the restaurant had
// $34.20 of somebody's money before anybody had touched a tortilla. The
// pickup-only shape makes that the wrong end of the transaction: the customer
// who gets stuck on the freeway is closed out as `abandoned`, and the money is
// already taken, so making them whole costs a REFUND — a provider call that
// can fail, an exceptions list, a person chasing it (all of C-067 and C-071).
// A hold that was never captured costs a VOID, which is a thing that cannot go
// wrong in the customer's disfavour: nothing left their card.
//
// THE SAME SHAPE AS THE REFUND, POINTED THE OTHER WAY, and deliberately so —
// a durable row whose own id is the idempotency key, settled later by a second
// row that names it. `refund_requested` -> `refund` is `authorization` ->
// `capture`. What differs is the direction and the second exit: a refund
// request has one settlement, an authorization has two (`capture` or
// `authorization_voided`) and exactly one of them may ever happen, which is a
// single unique index rather than the refund's partial one.
//
// PURE, like everything else in this package: drafts in, no clock, no
// database.
import { paymentTotals, type MoneyEvent } from './payment';
import type { OrderEventDraft, OrderEventKind } from './state-machine';

/**
 * Enough of an event to place a settlement against its hold.
 *
 * The two `MoneyEvent` scalars are NOT here on purpose — the balance is
 * arithmetic over amounts (see `paymentTotals`) and needs no linkage at all.
 * This shape is asked for by exactly one caller, the writer, which has to know
 * WHICH authorization it is settling because that id is the idempotency key
 * the provider is handed.
 *
 * A database row satisfies it structurally, like every other input here.
 */
export type AuthorizationEvent = {
  id: string;
  kind: OrderEventKind;
  amountCents: number | null;
  authorizationId: string | null;
};

/** A hold nothing has settled yet: the money the restaurant may still take. */
export type HeldAuthorization = { id: string; amountCents: number };

/**
 * The hold on this order that has neither been captured nor released.
 *
 * BY LINKAGE, not by ordering, for the reason `pendingRefunds` gives: "last"
 * needs an ordering the receipt's select does not impose, and every test with
 * a frozen `now` shares an instant by construction. A set membership test has
 * no ties to break.
 *
 * At most one, and that is a property of placement rather than a rule enforced
 * here: an order is authorized once, at checkout, or not at all. Returning the
 * first is therefore returning the only one — and if a second ever appears,
 * the unique index on the settlement link is what stops the two of them being
 * captured against one provider call.
 */
export function heldAuthorization(
  events: readonly AuthorizationEvent[],
): HeldAuthorization | null {
  const settled = new Set(
    events
      .filter((event) => event.kind === 'capture' || event.kind === 'authorization_voided')
      .map((event) => event.authorizationId),
  );
  const held = events.find(
    (event) => event.kind === 'authorization' && !settled.has(event.id) && event.amountCents !== null,
  );
  return held ? { id: held.id, amountCents: held.amountCents ?? 0 } : null;
}

/**
 * The hold taken at checkout.
 *
 * NO PROVIDER CALL BEHIND IT, and that is the existing precedent rather than a
 * shortcut: `paymentEvent` has recorded `provider: 'mock'` since C-063 without
 * anything ever being called, because the master PRD's Non-Goal says there is
 * no processor. What C-069 adds is the seam where a call WOULD go and where it
 * is allowed to fail — and that seam is capture and void, both of which happen
 * after the order exists and outside its transaction, which is where a network
 * call belongs (C-067's rule).
 *
 * `customer`, because the tap that authorized the card was theirs — the same
 * actor `paymentEvent` gives a checkout payment, and the same reason.
 *
 * NOT a status change: null on both, so the time-in-state tally steps over it
 * exactly as it steps over `payment`, `refund` and `adjustment`.
 */
export function authorizationEvent(now: Date, amountCents: number): OrderEventDraft {
  return {
    at: now,
    kind: 'authorization',
    fromStatus: null,
    toStatus: null,
    actor: 'customer',
    reason: null,
    amountCents,
    detail: { amountCents, provider: 'mock' },
  };
}

/**
 * The hold turned into money, at the counter.
 *
 * `system`, and the actor is an argument this file wants to make rather than a
 * default. The cook who tapped "Picked up" did not decide to charge anybody's
 * card — the customer decided that at checkout, and this row is the machine
 * completing it. Putting the cook's name on it would be a name on a decision
 * they did not make, which is the argument `settleRefund` makes about the
 * cancellation's automatic attempt.
 */
export function captureEvent(
  now: Date,
  amountCents: number,
  authorizationId: string,
  providerRef: string,
): OrderEventDraft {
  return {
    at: now,
    kind: 'capture',
    fromStatus: null,
    toStatus: null,
    actor: 'system',
    reason: null,
    amountCents,
    providerRef,
    authorizationId,
    detail: { amountCents, provider: 'mock' },
  };
}

/** Why a hold was let go. Not an enum in the database — the column is a free
 *  `reason` string and these are the three values this product writes — but a
 *  union here, so a fourth cannot appear without the compiler seeing it. */
export type VoidReason =
  /** The order was cancelled before the food went out. */
  | 'cancelled'
  /** Nobody came for it. THE POINT OF THIS ITEM: it costs a void, not a refund. */
  | 'no_show'
  /** The capture itself failed. The hold is worthless either way, so it is
   *  released and the order goes back to owing money — which puts the existing
   *  counter-collection control in exactly the right place, with no exceptions
   *  list this requirement never asked for. */
  | 'capture_failed';

/**
 * The hold released. Nothing moved, and nothing has to go back.
 *
 * Carries the amount it let go, so `paymentTotals` can subtract it from the
 * held figure without following the link — the balance stays arithmetic over
 * two scalars every select in the product already has.
 */
export function authorizationVoidedEvent(
  now: Date,
  amountCents: number,
  authorizationId: string,
  reason: VoidReason,
  note?: string,
): OrderEventDraft {
  return {
    at: now,
    kind: 'authorization_voided',
    fromStatus: null,
    toStatus: null,
    actor: 'system',
    reason,
    amountCents,
    authorizationId,
    ...(note ? { detail: { note } } : {}),
  };
}

/**
 * The card was held and let go, and nothing was ever taken.
 *
 * THE SENTENCE THE CUSTOMER NEEDS, and the one screen that has to say it is
 * the status page. Without it a cancelled prepaid order reads "Pay at pickup —
 * $11.85 due", because a released hold leaves `paymentState` at `unpaid` and
 * the whole total outstanding — both correct, and together a message that
 * sends somebody who paid twenty minutes ago to the phone.
 *
 * Two scalars, so every existing `MoneyEvent` select answers it. Deliberately
 * not "was this order voided": an order that was captured and then refunded
 * has money to talk about and is not this case.
 */
export function releasedWithoutCapture(events: readonly MoneyEvent[]): boolean {
  const { capturedCents, authorizedCents } = paymentTotals(events);
  return (
    capturedCents === 0 &&
    authorizedCents === 0 &&
    events.some((event) => event.kind === 'authorization')
  );
}
