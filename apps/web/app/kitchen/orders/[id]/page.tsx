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
import {
  ADJUSTMENT_REASONS,
  FORGOTTEN_CUSTOMER_NAME,
  adjustableRemainingCents,
  canCollectPayment,
  formatOrderNumber,
  hasReward,
  LOYALTY_REWARD_REASON,
  orderBalance,
  paymentTotals,
  MAX_CANCEL_NOTE_LENGTH,
  planRedemption,
  pointsToNextReward,
  pendingRefunds,
  previousStatus,
  REVERT_REASONS,
  UNDOABLE_EXIT_STATUSES,
} from '@countertop/core';
import { loadGateState } from '@countertop/db/gate';
import { findOrderByIdForStaff, loadOrderActivity, loadRemakesOf } from '@countertop/db/history';
import { memberByPhone } from '@countertop/db/loyalty';
import { formatCents } from '@/lib/money';
import { formatPlacedAt } from '@/lib/format-time';
import { describeSelection } from '@/lib/menu-labels';
import {
  ADJUSTMENT_REASON_LABEL,
  describeActor,
  describeEvent,
  describeEventReason,
  PAYMENT_LABEL,
  REVERT_REASON_LABEL,
  STATUS_LABEL,
} from '@/lib/status-labels';
import {
  addOrderNoteForm,
  adjustOrderForm,
  refundOrderForm,
  collectPayment,
  forgetCustomerForm,
  redeemRewardForm,
  retryRefundForm,
  remakeOrderForm,
  revertOrderForm,
} from '../../actions';

export const dynamic = 'force-dynamic';

