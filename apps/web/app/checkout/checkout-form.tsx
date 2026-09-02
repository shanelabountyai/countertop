'use client';

// The checkout form (P0-8, P0-10).
//
// The idempotency key is generated ONCE per checkout attempt and resent on
// every retry of that attempt, so a double-tap, a flaky connection and an
// impatient re-submit all resolve to the same order. The disabled button is
// UX; the unique constraint behind the key is the mechanism (CLAUDE.md).
import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { isEnrollablePhone, type LoyaltyTerms } from '@countertop/core';
import { placeCartOrder, type CheckoutError, type OrderConfirmation } from './actions';
import { formatCents } from '@/lib/money';
import { PAYMENT_LABEL } from '@/lib/status-labels';
import { describeSelection } from '@/lib/menu-labels';

const MAX_NAME = 40;
const MAX_PHONE = 32;
const MAX_NOTE = 140;

/** What the enrolment checkbox needs to describe itself (PRD 7 P0-1). Null
 *  when the program is off, and null renders NOTHING — no checkbox, no copy,
 *  no mention that a punch card exists. */
export type LoyaltyOfferProps = { terms: LoyaltyTerms; expiryDays: number } | null;

export function CheckoutForm({
  cartEmpty,
  canPlace,
  clientTotalCents,
  loyalty,
}: {
  /** True once there is nothing to place — including the instant AFTER a
   *  successful placement, which clears the cart. This component owns that
   *  case rather than being conditionally rendered around it, because it is
   *  holding the order number the customer just earned. */
  cartEmpty: boolean;
  /** False while the gate is shut, or the cart needs fixing. The server
   *  refuses independently — this only stops someone typing a name for
   *  nothing. */
  canPlace: boolean;
  clientTotalCents: number;
  loyalty: LoyaltyOfferProps;
}) {
  // Lazy initialiser, so it is generated once for the life of this attempt and
  // not regenerated on every keystroke's re-render.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [errors, setErrors] = useState<CheckoutError[]>([]);
  const [confirmation, setConfirmation] = useState<OrderConfirmation | null>(null);
  // The phone is tracked only to decide whether enrolment can be OFFERED. The
  // field itself stays uncontrolled — the value that gets placed is read off
  // the FormData, like every other field here.
  const [phone, setPhone] = useState('');

  // The receipt wins over everything: this render happens immediately after
  // the cart was cleared by the placement that produced it.
  if (confirmation) return <Confirmation confirmation={confirmation} />;

  if (cartEmpty) {
    return (
      <p className="mt-6 text-neutral-600">
        Your cart is empty.{' '}
        <Link href="/menu" className="underline underline-offset-4">
          Pick something
        </Link>
        .
      </p>
    );
  }

  function submit(formData: FormData) {
    setErrors([]);
    startTransition(async () => {
      const result = await placeCartOrder({
        idempotencyKey,
        customerName: formData.get('customerName'),
        customerPhone: formData.get('customerPhone'),
        orderNote: formData.get('orderNote'),
        // A disabled checkbox is not submitted at all, so an unusable phone
        // reads as false here without the form having to remember to untick
        // anything. The server checks the number again regardless.
        joinLoyalty: formData.get('joinLoyalty') === 'on',
        // The radio is the customer's INTENT; the server decides the state.
        payNow: formData.get('payment') === 'now',
        clientTotalCents,
      });
      if (result.ok) {
        setConfirmation(result.confirmation);
        return;
      }
      setErrors(result.errors);
      // Every refusal here means the server disagrees with what this screen is
      // showing — the cart emptied in another tab, an option was 86'd, a price
      // moved, the gate shut. The summary, the estimate and the button above
      // are rendered by the SERVER component around this form, so without this
      // the customer reads "$11.85, place order" and "your cart is empty" at
      // the same time and reasonably concludes the app is broken. Refreshing
      // re-asks the same question that produced the screen.
      router.refresh();
    });
  }

  return (
    // `onSubmit`, not `action`: React resets a form after an action resolves,
    // which on a REFUSAL throws away the name the customer just typed and
    // makes fixing a flagged line cost a retype. Nothing is lost by not using
    // `action` — the idempotency key is generated client-side, so this form
    // has never worked without JavaScript. Native `required` still runs first.
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit(new FormData(event.currentTarget));
      }}
      className="mt-6 flex flex-col gap-4"
    >
      <label className="flex flex-col gap-1">
        <span className="font-medium">
          Name for the order <span aria-hidden="true">*</span>
        </span>
        <input
          name="customerName"
          required
          maxLength={MAX_NAME}
          autoComplete="name"
          className="min-h-12 rounded-lg border border-neutral-400 px-3"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="font-medium">Phone (optional)</span>
        <input
          name="customerPhone"
          type="tel"
          maxLength={MAX_PHONE}
          autoComplete="tel"
          onChange={(event) => setPhone(event.target.value)}
          className="min-h-12 rounded-lg border border-neutral-400 px-3"
        />
      </label>

      {/* The punch card (PRD 7 P0-1). Unchecked by default, no interstitial,
          no second screen: ordering without it is a first-class path and this
          is one checkbox on the form the customer was already filling in.
          Rendered only when the program is on — `loyalty` is null otherwise
          and nothing below exists to be read by a screen reader either. */}
      {loyalty && <LoyaltyOptIn offer={loyalty} phone={phone} />}

      <label className="flex flex-col gap-1">
        <span className="font-medium">Anything we should know? (optional)</span>
        <input
          name="orderNote"
          maxLength={MAX_NOTE}
          placeholder="Blue Honda out front"
          className="min-h-12 rounded-lg border border-neutral-400 px-3"
        />
      </label>

      {/* P1-8. Both, deliberately (PRD open question, resolved in v2): a mock
          card charge at checkout, and pay-at-pickup for the customer who would
          rather hand over a card at the counter. The kitchen card flags the
          second kind so the counter collects before the bag leaves. */}
      <fieldset className="flex flex-col gap-2">
        <legend className="font-medium">Payment</legend>
        <label className="flex min-h-12 items-center gap-2">
          <input type="radio" name="payment" value="now" defaultChecked className="size-5" />
          Pay now — card
        </label>
        <label className="flex min-h-12 items-center gap-2">
          <input type="radio" name="payment" value="pickup" className="size-5" />
          {PAYMENT_LABEL.unpaid}
        </label>
      </fieldset>

      <button
        type="submit"
        disabled={!canPlace || pending}
        className="min-h-14 rounded-lg bg-neutral-900 px-6 text-lg font-semibold text-white disabled:opacity-50"
      >
        {pending ? 'Placing…' : `Place order — ${formatCents(clientTotalCents)}`}
      </button>

      {errors.length > 0 && (
        <ul aria-live="polite" className="flex flex-col gap-1">
          {errors.map((error) => (
            <li key={error.kind + error.message} className="font-medium text-red-700">
              {error.message}
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}

/**
 * The enrolment checkbox (PRD 7 P0-1).
 *
 * DISABLED UNTIL THE PHONE IS ONE WE CAN ACTUALLY KEY A MEMBERSHIP ON, asked
 * of the same `isEnrollablePhone` the writer uses — a checkbox enabled on a
 * looser rule is a customer ticking a box that silently does nothing. The
 * reason is written next to it rather than left to be guessed from a greyed
 * control.
 *
 * The copy states what is kept and for how long, because that is the
 * requirement and because "join our rewards!" next to a phone field is the
 * dark pattern this product is supposed to be the counter-example to.
 */
function LoyaltyOptIn({ offer, phone }: { offer: NonNullable<LoyaltyOfferProps>; phone: string }) {
  const enrollable = isEnrollablePhone(phone);
  const reward = formatCents(offer.terms.rewardValueCents);
  return (
    <fieldset className="flex flex-col gap-2 rounded-lg border border-neutral-300 p-4">
      <legend className="px-1 font-medium">Punch card</legend>
      <label className="flex min-h-12 items-start gap-2">
        <input
          type="checkbox"
          name="joinLoyalty"
          disabled={!enrollable}
          className="mt-1 size-5 disabled:opacity-50"
        />
        <span>
          Collect points on this order —{' '}
          {offer.terms.pointsPerDollar === 1
            ? 'a point per dollar'
            : `${offer.terms.pointsPerDollar} points per dollar`}{' '}
          you spend on food, and {offer.terms.rewardThresholdPoints} points is {reward} off a
          future order.
        </span>
      </label>
      <p className="text-sm text-neutral-700">
        {enrollable
          ? `We keep your phone number — as a one-way code, not the number itself — your name, and what you have earned. If you do not order for ${offer.expiryDays} days, the points expire and we delete it.`
          : 'Add your phone number above to join. That is what a punch card is counted against.'}
      </p>
    </fieldset>
  );
}

/** The receipt (P0-8). Order number and name, never the UUID. */
function Confirmation({ confirmation }: { confirmation: OrderConfirmation }) {
  return (
    <section className="mt-6 rounded-lg border-2 border-green-700 bg-green-50 p-6">
      <h2 className="text-xl font-semibold text-green-900">Order placed</h2>
      <p className="mt-2 text-4xl font-bold tabular-nums" data-testid="order-number">
        {confirmation.orderNumber}
      </p>
      <p className="text-lg">under {confirmation.customerName}</p>
      {/* The receipt itself — the same negation styling as the status page,
          so what the customer confirms here is what the kitchen makes. */}
      <ul className="mt-4 flex flex-col gap-2">
        {confirmation.lines.map((line, lineIndex) => (
          <li key={lineIndex} className="text-sm">
            <div className="flex justify-between gap-4">
              <span className="font-medium text-neutral-900">
                {line.quantity} × {line.itemName}
              </span>
              <span className="tabular-nums">{formatCents(line.lineTotalCents)}</span>
            </div>
            {line.options.length > 0 && (
              <p className="mt-0.5 text-neutral-700">
                {line.options.map((option, index) => {
                  const { text, negated } = describeSelection(option.optionName, option.intensity);
                  return (
                    <span key={index}>
                      {index > 0 && ', '}
                      <span className={negated ? 'font-bold text-red-700' : ''}>{text}</span>
                    </span>
                  );
                })}
              </p>
            )}
            {line.note && <p className="mt-0.5 italic text-neutral-700">“{line.note}”</p>}
          </li>
        ))}
      </ul>
      <dl className="mt-4 flex flex-col gap-1 border-t border-neutral-300 pt-3 tabular-nums">
        <div className="flex justify-between">
          <dt>Subtotal</dt>
          <dd>{formatCents(confirmation.subtotalCents)}</dd>
        </div>
        <div className="flex justify-between">
          <dt>Tax</dt>
          <dd>{formatCents(confirmation.taxCents)}</dd>
        </div>
        <div className="flex justify-between font-semibold">
          <dt>Total</dt>
          <dd data-testid="confirmed-total">{formatCents(confirmation.totalCents)}</dd>
        </div>
      </dl>
      {/* An unpaid order is the one the customer has to do something about. */}
      <p className="mt-3 text-lg font-semibold" data-testid="confirmed-payment">
        {confirmation.paymentState === 'unpaid'
          ? `${PAYMENT_LABEL.unpaid} — ${formatCents(confirmation.totalCents)} due`
          : PAYMENT_LABEL[confirmation.paymentState]}
      </p>
      {/* The one thing a customer keeps. The token is the only handle on this
          order from outside — the number is guessable, so it is not a key. */}
      <Link
        href={`/status/${confirmation.statusToken}`}
        data-testid="track-order"
        className="mt-4 flex min-h-12 w-fit items-center rounded-lg border-2 border-green-800 px-4 text-lg font-semibold text-green-900"
      >
        Track this order
      </Link>
      <Link href="/menu" className="mt-4 inline-block underline underline-offset-4">
        Order something else
      </Link>
    </section>
  );
}
