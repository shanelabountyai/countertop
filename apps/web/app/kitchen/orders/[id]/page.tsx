// One order's full receipt, for staff (P0-8 rendered a second way, for a day
// later). Read-only about the ORDER — no advance button, no undo, nothing that
// moves it through the state machine.
//
// The one write here is collecting money that is still owed (P1-8). It earned
// its place: the collect control otherwise lives only on a queue card, so an
// unpaid order that was handed over became permanently uncollectable the
// moment it left the queue — the till and the system disagreeing with no
// screen able to reconcile them. Whether it renders is the status module's
// answer, not this page's, and the server action asks the same question
// again.
//
// Renders ONLY from the order's own snapshot (CLAUDE.md, the snapshot rule):
// `findOrderByIdForStaff` never joins a menu table, so a receipt from a menu
// that has since been repriced, renamed or 86'd reads exactly as it did the
// day it was placed.
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { canCollectPayment, formatOrderNumber } from '@countertop/core';
import { loadGateState } from '@countertop/db/gate';
import { findOrderByIdForStaff, loadOrderActivity } from '@countertop/db/history';
import { formatCents } from '@/lib/money';
import { formatPlacedAt } from '@/lib/format-time';
import { describeSelection } from '@/lib/menu-labels';
import { describeActor, describeEvent, PAYMENT_LABEL, STATUS_LABEL } from '@/lib/status-labels';
import { collectPayment } from '../../actions';

export const dynamic = 'force-dynamic';

export default async function OrderHistoryDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [gateState, order, activity] = await Promise.all([
    loadGateState(new Date()),
    findOrderByIdForStaff(id),
    loadOrderActivity(id),
  ]);
  if (!order) notFound();

  return (
    <main className="mx-auto max-w-2xl p-6">
      <Link href="/kitchen/orders" className="inline-flex min-h-12 w-fit items-center text-sm underline underline-offset-4">
        ← Order history
      </Link>

      <div className="mt-4 flex items-baseline justify-between gap-4">
        <h1 className="text-3xl font-semibold" data-testid="history-order-number">
          {formatOrderNumber(order.seq)}
        </h1>
        <span className="text-lg font-medium">{STATUS_LABEL[order.status]}</span>
      </div>
      <p className="text-lg">
        {order.customerName}
        {order.customerPhone && <span className="text-neutral-600"> · {order.customerPhone}</span>}
      </p>
      <p className="text-sm text-neutral-600">{formatPlacedAt(order.placedAt, gateState.timezone)}</p>

      <section className="mt-6 rounded-lg border border-neutral-300 p-4">
        <h2 className="font-semibold">What was ordered</h2>
        <ul className="mt-3 flex flex-col gap-3">
          {order.lines.map((line) => (
            <li key={line.id}>
              <div className="flex justify-between gap-4">
                <p className="font-medium">
                  <span className="tabular-nums">{line.quantity}×</span> {line.itemName}
                </p>
                <p className="tabular-nums">{formatCents(line.lineTotalCents)}</p>
              </div>
              {line.options.length > 0 && (
                <p className="text-sm text-neutral-700">
                  {line.options.map((option, index) => {
                    const { text, negated } = describeSelection(option.optionName, option.intensity);
                    return (
                      <span key={option.id}>
                        {index > 0 && ', '}
                        <span className={negated ? 'font-bold text-red-700' : ''}>{text}</span>
                      </span>
                    );
                  })}
                </p>
              )}
              {line.note && <p className="text-sm italic text-neutral-700">{line.note}</p>}
            </li>
          ))}
        </ul>

        <dl className="mt-4 flex flex-col gap-1 border-t border-neutral-300 pt-3 tabular-nums">
          <div className="flex justify-between text-sm">
            <dt>Subtotal</dt>
            <dd>{formatCents(order.subtotalCents)}</dd>
          </div>
          <div className="flex justify-between text-sm">
            <dt>Tax</dt>
            <dd>{formatCents(order.taxCents)}</dd>
          </div>
          <div className="flex justify-between text-lg font-semibold">
            <dt>Total</dt>
            <dd data-testid="history-total">{formatCents(order.totalCents)}</dd>
          </div>
        </dl>

        <p className="mt-3 font-semibold">{PAYMENT_LABEL[order.paymentState]}</p>

        {canCollectPayment(order.status, order.paymentState) && (
          <form action={collectPayment} className="mt-3">
            <input type="hidden" name="orderId" value={order.id} />
            <button
              type="submit"
              className="min-h-12 w-full rounded-lg border-2 border-amber-700 bg-amber-100 px-4 text-lg font-bold text-amber-900"
            >
              Collected — mark paid
            </button>
          </form>
        )}
      </section>

      {order.orderNote && (
        <p className="mt-4 text-sm italic text-neutral-700">“{order.orderNote}”</p>
      )}

      {/* The append-only log, finally read by somebody (C-086). It has been
          written since C-003 and looked at only by the report's tally and by
          tests — so putting a name on every row and rendering it nowhere would
          have shipped the column and not the feature. The disputed order is
          the one this page exists for, and "who moved it, and when" is the
          question a dispute is actually about. */}
      <section className="mt-6 rounded-lg border border-neutral-300 p-4">
        <h2 className="font-semibold">Activity</h2>
        <ol className="mt-3 flex flex-col gap-2" data-testid="order-activity">
          {activity.map((entry, index) => (
            <li
              key={`${entry.at.toISOString()}-${index}`}
              className="flex flex-wrap items-baseline gap-x-2 border-b border-neutral-200 pb-2 last:border-b-0"
            >
              <span className="text-sm tabular-nums text-neutral-600">
                {formatPlacedAt(entry.at, gateState.timezone)}
              </span>
              <span className="text-lg">{describeEvent(entry)}</span>
              <span className="text-sm text-neutral-700">· {describeActor(entry)}</span>
              {entry.reason && (
                <span className="text-sm italic text-neutral-600">“{entry.reason}”</span>
              )}
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