export default async function OrderHistoryDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    adjustError?: string;
    reversalError?: string;
    redeemError?: string;
    revertError?: string;
    refundError?: string;
    noteError?: string;
    forget?: string;
  }>;
}) {
  const { id } = await params;
  const { adjustError, reversalError, redeemError, revertError, refundError, noteError, forget } =
    await searchParams;
  const [gateState, order, activity, remakes] = await Promise.all([
    loadGateState(new Date()),
    findOrderByIdForStaff(id),
    loadOrderActivity(id),
    loadRemakesOf(id),
  ]);
  if (!order) notFound();

  // The counter panel (PRD 7 P0-3's reader, C-103). SEQUENTIAL rather than in
  // the Promise.all above, because the lookup's input is the order's own
  // phone — and it is skipped entirely with the program off, which is what
  // keeps "no loyalty copy renders anywhere" true on this screen too.
  // `memberByPhone` hashes what it is given, so the plaintext still never
  // reaches a `where`.
  const member =
    gateState.loyalty.offered && order.customerPhone
      ? await memberByPhone(order.customerPhone)
      : null;

  // Where a revert would put this order, or null where the receipt offers no
  // such control (PRD 2 P0-4). Two questions, both derived: has the order left
  // the queue with somewhere to go back to, and where is that. Neither names a
  // status, so a new terminal state joins or stays out by its own facts.
  const revertTo = UNDOABLE_EXIT_STATUSES.includes(order.status)
    ? previousStatus(order.status)
    : null;

  // Both read from the SAME events the balance is summed from, so the figure
  // the form bounds itself by and the figure the server enforces cannot drift.
  const { adjustedCents } = paymentTotals(order.events);
  const remainingCents = adjustableRemainingCents(order);
  const balance = orderBalance(order);

  // Every refund asked for and not sent (PRD 3 P0-4, C-067; per-request since
  // C-071). Derived from the SAME events the balance is summed from, so the
  // panels below and the exceptions list on the history page cannot disagree
  // about which orders still owe money — `pendingRefunds` is the one function
  // both ask, and the exceptions QUERY asks the same question of the same two
  // columns.
  const pending = pendingRefunds(order.events);

  // Whether the reward can be spent, asked of the SAME function the write
  // asks (C-104) — so a button that renders is a button that works, and a
  // refusal the screen shows is the refusal the server would have given.
  //
  // `alreadyRedeemed` is read off the MONEY side, from the activity already
  // loaded, rather than costing a second query for the ledger side. The two
  // rows are written in one transaction and cannot disagree; the ledger's own
  // partial unique index is still what makes that true under two taps.
  const rewardUsed = activity.some(
    (entry) => entry.kind === 'adjustment' && entry.reason === LOYALTY_REWARD_REASON,
  );
  const redemption = member
    ? planRedemption({
        enabled: gateState.loyalty.offered,
        balance: member.balance,
        outstandingCents: balance.outstandingCents,
        alreadyRedeemed: rewardUsed,
        terms: gateState.loyalty.terms,
      })
    : null;

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

      {/* The link, both ways (C-066). It is stored once — on the remake's own
          event, naming the original — and read from each end here. Loud,
          because a remake ticket that looks like an ordinary order is one the
          line charges for. */}
      {remakes.length > 0 && (
        <p className="mt-3 rounded-lg border-2 border-neutral-900 p-3 font-semibold" data-testid="remade-as">
          Remade as{' '}
          {remakes.map((remake, index) => (
            <span key={remake.id}>
              {index > 0 && ', '}
              <Link href={`/kitchen/orders/${remake.id}`} className="underline underline-offset-4">
                {formatOrderNumber(remake.seq)}
              </Link>
            </span>
          ))}
        </p>
      )}

      {/* The last four and the name together are what a person confirms out
          loud — "the one ending 2233, Ivy" — because the counter is holding a
          phone number it cannot see. Read-only until C-104; the control below
          is that item, and it asks `planRedemption` rather than re-deciding
          from the balance what a reward is. */}
      {member && (
        <section
          className="mt-4 rounded-lg border border-neutral-300 p-4"
          data-testid="member-panel"
        >
          <h2 className="font-semibold">Punch card</h2>
          <p className="mt-1">
            {member.displayName}{' '}
            <span className="text-neutral-600">· ending {member.phoneLast4}</span>
          </p>
          <p className="mt-2 text-2xl font-semibold tabular-nums" data-testid="member-balance">
            {member.balance} {member.balance === 1 ? 'point' : 'points'}
          </p>
          {hasReward(member.balance, gateState.loyalty.terms) ? (
            <p className="mt-1 font-semibold" data-testid="member-reward">
              Reward available — {formatCents(gateState.loyalty.terms.rewardValueCents)} off
            </p>
          ) : (
            <p className="mt-1 text-sm text-neutral-700" data-testid="member-reward">
              {pointsToNextReward(member.balance, gateState.loyalty.terms)} points to the next
              reward
            </p>
          )}

          {redeemError && (
            <p
              role="status"
              data-testid="redeem-error"
              className="mt-3 rounded-lg border border-red-700 bg-red-50 p-3 text-sm font-semibold text-red-900"
            >
              {redeemError}
            </p>
          )}

          {/* AFTER TAX, off what is still owed — which is why the copy says
              "off the total" and never "a free burrito" (P0-4). The honest
              before-tax version needs a snapshotted discount column and the
              tax base to move with it, and that is P1-1, gated on SMS.

              Its own form, like the remake's: this receipt already has two
              forms whose first submit button is not this one, and a form's
              implicit submission would otherwise make Enter in the adjustment
              note spend a customer's points. */}
          {redemption?.ok && (
            <form action={redeemRewardForm} className="mt-3">
              <input type="hidden" name="orderId" value={order.id} />
              <button
                type="submit"
                data-testid="redeem-reward"
                className="min-h-12 w-full rounded-lg border-2 border-neutral-900 bg-neutral-900 px-4 text-lg font-bold text-white"
              >
                Use reward — {formatCents(redemption.amountCents)} off the total
              </button>
            </form>
          )}
          {/* The refusal, in words, exactly where the button would have been.
              "Reward available" with nothing beside it is the screen a counter
              argues with — an order that owes less than the reward is worth is
              the case that actually happens, and it is REFUSED rather than
              clamped, so the customer keeps the points for a bigger order. */}
          {redemption && !redemption.ok && redemption.reason !== 'not_enough_points' && (
            <p className="mt-3 text-sm font-semibold" data-testid="redeem-note">
              {redemption.message}
            </p>
          )}
        </section>
      )}

      {/* Move it back (PRD 2 P0-4). The five-second undo on the queue card is
          reachable for five seconds; this is the same transition reached at
          any time, from the one screen that still knows a closed order exists.
          The operator's finding was an order tapped picked-up by mistake at
          19:48 and discovered at 20:05, with nothing on any screen able to
          move it.

          WHICH STATUSES OFFER IT IS `UNDOABLE_EXIT_STATUSES`, not a pair of
          literals: "left the queue, and has somewhere to go back to" is
          already a derived list, and `cancelled` is excluded by having no
          previous rather than by being named here. The engine is asked again
          on the write, so this is which control to draw and never whether the
          move is allowed. */}
      {revertTo && (
        <section className="mt-6 rounded-lg border border-neutral-300 p-4" data-testid="revert-panel">
          <h2 className="font-semibold">Move it back</h2>
          <p className="mt-1 text-sm text-neutral-600">
            Puts this order back on the queue as {STATUS_LABEL[revertTo].toLowerCase()}. The
            original tap stays in the log — nothing is removed.
          </p>

          {revertError && (
            <p
              role="status"
              data-testid="revert-error"
              className="mt-3 rounded-lg border border-red-700 bg-red-50 p-3 text-sm font-semibold text-red-900"
            >
              {revertError}
            </p>
          )}

          <form action={revertOrderForm} className="mt-3 flex flex-col gap-3">
            <input type="hidden" name="orderId" value={order.id} />
            {/* The status this page was DRAWN against (D1). A receipt left
                open in a tab must not move an order out of a state whoever is
                tapping never saw — the engine refuses by `unexpected_target`
                and the re-render shows the truth. */}
            <input type="hidden" name="to" value={revertTo} />

            {/* NOT "Reason". "Make it right" below already owns that word on
                this page, and two selects labelled the same thing is one
                control to a screen reader and to a Playwright locator alike —
                three existing specs found that out. */}
            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">Why it is going back</span>
              <select
                name="reason"
                required
                defaultValue=""
                className="min-h-12 rounded-lg border border-neutral-400 px-3 text-lg"
              >
                <option value="" disabled>
                  Pick one
                </option>
                {REVERT_REASONS.map((reason) => (
                  <option key={reason} value={reason}>
                    {REVERT_REASON_LABEL[reason]}
                  </option>
                ))}
              </select>
            </label>

            {/* Optional, unlike the cancel form's "other" note. A revert is
                undone by a second revert, and a required sentence on the
                control that fixes a fat finger is a control the counter routes
                around at the exact moment it is needed. */}
            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">Anything to add (optional)</span>
              <input
                name="note"
                maxLength={MAX_CANCEL_NOTE_LENGTH}
                className="min-h-12 rounded-lg border border-neutral-400 px-3 text-lg"
              />
            </label>

            <button
              type="submit"
              className="min-h-12 w-full rounded-lg border-2 border-neutral-900 px-4 text-lg font-bold"
            >
              Move back to {STATUS_LABEL[revertTo]}
            </button>
          </form>
        </section>
      )}

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

          {/* BELOW the total, never inside it (C-065). The three lines above
              are the snapshot and are write-once: an adjustment is a second
              fact beside the money, not an edit to it. Rendering it as a
              smaller total would be the exact defect the requirement's
              "never updates subtotalCents/taxCents/totalCents" forbids, done
              in CSS instead of SQL. */}
          {adjustedCents > 0 && (
            <>
              <div className="flex justify-between border-t border-neutral-300 pt-2 text-sm">
                <dt>Adjusted</dt>
                <dd data-testid="history-adjusted">−{formatCents(adjustedCents)}</dd>
              </div>
              <div className="flex justify-between text-lg font-semibold">
                <dt>Still owed</dt>
                <dd data-testid="history-outstanding">{formatCents(balance.outstandingCents)}</dd>
              </div>
            </>
          )}
        </dl>

        {/* The enum's word for what the till did. It stays "Paid" through a
            partial refund, correctly and on purpose — `refunded` means every
            captured cent went back, and the panels above are where the fact it
            cannot hold is said. */}
        <p data-testid="staff-payment-state" className="mt-3 font-semibold">
          {PAYMENT_LABEL[order.paymentState]}
        </p>

        {canCollectPayment(order.status, balance.outstandingCents) && (
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

        {/* Refunds the restaurant owes and has not sent (PRD 3 P0-4).
            `PAYMENT_LABEL` above still says "Paid", correctly and on purpose:
            the money is still in the restaurant's hands, and the requirement is
            that a failed attempt does NOT set the customer-facing "Refunded"
            copy. This is the fact the enum cannot hold, rendered where the
            money is read.

            BOTH unsettled states, from one function: a request whose attempt
            never came back is money owed with nothing chasing it, and it looks
            exactly like nothing having happened.

            ONE PANEL PER REQUEST since C-071, and the retry carries the id it
            was rendered against. `refundRequestEvent` refuses to stack a second
            ask on an unsettled one, so this is a list of at most one today —
            written as a list anyway, because the alternative is a screen that
            renders the first of two and silently drops the money in the
            second. */}
        {pending.map((request) => (
          <div
            key={request.id}
            data-testid="refund-panel"
            className="mt-3 rounded-lg border-2 border-red-700 bg-red-50 p-3"
          >
            {/* WHAT WAS ASKED FOR, not what a min() against the current balance
                says. Trimming the figure to fit would have this panel report a
                smaller debt than the request actually carries, which is the
                clamp `settleRefund` refuses — said in CSS instead of SQL. A
                request whose ask now exceeds the balance is refused at the
                attempt, with a message naming both numbers. */}
            <p className="font-semibold text-red-900">
              Refund owed — {formatCents(request.amountCents ?? balance.collectedCents)} not sent
            </p>
            <p className="mt-1 text-sm text-red-900">
              {request.failed
                ? 'The last attempt was refused. The reason is in the activity log below.'
                : 'Asked for and never confirmed. Send it again — the same key goes to the provider, so this cannot pay twice.'}
            </p>

            {refundError && (
              <p
                role="status"
                data-testid="refund-error"
                className="mt-3 rounded-lg border border-red-700 bg-white p-3 text-sm font-semibold text-red-900"
              >
                {refundError}
              </p>
            )}

            {/* Its own form, like the remake's and the redemption's: this page
                already has forms whose first submit button is not this one, and
                a form's implicit submission would make Enter in the adjustment
                note send a customer's money back. */}
            <form action={retryRefundForm} className="mt-3">
              <input type="hidden" name="orderId" value={order.id} />
              <input type="hidden" name="requestId" value={request.id} />
              <button
                type="submit"
                data-testid="retry-refund"
                className="min-h-12 w-full rounded-lg border-2 border-red-700 bg-red-700 px-4 text-lg font-bold text-white"
              >
                Send the refund again
              </button>
            </form>
          </div>
        ))}
      </section>

      {/* Making it right (PRD 3 P0-3). Reachable in EVERY state, which is the
          requirement's point: `picked_up` and `abandoned` are exactly where a
          wrong order is discovered, and they are the two the product had no
          money control for at all. The state machine goes on refusing to
          cancel cooked food (P0-5) — money is decoupled from status, so that
          refusal stops being a dead end. */}
      {remainingCents > 0 && (
        <section className="mt-6 rounded-lg border border-neutral-300 p-4">
          <h2 className="font-semibold">Make it right</h2>
          <p className="mt-1 text-sm text-neutral-600">
            Records a decision. It does not move money or change the total — up to{' '}
            {formatCents(remainingCents)} on this order.
          </p>

          {adjustError && (
            <p
              role="status"
              data-testid="adjust-error"
              className="mt-3 rounded-lg border border-red-700 bg-red-50 p-3 text-sm font-semibold text-red-900"
            >
              {adjustError}
            </p>
          )}

          <form action={adjustOrderForm} className="mt-3 flex flex-col gap-3">
            <input type="hidden" name="orderId" value={order.id} />

            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">Reason</span>
              <select
                name="reason"
                required
                defaultValue=""
                className="min-h-12 rounded-lg border border-neutral-400 px-3 text-lg"
              >
                <option value="" disabled>
                  Pick one
                </option>
                {ADJUSTMENT_REASONS.map((reason) => (
                  <option key={reason} value={reason}>
                    {ADJUSTMENT_REASON_LABEL[reason]}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">Note</span>
              <input
                type="text"
                name="note"
                maxLength={140}
                placeholder="Required for “Other”"
                className="min-h-12 rounded-lg border border-neutral-400 px-3 text-lg"
              />
            </label>

            {/* Two submits, one form, and the KIND is the button rather than a
                radio: "comp the whole thing" and "take $3 off" are two
                decisions, not one decision with a parameter. The comp carries
                no amount at all — the engine derives it from the order, so
                there is no field here for anybody to disagree with. */}
            <div className="flex flex-col gap-2 sm:flex-row">
              <button
                type="submit"
                name="kind"
                value="comp"
                className="min-h-12 flex-1 rounded-lg border-2 border-neutral-900 bg-neutral-900 px-4 text-lg font-bold text-white"
              >
                Comp the whole order
              </button>
              <div className="flex flex-1 gap-2">
                <label className="flex-1">
                  <span className="sr-only">Amount to take off, in dollars</span>
                  <input
                    type="text"
                    name="amount"
                    inputMode="decimal"
                    placeholder="3.50"
                    className="min-h-12 w-full rounded-lg border border-neutral-400 px-3 text-lg tabular-nums"
                  />
                </label>
                <button
                  type="submit"
                  name="kind"
                  value="partial"
                  className="min-h-12 rounded-lg border-2 border-neutral-900 px-4 text-lg font-bold"
                >
                  Take off
                </button>
              </div>
            </div>
          </form>
        </section>
      )}

      {/* Take a comp back (PRD 3 P0-6, C-071).

          A CONTRADICTING ROW, never a delete — the log is append-only and the
          trigger means that is not a preference. C-065 and C-066 both deferred
          this and both gave the same reason: a comp is a decision, and a
          decision that vanishes is one nobody can be asked about at close. So
          both rows stay, side by side, and the balance is the net.

          Its own section rather than a fourth button in the form above,
          because it appears under the OPPOSITE condition: Make it right needs
          something left to adjust, and this needs something already adjusted.
          On a fully comped order the first is gone and this is the only money
          control on the screen. */}
      {adjustedCents > 0 && (
        <section className="mt-6 rounded-lg border border-neutral-300 p-4">
          <h2 className="font-semibold">Put an adjustment back</h2>
          <p className="mt-1 text-sm text-neutral-600">
            Comped the wrong ticket? This writes the correction beside it — the
            original stays in the log. Up to {formatCents(adjustedCents)} was
            taken off this order.
          </p>

          {reversalError && (
            <p
              role="status"
              data-testid="reversal-error"
              className="mt-3 rounded-lg border border-red-700 bg-red-50 p-3 text-sm font-semibold text-red-900"
            >
              {reversalError}
            </p>
          )}

          <form action={adjustOrderForm} className="mt-3 flex flex-col gap-3">
            <input type="hidden" name="orderId" value={order.id} />
            {/* No reason dropdown: there is one reason to take a comp back, the
                action writes it, and the note is where it is explained. The
                note is REQUIRED — money going back onto a customer's bill is
                the one adjustment nobody should be able to make silently. */}
            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">What was wrong with the original</span>
              <input
                type="text"
                name="note"
                required
                maxLength={140}
                data-testid="reversal-note"
                placeholder="Comped #014 by mistake"
                className="min-h-12 rounded-lg border border-neutral-400 px-3 text-lg"
              />
            </label>

            <div className="flex gap-2">
              <label className="flex-1">
                <span className="sr-only">Amount to put back, in dollars</span>
                <input
                  type="text"
                  name="amount"
                  inputMode="decimal"
                  required
                  data-testid="reversal-amount"
                  placeholder="3.50"
                  className="min-h-12 w-full rounded-lg border border-neutral-400 px-3 text-lg tabular-nums"
                />
              </label>
              <button
                type="submit"
                name="kind"
                value="reversal"
                data-testid="reverse-adjustment"
                className="min-h-12 rounded-lg border-2 border-neutral-900 px-4 text-lg font-bold"
              >
                Put it back
              </button>
            </div>
          </form>
        </section>
      )}

      {/* Send the money back (PRD 3 P0-6, C-071).

          BELOW the two adjustment controls, and the order is deliberate: a
          comp records a decision and moves nothing, and this one actually
          sends a customer's money. The cheap, reversible thing reads first
          on a screen somebody is scanning at the pass.

          THE HALF THE MONEY STORY WAS MISSING. Until this section the only
          thing that could ask for a refund was cancelling, and the state
          machine correctly refuses to cancel cooked food — so a comp on an
          order that had already paid showed a zero balance, which is a true
          sentence about what the customer OWES and the wrong one about what
          the restaurant is HOLDING.

          Offered on what is actually held, not on the status: this is
          reachable on a `picked_up` order and on an `abandoned` one, which are
          precisely the two the product had no way to refund at all.

          Hidden while something is already pending, because that is the state
          the engine refuses in — a control that renders and always refuses is
          worse than no control, and the panel above already carries the tap
          that moves it forward. */}
      {balance.collectedCents > 0 && pending.length === 0 && (
        <section className="mt-6 rounded-lg border border-neutral-300 p-4">
          <h2 className="font-semibold">Send money back</h2>
          <p className="mt-1 text-sm text-neutral-600">
            Actually moves money — up to {formatCents(balance.collectedCents)} is
            being held on this order. Not the same as making it right below,
            which records a decision and moves nothing.
          </p>

          {/* The offer C-068 deliberately did not build (PRD 3 P0-5). A no-show
              is NOT automatically a refund — the food was made, and a product
              that quietly refunds it decides a thing the owner has to decide —
              so it is an offer, and until this item there was no control to
              offer. */}
          {order.status === 'abandoned' && (
            <p
              data-testid="abandoned-refund-offer"
              className="mt-2 rounded-lg border border-amber-700 bg-amber-50 p-3 text-sm text-amber-900"
            >
              Nobody collected this one and the food was made. A refund here is
              a decision, not the automatic consequence — send back what the
              shop decides to.
            </p>
          )}

          {refundError && pending.length === 0 && (
            <p
              role="status"
              data-testid="refund-error"
              className="mt-3 rounded-lg border border-red-700 bg-red-50 p-3 text-sm font-semibold text-red-900"
            >
              {refundError}
            </p>
          )}

          {/* Its own form, like every other money control on this page: a
              form's implicit submission fires its first submit button, and
              sharing one would make Enter in a note send a customer's money. */}
          <form action={refundOrderForm} className="mt-3 flex flex-col gap-3">
            <input type="hidden" name="orderId" value={order.id} />

            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">Reason</span>
              <select
                name="reason"
                required
                defaultValue=""
                className="min-h-12 rounded-lg border border-neutral-400 px-3 text-lg"
              >
                <option value="" disabled>
                  Pick one
                </option>
                {ADJUSTMENT_REASONS.map((reason) => (
                  <option key={reason} value={reason}>
                    {ADJUSTMENT_REASON_LABEL[reason]}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">Note</span>
              <input
                type="text"
                name="note"
                maxLength={140}
                placeholder="Required for &ldquo;Other&rdquo;"
                className="min-h-12 rounded-lg border border-neutral-400 px-3 text-lg"
              />
            </label>

            <div className="flex gap-2">
              <label className="flex-1">
                <span className="sr-only">Amount to send back, in dollars</span>
                <input
                  type="text"
                  name="amount"
                  inputMode="decimal"
                  required
                  data-testid="refund-amount"
                  placeholder="3.50"
                  className="min-h-12 w-full rounded-lg border border-neutral-400 px-3 text-lg tabular-nums"
                />
              </label>
              {/* NO "send it all" button beside this, unlike the comp's. A comp
                  has a whole-order reading the server can derive; a refund does
                  not — how much of what is held goes back is the decision, and
                  a one-tap full refund is the tap somebody makes by accident on
                  a screen they are reading at arm's length with greasy gloves. */}
              <button
                type="submit"
                data-testid="send-refund"
                className="min-h-12 rounded-lg border-2 border-red-700 bg-red-700 px-4 text-lg font-bold text-white"
              >
                Send it back
              </button>
            </div>
          </form>
        </section>
      )}

      {/* Its own section and its own FORM (C-066), for two reasons that both
          bite. A remake creates a whole new order, so it must stay reachable
          on an order that has already been comped — which is the PRD's own
          scenario: Ivy gets her money back AND a new torta, and the adjust
          section above disappears once there is nothing left to adjust. And a
          form's implicit submission fires its first submit button, so sharing
          one form would make Enter in the note field mint a kitchen ticket. */}
      <section className="mt-6 rounded-lg border border-neutral-300 p-4">
        <h2 className="font-semibold">Remake it</h2>
        <p className="mt-1 text-sm text-neutral-600">
          Puts a new ticket on the line — same food, its own number, nothing
          charged. The note below goes on that ticket, above the customer&rsquo;s own.
          The original keeps its money exactly as it is.
        </p>

        <form action={remakeOrderForm} className="mt-3 flex flex-col gap-3">
          <input type="hidden" name="orderId" value={order.id} />
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium">What went wrong</span>
            <select
              name="reason"
              required
              defaultValue=""
              className="min-h-12 rounded-lg border border-neutral-400 px-3 text-lg"
            >
              <option value="" disabled>
                Pick one
              </option>
              {ADJUSTMENT_REASONS.map((reason) => (
                <option key={reason} value={reason}>
                  {ADJUSTMENT_REASON_LABEL[reason]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium">Note for the line</span>
            <input
              type="text"
              name="note"
              maxLength={140}
              placeholder="Onions off. Cut in half."
              className="min-h-12 rounded-lg border border-neutral-400 px-3 text-lg"
            />
          </label>
          <button
            type="submit"
            className="min-h-12 rounded-lg border-2 border-neutral-900 bg-neutral-900 px-4 text-lg font-bold text-white"
          >
            Remake it
          </button>
        </form>
      </section>

      {order.orderNote && (
        <p className="mt-4 text-sm italic text-neutral-700">“{order.orderNote}”</p>
      )}

      {/* Somebody can write on the ticket (PRD 2 P0-6).

          On the receipt as well as the card because this is the screen that
          still knows about an order the queue has finished with — the same
          reason the revert lives here. No state guard and no panel of its own:
          it sits above the log it writes into, so the note that was just added
          appears directly below the box that added it.

          A form and a redirect rather than the card's transition, because this
          page is server-rendered throughout and one client component for one
          text box would be a second write path to keep in step. */}
      <section className="mt-6 rounded-lg border border-neutral-300 p-4">
        <h2 className="font-semibold">Write on the ticket</h2>
        <p className="mt-1 text-sm text-neutral-600">
          Goes in the log below with the time, and on the card in the kitchen. The customer never
          sees it.
        </p>

        {noteError && (
          <p
            role="status"
            data-testid="note-error"
            className="mt-3 rounded-lg border border-red-700 bg-red-50 p-3 text-sm font-semibold text-red-900"
          >
            {noteError}
          </p>
        )}

        <form action={addOrderNoteForm} className="mt-3 flex flex-col gap-3">
          <input type="hidden" name="orderId" value={order.id} />
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium">Note for the shift</span>
            <input
              name="note"
              maxLength={MAX_CANCEL_NOTE_LENGTH}
              placeholder="customer called, arriving 7:40"
              className="min-h-12 rounded-lg border border-neutral-400 px-3 text-lg"
            />
          </label>
          <button
            type="submit"
            className="min-h-12 w-full rounded-lg border-2 border-neutral-900 px-4 text-lg font-bold"
          >
            Add note
          </button>
        </form>
      </section>

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
              {entry.relatedOrder && (
                <Link
                  href={`/kitchen/orders/${entry.relatedOrder.id}`}
                  className="text-lg font-semibold underline underline-offset-4"
                >
                  {formatOrderNumber(entry.relatedOrder.seq)}
                </Link>
              )}
              {entry.amountCents !== null && (
                <span className="text-lg font-semibold tabular-nums">
                  {formatCents(entry.amountCents)}
                </span>
              )}
              <span className="text-sm text-neutral-700">· {describeActor(entry)}</span>
              {describeEventReason(entry) && (
                <span className="text-sm italic text-neutral-600">
                  “{describeEventReason(entry)}”
                </span>
              )}
              {/* What somebody typed, beside the preset they picked. Written
                  since C-003 for the cancel note and read here for the first
                  time — a note nothing renders is the C-066 mistake. */}
              {entry.note && (
                <span className="w-full text-sm text-neutral-700">{entry.note}</span>
              )}
            </li>
          ))}
        </ol>
      </section>

      {/* "Forget this customer" (PRD 6 P0-4, C-091). LAST on the page and
          behind a confirm, because it is the only irreversible control in this
          product: nothing else here destroys anything, and the receipt is read
          at arm's length with greasy gloves.

          The confirm is a URL, like the menu editor's price confirm (C-015) —
          it survives a reload, it needs no client JavaScript, and a server
          component cannot call `window.confirm`. */}
      <section className="mt-6 rounded-lg border border-neutral-300 p-4">
        <h2 className="font-semibold">Forget this customer</h2>
        {order.customerName === FORGOTTEN_CUSTOMER_NAME ? (
          <p className="mt-1 text-sm text-neutral-600" data-testid="already-forgotten">
            Already done. The name, phone and notes are gone; the order number,
            the money and the activity below are exactly as they were.
          </p>
        ) : forget === '1' ? (
          <form action={forgetCustomerForm} className="mt-3 flex flex-col gap-3">
            <input type="hidden" name="orderId" value={order.id} />
            <p className="rounded-lg border border-red-700 bg-red-50 p-3 text-sm font-semibold text-red-900">
              This removes {order.customerName}&rsquo;s name, phone number and every note
              on this order. It cannot be undone. {formatOrderNumber(order.seq)}, the
              money and the activity log all stay.
            </p>
            {/* Only when there IS one. The punch card is a second thing this
                button destroys and a balance is worth money to the person
                standing there, so it is named before the tap and not after
                (P0-5, C-105) — but a sentence about a program this restaurant
                may not run would be a warning about nothing. */}
            {member && (
              <p
                className="rounded-lg border border-red-700 bg-red-50 p-3 text-sm font-semibold text-red-900"
                data-testid="forget-member-warning"
              >
                Their punch card goes too: {member.balance}{' '}
                {member.balance === 1 ? 'point' : 'points'} and every order behind it,
                deleted for good.
              </p>
            )}
            <div className="flex flex-col gap-2 sm:flex-row">
              <button
                type="submit"
                data-testid="forget-confirm"
                className="min-h-12 flex-1 rounded-lg border-2 border-red-700 bg-red-700 px-4 text-lg font-bold text-white"
              >
                Forget them
              </button>
              <Link
                href={`/kitchen/orders/${order.id}`}
                className="flex min-h-12 flex-1 items-center justify-center rounded-lg border-2 border-neutral-900 px-4 text-lg font-bold"
              >
                Keep it
              </Link>
            </div>
          </form>
        ) : (
          <>
            <p className="mt-1 text-sm text-neutral-600">
              For the customer who asks. Removes the name, phone number and notes
              from this order and nothing else &mdash; every report reads the same
              afterwards.{' '}
              {/* Conditional for the same reason the warning below is: with the
                  program off, "no loyalty copy renders anywhere" has to stay
                  true on this panel too. */}
              {member && 'Their punch card and its whole history go with it. '}
              Everything older than the retention window goes on its own
              (<code>npm run db:retention</code>, see docs/RETENTION.md).
            </p>
            <Link
              href={`/kitchen/orders/${order.id}?forget=1`}
              data-testid="forget-customer"
              className="mt-3 inline-flex min-h-12 items-center rounded-lg border-2 border-neutral-900 px-4 text-lg font-bold"
            >
              Forget this customer
            </Link>
          </>
        )}
      </section>
    </main>
  );
}
