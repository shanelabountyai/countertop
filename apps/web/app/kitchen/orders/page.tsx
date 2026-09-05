// Staff order history — the receipt lookup the live queue can't do (P0-11's
// lookup is scoped to today's open orders; this is every status, any day).
//
// A GET form, like the queue's own lookup: the walk-up "what did I actually
// order last week" moment works before hydration, and the result is a URL a
// second screen can be opened on.
import Link from 'next/link';
import { formatOrderNumber, orderBalance } from '@countertop/core';
import { loadGateState } from '@countertop/db/gate';
import { searchOrderHistory } from '@countertop/db/history';
import { loadRefundExceptions } from '@countertop/db/refund';
import { formatCents } from '@/lib/money';
import { formatPlacedAt } from '@/lib/format-time';
import { STATUS_LABEL } from '@/lib/status-labels';

export const metadata = { title: 'Order history — Firebird Kitchen' };

// Never prerendered: a search result baked at build time answers no search.
export const dynamic = 'force-dynamic';

export default async function OrderHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; day?: string }>;
}) {
  const { q, day: dayParam } = await searchParams;
  const query = q ?? '';
  const day = dayParam ?? '';
  const [gateState, orders, refundExceptions] = await Promise.all([
    loadGateState(new Date()),
    searchOrderHistory(query, day),
    loadRefundExceptions(),
  ]);

  // `seq` recurs every business day, so a bare number legitimately matches
  // several orders — the day is how you get from that list to the one order.
  const nothingMatches =
    query === '' && day === ''
      ? 'No orders yet.'
      : query === ''
        ? `No orders on ${day}.`
        : day === ''
          ? `Nothing matches "${query}".`
          : `Nothing matches "${query}" on ${day}.`;

  return (
    <main className="mx-auto max-w-2xl p-6">
      <Link href="/kitchen" className="inline-flex min-h-12 w-fit items-center text-sm underline underline-offset-4">
        ← Queue
      </Link>
      <h1 className="mt-4 text-3xl font-semibold">Order history</h1>
      <p className="mt-1 text-neutral-600">
        Every order, any status, any day — for the receipt a live queue search can no longer find.
      </p>

      {/* Refunds that need a person (PRD 3 P0-4, C-067).
          ABOVE THE SEARCH AND OUTSIDE IT, deliberately. This is the one screen
          in the product that knows about an order after the queue has finished
          with it, and money the restaurant owes and has not sent is not
          something anybody is going to think to search for — a customer whose
          card was never credited does not appear in any other list, on any day,
          under any status. It is also not bounded by the report's window: a
          refund that failed on Friday is still owed on Monday.

          Unfiltered by the form below for the same reason: narrowing the
          exceptions to whatever somebody happened to type would hide the ones
          they did not. */}
      {refundExceptions.length > 0 && (
        <section
          data-testid="refund-exceptions"
          className="mt-6 rounded-lg border-2 border-red-700 bg-red-50 p-4"
        >
          <h2 className="font-semibold text-red-900">
            Refunds not sent ({refundExceptions.length})
          </h2>
          <p className="mt-1 text-sm text-red-900">
            Money the restaurant owes back. Open the order and send it again — the same key
            goes to the provider, so a retry cannot pay twice.
          </p>
          <ul className="mt-3 flex flex-col gap-2">
            {refundExceptions.map((order) => (
              <li key={order.id}>
                <Link
                  href={`/kitchen/orders/${order.id}`}
                  className="flex min-h-14 flex-wrap items-center justify-between gap-2 rounded-lg border border-red-700 bg-white px-4 py-2 hover:border-red-900"
                >
                  <span className="flex items-baseline gap-3">
                    <span className="font-semibold tabular-nums">
                      {formatOrderNumber(order.seq)}
                    </span>
                    <span>{order.customerName}</span>
                  </span>
                  <span className="flex items-baseline gap-3 text-sm">
                    <span className="text-neutral-600">
                      {formatPlacedAt(order.placedAt, gateState.timezone)}
                    </span>
                    {/* What is still held, not the order total: a comp or a
                        partial refund in between makes those two different
                        numbers, and this list is about the money. */}
                    <span className="font-semibold tabular-nums text-red-900">
                      {formatCents(orderBalance(order).collectedCents)} owed
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <form className="mt-6 flex flex-wrap gap-2">
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-sm font-medium">Find an order by name or number</span>
          <input
            type="search"
            name="q"
            defaultValue={query}
            placeholder="Dana, or 047"
            className="min-h-12 rounded-lg border border-neutral-400 px-3 text-lg"
          />
        </label>
        <label className="flex flex-col gap-1">
          {/* A native date input: the value it submits is "YYYY-MM-DD", which
              is the `businessDay` column verbatim. No picker, no parsing. */}
          <span className="text-sm font-medium">On day</span>
          <input
            type="date"
            name="day"
            defaultValue={day}
            className="min-h-12 rounded-lg border border-neutral-400 px-3 text-lg"
          />
        </label>
        <button
          type="submit"
          className="mt-6 min-h-12 rounded-lg border border-neutral-400 px-6 font-semibold"
        >
          Find
        </button>
        {(query !== '' || day !== '') && (
          <Link
            href="/kitchen/orders"
            className="mt-6 flex min-h-12 items-center rounded-lg px-4 underline underline-offset-4"
          >
            Show all
          </Link>
        )}
      </form>

      {orders.length === 0 ? (
        <p className="mt-8 text-neutral-600">
          {nothingMatches}
        </p>
      ) : (
        <ul className="mt-6 flex flex-col gap-2">
          {orders.map((order) => (
            <li key={order.id}>
              <Link
                href={`/kitchen/orders/${order.id}`}
                className="flex min-h-14 flex-wrap items-center justify-between gap-2 rounded-lg border border-neutral-300 px-4 py-2 hover:border-neutral-500"
              >
                <span className="flex items-baseline gap-3">
                  <span className="font-semibold tabular-nums">{formatOrderNumber(order.seq)}</span>
                  <span>{order.customerName}</span>
                </span>
                <span className="flex items-baseline gap-3 text-sm text-neutral-600">
                  <span>{formatPlacedAt(order.placedAt, gateState.timezone)}</span>
                  <span className="font-medium text-neutral-900">{STATUS_LABEL[order.status]}</span>
                  <span className="tabular-nums">{formatCents(order.totalCents)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
