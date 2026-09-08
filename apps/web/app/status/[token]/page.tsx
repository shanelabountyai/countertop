// The customer's order status page (C-014 — P0-5, P0-7, P0-8).
//
// Reached only by the unguessable token printed on the confirmation. The
// order NUMBER is deliberately not the key: #047 is guessable, and a page
// keyed on it would hand out today's orders to anyone who could count. The
// internal UUID never appears here either (P0-8) — the token is the one
// handle on an order from outside the building.
//
// Everything rendered below comes from the ORDER'S OWN SNAPSHOT. No menu
// table is touched, which is what makes a rename, a reprice or an 86 after
// placement provably invisible on this page (CLAUDE.md, the snapshot rule).
//
// The status itself is derived from the row on every render, and `LiveUpdates`
// re-renders on the server's cursor — so "Ready for pickup" appears without
// anyone reloading, and polling STOPS at a terminal state (P0-5) because
// `isTerminal` says there is no more news.
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  elapsedMinutes,
  formatOrderNumber,
  isOpen,
  isPastQuote,
  isTerminal,
  orderBalance,
  releasedWithoutCapture,
  paymentTotals,
  refundNeedsAttention,
  remainingEstimate,
  type CancelReason,
  type OrderStatus,
} from '@countertop/core';
import { findOrderByStatusToken } from '@countertop/db/placement';
import { queueCursor } from '@countertop/db/queue';
import { currentCheckout } from '@/lib/checkout-gate';
import { LiveUpdates } from '@/lib/live-updates';
import { describeSelection } from '@/lib/menu-labels';
import { formatCents } from '@/lib/money';
import { PAYMENT_LABEL } from '@/lib/status-labels';
import { CallLink, RestaurantFooter } from '@/lib/restaurant-footer';
import { loadRestaurantContact } from '@countertop/db/gate';

export const metadata = {
  title: 'Your order — Firebird Kitchen',
  // A link that is secret because it is unguessable stops being secret the
  // moment a crawler files it. Deferred hardening (expiry, revocation) is
  // P1-5; not being indexed costs one line and is not deferrable.
  robots: { index: false, follow: false },
};

// Never prerendered: a status baked at build time is the one thing this page
// must never show.
export const dynamic = 'force-dynamic';

/** A `Record<OrderStatus, …>`: a new state cannot ship without the sentence a
 *  customer reads when their order is in it. Same discipline as the kitchen's
 *  section headings — the compiler finds this file, not a grep.
 *
 *  `call` is PRD 5 P0-1's second bullet, expressed as a property of the state
 *  rather than as a second `status === …` literal beside the one below: the
 *  two views whose answer is "phone the counter" are the two that declare a
 *  sentence here, and a new state has to say which it is. Null everywhere the
 *  customer has nothing to ask — an order that is cooking does not need a
 *  phone number in front of it, and one offered on every screen is one nobody
 *  reads on the screen that meant it. */
const STATUS_VIEW: Record<
  OrderStatus,
  { headline: string; detail: string; tone: string; call: string | null }
> = {
  placed: {
    headline: 'Order received',
    detail: 'The kitchen has it and will start it shortly.',
    tone: 'border-sky-700 bg-sky-50 text-sky-900',
    call: null,
  },
  accepted: {
    headline: 'The kitchen has your order',
    detail: "It's in the queue and coming up.",
    tone: 'border-sky-700 bg-sky-50 text-sky-900',
    call: null,
  },
  preparing: {
    headline: 'Cooking now',
    detail: 'Your food is on the line.',
    tone: 'border-sky-700 bg-sky-50 text-sky-900',
    call: null,
  },
  ready: {
    headline: 'Ready for pickup',
    detail: 'Come to the counter and give your name.',
    tone: 'border-green-700 bg-green-50 text-green-900',
    call: null,
  },
  picked_up: {
    headline: 'Picked up',
    detail: 'Enjoy it — thanks for ordering.',
    tone: 'border-neutral-400 bg-neutral-50 text-neutral-800',
    call: null,
  },
  cancelled: {
    // The reason is rendered separately, below: it comes off the order, and a
    // cancellation with no explanation is the version customers phone about.
    headline: 'This order was cancelled',
    detail: 'Nothing was charged.',
    tone: 'border-red-600 bg-red-50 text-red-900',
    call: 'Still need lunch, or want to know what happened? Call us:',
  },
  abandoned: {
    headline: 'This order was not collected',
    // "Call the restaurant" used to end this sentence and there was no number
    // anywhere on the page to call. The instruction moved to `call`, which
    // renders the number next to it.
    detail: 'It was made and left on the shelf.',
    tone: 'border-amber-600 bg-amber-50 text-amber-900',
    call: 'If that is wrong, call us:',
  },
};

