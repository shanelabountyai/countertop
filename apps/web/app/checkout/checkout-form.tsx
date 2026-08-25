'use client';

// The checkout form (P0-8, P0-10).
//
// The idempotency key is generated ONCE per checkout attempt and resent on
// every retry of that attempt, so a double-tap, a flaky connection and an
// impatient re-submit all resolve to the same order. The disabled button is
// UX; the unique constraint behind the key is the mechanism (CLAUDE.md).
import { useState, useTransition } from 'react';
import Link from 'next/link';
import { placeCartOrder, type CheckoutError, type OrderConfirmation } from './actions';
import { formatCents } from '@/lib/money';

const MAX_NAME = 40;
const MAX_PHONE = 32;
const MAX_NOTE = 140;

export function CheckoutForm({
  cartEmpty,
  canPlace,
  clientTotalCents,
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
}) {
  // Lazy initialiser, so it is generated once for the life of this attempt and
  // not regenerated on every keystroke's re-render.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [pending, startTransition] = useTransition();
  const [errors, setErrors] = useState<CheckoutError[]>([]);
  const [confirmation, setConfirmation] = useState<OrderConfirmation | null>(null);

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
        clientTotalCents,
      });
      if (result.ok) setConfirmation(result.confirmation);
      else setErrors(result.errors);
    });
  }

  return (
    <form action={submit} className="mt-6 flex flex-col gap-4">
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
          className="min-h-12 rounded-lg border border-neutral-400 px-3"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="font-medium">Anything we should know? (optional)</span>
        <input
          name="orderNote"
          maxLength={MAX_NOTE}
          placeholder="Blue Honda out front"
          className="min-h-12 rounded-lg border border-neutral-400 px-3"
        />
      </label>

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

/** The receipt (P0-8). Order number and name, never the UUID. */
function Confirmation({ confirmation }: { confirmation: OrderConfirmation }) {
  return (
    <section className="mt-6 rounded-lg border-2 border-green-700 bg-green-50 p-6">
      <h2 className="text-xl font-semibold text-green-900">Order placed</h2>
      <p className="mt-2 text-4xl font-bold tabular-nums" data-testid="order-number">
        {confirmation.orderNumber}
      </p>
      <p className="text-lg">under {confirmation.customerName}</p>
      <dl className="mt-4 flex flex-col gap-1 tabular-nums">
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
      {/* C-014 renders the page behind this token. Printing the link now beats
          a confirmation that quietly drops the one thing a customer keeps. */}
      <p className="mt-4 text-sm text-neutral-700">
        Track this order at <code>/status/{confirmation.statusToken}</code>
      </p>
      <Link href="/menu" className="mt-4 inline-block underline underline-offset-4">
        Order something else
      </Link>
    </section>
  );
}
