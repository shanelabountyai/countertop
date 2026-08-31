// Staff order history — the receipt lookup the live queue can't do (P0-11's
// lookup is scoped to today's open orders; this is every status, any day).
//
// A GET form, like the queue's own lookup: the walk-up "what did I actually
// order last week" moment works before hydration, and the result is a URL a
// second screen can be opened on.
import Link from 'next/link';
import { formatOrderNumber } from '@countertop/core';
import { loadGateState } from '@countertop/db/gate';
import { searchOrderHistory } from '@countertop/db/history';
import { formatCents } from '@/lib/money';
import { formatPlacedAt } from '@/lib/format-time';
import { STATUS_LABEL } from '@/lib/status-labels';

export const metadata = { title: 'Order history — Firebird Kitchen' };

// Never prerendered: a search result baked at build time answers no search.
export const dynamic = 'force-dynamic';

export default async function OrderHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const query = (await searchParams).q ?? '';
  const [gateState, orders] = await Promise.all([loadGateState(new Date()), searchOrderHistory(query)]);

  return (
    <main className="mx-auto max-w-2xl p-6">
      <Link href="/kitchen" className="inline-flex min-h-12 w-fit items-center text-sm underline underline-offset-4">
        ← Queue
      </Link>
      <h1 className="mt-4 text-3xl font-semibold">Order history</h1>
      <p className="mt-1 text-neutral-600">
        Every order, any status, any day — for the receipt a live queue search can no longer find.
      </p>

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
        <button
          type="submit"
          className="mt-6 min-h-12 rounded-lg border border-neutral-400 px-6 font-semibold"
        >
          Find
        </button>
        {query !== '' && (
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
          {query === '' ? 'No orders yet.' : `Nothing matches "${query}".`}
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