/** The staff pick a reason from a short list (P0-4); this is the same reason
 *  said to the person waiting for the food. Two audiences, two wordings —
 *  "Out of an item" is a kitchen note, not an apology. */
const CANCEL_EXPLANATION: Record<CancelReason, string> = {
  out_of_item: 'The kitchen ran out of something in this order.',
  too_busy: 'The kitchen was too backed up to make it in time.',
  // C-057's two. Said in the second person where the customer was the one who
  // acted, and admitted plainly where the shop was — "kitchen error" is the
  // staff's word for a row on a report, not something to tell the person who
  // is not getting their food.
  customer_changed_mind: 'This order was cancelled at your request.',
  kitchen_error: 'Something went wrong in the kitchen with this order.',
  other: 'The restaurant cancelled this order.',
};

export default async function StatusPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // One clock read, at the edge, and it is the SERVER's: every minute on this
  // page is measured against it (CLAUDE.md time rules).
  const now = new Date();
  // Cursor before the order, for the same reason the kitchen does it: an event
  // landing between the two reads costs one spurious refresh rather than a
  // missed one.
  const cursor = await queueCursor();
  const order = await findOrderByStatusToken(token);
  // A bad token and a deleted order are the same answer, deliberately: a 404
  // that distinguished them would confirm which numbers exist.
  if (!order) notFound();

  const view = STATUS_VIEW[order.status];
  // The same two figures the staff receipt shows, off the same events — the
  // customer's copy is a different WORDING of one fact, never a second
  // calculation of it (C-065).
  const { adjustedCents } = paymentTotals(order.events);
  const balance = orderBalance(order);
  // The customer's half of PRD 3 P0-4. A refund that was asked for and has not
  // landed is neither "Paid" nor "Refunded", and both of those are lies in a
  // different direction — the first tells somebody watching for their money
  // that nothing is coming, the second tells them it has already arrived.
  //
  // Asked of the EVENTS since C-071, where it used to be asked of a single
  // order-level state. The order can now have several refunds over its life,
  // and one of them having landed says nothing about whether another is still
  // owed — which is exactly the sentence this line is written to get right.
  const refundPending = refundNeedsAttention(order.events);
  // The gate is NOT asked here (decided C-013): an order already cooking still
  // has a ready time after the restaurant stops taking new ones. The estimate
  // is recalculated on every render, and this page re-renders on every poll
  // (P0-7).
  const { estimate } = await currentCheckout();
  // The phone, for the two views whose copy asks the customer to use it. A
  // separate read from the footer's own, which is a query rather than a prop
  // threaded down so that a page can never render the footer and forget it.
  const { phone } = await loadRestaurantContact(now);
  const waited = elapsedMinutes(order.placedAt, now);
  const remaining = remainingEstimate(estimate, waited);
  // PRD 5 P0-2. Asked of the range SNAPSHOTTED on this order, so the page
  // grades itself against what this customer was actually told at checkout —
  // not against what the checkout would quote somebody walking in now, which
  // is what `estimate` above is and which would score full marks whenever the
  // queue had since emptied.
  const late = isPastQuote(order.quotedHighMinutes, waited);

  return (
    <>
      <main className="mx-auto max-w-2xl p-6">
        <LiveUpdates cursor={cursor} active={!isTerminal(order.status)} />

        <h1 className="text-3xl font-semibold">Your order</h1>
        <p className="mt-4 text-5xl font-bold tabular-nums" data-testid="status-order-number">
          {formatOrderNumber(order.seq)}
        </p>
        <p className="text-xl">under {order.customerName}</p>

        {/* `role="status"` so the headline changing under a poll is announced,
            not silently repainted — this page updates without a navigation. */}
        <section
          role="status"
          data-testid="order-status"
          data-status={order.status}
          className={`mt-6 rounded-lg border-2 p-4 ${view.tone}`}
        >
          <p className="text-2xl font-semibold">{view.headline}</p>
          <p className="mt-1 text-lg">{view.detail}</p>

          {order.status === 'cancelled' && (
            <p className="mt-2 text-lg" data-testid="cancel-reason">
              {order.cancelReason
                ? CANCEL_EXPLANATION[order.cancelReason]
                : CANCEL_EXPLANATION.other}
              {order.cancelNote && ` — ${order.cancelNote}`}
            </p>
          )}

          {/* Inside the coloured panel, not down in the footer: this is the
              screen where the answer IS a phone call, and a number six
              scroll-lengths below the apology is a number nobody finds. Absent
              entirely if the restaurant has not saved one — an invitation to
              call with nothing to call is worse than the apology alone. */}
          {view.call && phone && (
            <p className="mt-3 text-lg">
              {view.call} <CallLink phone={phone} className="text-lg" />
            </p>
          )}
        </section>

        {/* Only while the kitchen still owes work — `isOpen` is exactly
            placed/accepted/preparing, asked of the status module rather than
            spelled out here. Food already on the shelf does not get a time
            estimate; it gets "come and get it". */}
        {isOpen(order.status) && (
          <p
            className={`mt-6 text-lg ${late ? 'font-bold text-red-700' : ''}`}
            data-testid="status-estimate"
          >
            {/* Late is asked FIRST, and that ordering is the requirement rather
                than a preference: "any minute now" past the promised high end
                is the page saying something it can already see is false, forty
                times, five seconds apart, while the kitchen screen has been
                shouting "running late" in red the whole time. Structurally
                unreachable now — the two branches below cannot be entered once
                this one is true.

                `remaining` can still be a live range here (a queue that got
                busier since placement quotes longer than this order was), which
                is exactly the case that used to read "usually ready in about
                10–20 min" to somebody five minutes past their promise.

                The same red the queue card flags with, deliberately: one
                condition, one colour, so the customer's page and the expo's
                screen are visibly saying the same thing about the same order. */}
            {late ? (
              <>Running a bit behind — the kitchen still has your order.</>
            ) : remaining ? (
              <>
                Usually ready in about <strong>{remaining.label}</strong>.
              </>
            ) : (
              <>Should be ready any minute now.</>
            )}
          </p>
        )}

        <section className="mt-6 rounded-lg border border-neutral-300 p-4">
          <h2 className="font-semibold">What you ordered</h2>
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
                          {/* A removal must read as a removal here too: this is
                              the screen a customer checks us against. */}
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

          {/* Subtotal, tax and total as distinct lines (P0-9), read straight off
              the snapshot — never recomputed from a menu that has since moved. */}
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
              <dd data-testid="status-total">{formatCents(order.totalCents)}</dd>
            </div>

            {/* An adjusted order says so (PRD 3 P0-3). Showing the original
                total and nothing else would be the product quietly presenting a
                figure the counter has already decided not to charge — the
                customer arrives expecting one number and hears another.

                WHAT IS NOT HERE IS THE POINT: no reason, no note, no staff name.
                The preset is an operational category and the note is something a
                cook typed about a mistake, and neither is the customer's to
                read. This renders one number, off the same events the staff
                receipt sums. */}
            {adjustedCents > 0 && (
              <>
                <div className="flex justify-between border-t border-neutral-300 pt-2 text-sm">
                  <dt>Adjusted by the restaurant</dt>
                  <dd data-testid="status-adjusted">−{formatCents(adjustedCents)}</dd>
                </div>
                <div className="flex justify-between text-lg font-semibold">
                  <dt>You owe</dt>
                  <dd data-testid="status-outstanding">{formatCents(balance.outstandingCents)}</dd>
                </div>
              </>
            )}
          </dl>

          {/* P1-8. The customer's half of the same fact the kitchen card flags:
              an unpaid order means bring a card to the counter. `refunded` is
              here too — a cancelled order that took money has to say so.

              The DUE figure is the balance, not the total (C-065): telling
              somebody to bring $34.20 for an order that has been comped to zero
              is the same defect as not mentioning the comp at all. */}
          <p className="mt-3 font-semibold" data-testid="status-payment">
            {refundPending
              ? // NOT the reason, and not "we tried and the card was refused".
                // Whether a processor said no is the restaurant's problem to fix
                // and the customer's only question is whether the money is
                // coming. Checked FIRST, so the failed attempt can never render
                // as "Refunded" (P0-4) — the column still says `paid`, which is
                // true and is exactly what would otherwise be shown.
                `Refund pending — ${formatCents(balance.collectedCents)} coming back`
              : releasedWithoutCapture(order.events)
                ? // A held card that was let go (C-069): the no-show and the
                  // cancelled prepaid ticket. Checked BEFORE the enum, because a
                  // released hold leaves `paymentState` at `unpaid` with the whole
                  // total outstanding — both true, and together they read as "Pay
                  // at pickup — $11.85 due" to somebody who paid twenty minutes
                  // ago. That is the sentence that makes them phone.
                  'Card hold released — you were not charged'
                : order.paymentState === 'unpaid'
                  ? balance.outstandingCents > 0
                    ? `${PAYMENT_LABEL.unpaid} — ${formatCents(balance.outstandingCents)} due`
                    : 'Nothing to pay'
                  : PAYMENT_LABEL[order.paymentState]}
          </p>

          {order.orderNote && (
            <p className="mt-3 text-sm text-neutral-700">Your note: {order.orderNote}</p>
          )}
        </section>

        <Link href="/menu" className="mt-6 inline-block underline underline-offset-4">
          Order something else
        </Link>
      </main>
      <RestaurantFooter />
    </>
  );
}
