// Checkout (P0-3, P0-6, P0-8).
//
// The gate is asked HERE, before a form is rendered — and asked again by
// `placeOrder` when the form posts. Neither is the authority on its own: this
// one stops a customer filling in a name for an order that cannot be placed,
// and that one stops a stale tab, a bookmarked POST, or a page left open
// through closing time.
import Link from 'next/link';
import { loadMenu } from '@countertop/db/menu';
import { currentGate } from '@/lib/checkout-gate';
import { formatCents } from '@/lib/money';
import { getCartReview } from '../cart/actions';
import { CheckoutForm } from './checkout-form';
import { GateNotice } from './gate-notice';

export const metadata = { title: 'Checkout — Firebird Kitchen' };

// Never prerendered: a gate baked at build time is a restaurant whose opening
// hours were decided by the deploy.
export const dynamic = 'force-dynamic';

export default async function CheckoutPage() {
  const [menu, review, gate] = await Promise.all([loadMenu(), getCartReview(), currentGate()]);

  return (
    <main className="mx-auto max-w-2xl p-6">
      <Link href="/cart" className="text-sm underline underline-offset-4">
        ← Cart
      </Link>
      <h1 className="mt-4 text-3xl font-semibold">Checkout</h1>

      {!gate.open && <GateNotice gate={gate} className="mt-6" />}

      {/* Siblings in a STABLE list, deliberately. Placing an order clears the
          cart cookie, which re-runs this server component — and a
          `<CheckoutForm>` that lived inside a branch keyed on cart emptiness
          would be unmounted by its own success, taking the customer's order
          number with it. Every child below keeps its slot. */}
      {review.lines.length > 0 && (
        <section className="mt-6 rounded-lg border border-neutral-300 p-4">
          <h2 className="font-semibold">Your order</h2>
          <ul className="mt-2 flex flex-col gap-1">
            {review.lines.map(({ line, priced }) => (
              <li key={line.id} className="flex justify-between gap-4 text-sm">
                <span>
                  {line.composition.quantity} ×{' '}
                  {menu.items[line.composition.itemId]?.name ?? line.composition.itemId}
                </span>
                <span className="tabular-nums">
                  {priced ? formatCents(priced.lineTotalCents) : '—'}
                </span>
              </li>
            ))}
          </ul>
          <dl className="mt-3 flex flex-col gap-1 border-t border-neutral-300 pt-3 tabular-nums">
            <div className="flex justify-between text-sm">
              <dt>Subtotal</dt>
              <dd>{formatCents(review.totals.subtotalCents)}</dd>
            </div>
            <div className="flex justify-between text-sm">
              <dt>Tax</dt>
              <dd>{formatCents(review.totals.taxCents)}</dd>
            </div>
            <div className="flex justify-between text-lg font-semibold">
              <dt>Total</dt>
              <dd data-testid="checkout-total">{formatCents(review.totals.totalCents)}</dd>
            </div>
          </dl>
        </section>
      )}

      {/* The total is passed as EVIDENCE, not as input: the server recomputes
          it and logs a mismatch (P0-2). */}
      <CheckoutForm
        cartEmpty={review.lines.length === 0}
        canPlace={gate.open && !review.needsFix && !review.needsPriceConfirmation}
        clientTotalCents={review.totals.totalCents}
      />

      {review.lines.length > 0 && review.needsFix && (
        <p className="mt-4 font-medium text-red-700">
          Fix or remove the flagged lines in your cart before placing this order.
        </p>
      )}
      {review.lines.length > 0 && review.needsPriceConfirmation && (
        <p className="mt-4 font-medium text-amber-700">
          A price changed. Go back to the cart and confirm the new total.
        </p>
      )}
    </main>
  );
}
