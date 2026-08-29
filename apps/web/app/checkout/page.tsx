// Checkout (P0-3, P0-6, P0-8).
//
// The gate is asked HERE, before a form is rendered — and asked again by
// `placeOrder` when the form posts. Neither is the authority on its own: this
// one stops a customer filling in a name for an order that cannot be placed,
// and that one stops a stale tab, a bookmarked POST, or a page left open
// through closing time.
import Link from 'next/link';
import { loadMenu } from '@countertop/db/menu';
import { currentCheckout } from '@/lib/checkout-gate';
import { formatCents } from '@/lib/money';
import { getCartReview } from '../cart/actions';
import { CheckoutForm } from './checkout-form';
import { GateNotice } from './gate-notice';
import { describeSelection } from '@/lib/menu-labels';

export const metadata = { title: 'Checkout — Firebird Kitchen' };

// Never prerendered: a gate baked at build time is a restaurant whose opening
// hours were decided by the deploy.
export const dynamic = 'force-dynamic';

export default async function CheckoutPage() {
  const [menu, review, { gate, estimate }] = await Promise.all([
    loadMenu(),
    getCartReview(),
    currentCheckout(),
  ]);

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
          <ul className="mt-2 flex flex-col gap-2">
            {review.lines.map(({ line, priced, problems, priceChange }) => (
              <li key={line.id} className="text-sm">
                <div className="flex justify-between gap-4">
                  <span>
                    {line.composition.quantity} ×{' '}
                    {menu.items[line.composition.itemId]?.name ?? line.composition.itemId}
                  </span>
                  <span className="tabular-nums">
                    {priced ? formatCents(priced.lineTotalCents) : '—'}
                  </span>
                </div>
                {/* This is the customer's last screen before paying — a wrong
                    "NO onions" has to be catchable here, not just on the cart
                    page one step back and the status page one step forward. */}
                {line.composition.selections.length > 0 && (
                  <p className="mt-0.5 text-neutral-700">
                    {line.composition.selections.map((selection, index) => {
                      const group = menu.groups[selection.groupId];
                      const option = group?.options.find((o) => o.id === selection.optionId);
                      if (!option) return null;
                      const { text, negated } = describeSelection(option.name, selection.intensity);
                      return (
                        <span key={`${selection.groupId}:${selection.optionId}`}>
                          {index > 0 && ', '}
                          <span className={negated ? 'font-bold text-red-700' : ''}>{text}</span>
                        </span>
                      );
                    })}
                  </p>
                )}
                {line.composition.note && (
                  <p className="mt-0.5 italic text-neutral-700">“{line.composition.note}”</p>
                )}
                {/* Same per-line flags the cart page shows — a line 86'd or
                    repriced after the customer got here must say so right on
                    this line, not just the generic banner below the form. */}
                {problems.map((problem) => (
                  <p key={problem.kind + problem.message} className="mt-0.5 font-medium text-red-700">
                    {problem.message}
                  </p>
                ))}
                {priceChange && (
                  <p className="mt-0.5 font-medium text-amber-700">
                    Price changed: {formatCents(priceChange.fromUnitPriceCents)} →{' '}
                    {formatCents(priceChange.toUnitPriceCents)} each.
                  </p>
                )}
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

      {/* The estimate (P0-7), and ONLY while the gate is open — a closed
          restaurant shows the gate notice in its place, because a time promise
          for an order nobody will take is the precise lie this requirement
          exists to forbid. A range, never a point: recalculated on every
          render of this page, which is `force-dynamic`. */}
      {gate.open && review.lines.length > 0 && (
        <p data-testid="ready-estimate" className="mt-6 text-lg">
          Usually ready for pickup <strong>{estimate.label}</strong> after you order.
        </p>
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
