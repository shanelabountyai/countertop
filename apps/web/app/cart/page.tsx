// The cart (P0-3, display side). Everything shown here is recomputed by
// `reviewCart` against the menu as it is right now — the cookie carries
// compositions, never prices.
import Link from 'next/link';
import { loadMenu } from '@countertop/db/menu';
import { formatCents } from '@/lib/money';
import { describeSelection } from '@/lib/menu-labels';
import { getCartReview, removeCartLineForm, confirmCartPricesForm } from './actions';

export const metadata = { title: 'Your cart — Firebird Kitchen' };

export default async function CartPage() {
  const [menu, review] = await Promise.all([loadMenu(), getCartReview()]);

  return (
    <main className="mx-auto max-w-2xl p-6">
      <Link href="/menu" className="text-sm underline underline-offset-4">
        ← Menu
      </Link>
      <h1 className="mt-4 text-3xl font-semibold">Your cart</h1>

      {review.lines.length === 0 && (
        <p className="mt-6 text-neutral-600">Nothing in it yet.</p>
      )}

      <ul className="mt-6 flex flex-col gap-4">
        {review.lines.map(({ line, priced, problems, priceChange }) => {
          const item = menu.items[line.composition.itemId];
          return (
            <li key={line.id} className="rounded-lg border border-neutral-300 p-4">
              <div className="flex items-baseline justify-between gap-4">
                <h2 className="font-semibold">
                  {line.composition.quantity} × {item?.name ?? line.composition.itemId}
                </h2>
                <span className="tabular-nums">
                  {priced ? formatCents(priced.lineTotalCents) : '—'}
                </span>
              </div>

              <ul className="mt-2 flex flex-col gap-0.5 text-sm">
                {line.composition.selections.map((selection) => {
                  const group = menu.groups[selection.groupId];
                  const option = group?.options.find((o) => o.id === selection.optionId);
                  if (!option) return null;
                  const { text, negated } = describeSelection(option, selection.intensity);
                  return (
                    <li
                      key={`${selection.groupId}:${selection.optionId}`}
                      className={negated ? 'font-semibold text-red-700' : 'text-neutral-700'}
                    >
                      {text}
                    </li>
                  );
                })}
              </ul>

              {line.composition.note && (
                <p className="mt-2 text-sm italic text-neutral-700">
                  “{line.composition.note}”
                </p>
              )}

              {problems.map((problem) => (
                <p key={problem.kind + problem.message} className="mt-2 text-sm font-medium text-red-700">
                  {problem.message}
                </p>
              ))}

              {priceChange && (
                <p className="mt-2 text-sm font-medium text-amber-700">
                  Price changed: {formatCents(priceChange.fromUnitPriceCents)} →{' '}
                  {formatCents(priceChange.toUnitPriceCents)} each.
                </p>
              )}

              <div className="mt-3 flex gap-3">
                <form action={removeCartLineForm.bind(null, line.id)}>
                  <button
                    type="submit"
                    className="min-h-12 rounded-md border border-neutral-300 px-4 text-sm"
                  >
                    Remove
                  </button>
                </form>
              </div>
            </li>
          );
        })}
      </ul>

      {review.lines.length > 0 && (
        <section className="mt-8 border-t border-neutral-300 pt-4">
          <dl className="flex flex-col gap-1 tabular-nums">
            <div className="flex justify-between">
              <dt>Subtotal</dt>
              <dd>{formatCents(review.totals.subtotalCents)}</dd>
            </div>
            <div className="flex justify-between">
              <dt>Tax</dt>
              <dd>{formatCents(review.totals.taxCents)}</dd>
            </div>
            <div className="flex justify-between text-lg font-semibold">
              <dt>Total</dt>
              <dd data-testid="cart-total">{formatCents(review.totals.totalCents)}</dd>
            </div>
          </dl>

          {review.needsPriceConfirmation && (
            <form action={confirmCartPricesForm} className="mt-4">
              <button
                type="submit"
                className="min-h-12 w-full rounded-lg border border-amber-600 px-6 font-semibold text-amber-800"
              >
                I understand the new prices
              </button>
            </form>
          )}

          {review.needsFix && (
            <p className="mt-4 font-medium text-red-700">
              Fix or remove the flagged lines before placing this order.
            </p>
          )}

          {/* Checkout itself — name, phone, and the pause/hours gate — is
              C-011's. Placement is already built and tested; it has no button
              yet, and saying so beats a button that 404s. */}
          <p className="mt-4 text-sm text-neutral-600">
            Checkout arrives in a later session.
          </p>
        </section>
      )}
    </main>
  );
}
