// The kitchen queue (P0-4, P0-11).
//
// Read at arm's length with greasy gloves: the order number and the item lines
// are large, the advance button is the biggest thing on the card, and nothing
// hides behind a hover or a tap-through. Every card renders from the ORDER'S
// OWN SNAPSHOT — no menu table is touched here, which is what makes a menu
// edit provably invisible to an order already on the grill.
import Link from 'next/link';
import {
  DEFAULT_AGING,
  formatOrderNumber,
  groupQueue,
  checkoutGate,
  matchesLookup,
  needsAcknowledgment,
  restaurantClock,
  queueAging,
  undoRemainingMs,
} from '@countertop/core';
import { loadGateState } from '@countertop/db/gate';
import { loadQueue, queueCursor, type QueueOrder } from '@countertop/db/queue';
import { LiveUpdates } from '@/lib/live-updates';
import { describeSelection } from '@/lib/menu-labels';
import { PAYMENT_LABEL, STATUS_LABEL } from '@/lib/status-labels';
import { formatCents } from '@/lib/money';
import { signOut } from './login/actions';
import { NewOrderAlert } from './new-order-alert';
import { PauseSwitch } from './pause-switch';
import { QueueControls } from './queue-controls';

export const metadata = { title: 'Kitchen — Firebird Kitchen' };

// Never prerendered: a queue baked at build time is a screen showing
// yesterday's orders. `LiveUpdates` re-renders it every time the server's
// cursor moves, so a cook who never touches the screen still sees new tickets
// and elapsed minutes that tick (P0-5).
export const dynamic = 'force-dynamic';

/** Options in the order they were composed, gathered under their group name —
 *  "Salsa: chipotle, NO onions" is how a cook reads a ticket. */
function optionsByGroup(line: QueueOrder['lines'][number]) {
  const groups = new Map<string, typeof line.options>();
  for (const option of line.options) {
    groups.set(option.groupName, [...(groups.get(option.groupName) ?? []), option]);
  }
  return [...groups];
}

export default async function KitchenPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  // Read once, here, and passed down. Every elapsed minute on this screen is
  // measured against the SERVER's instant — the browser's clock is never an
  // input (CLAUDE.md time rules).
  const now = new Date();
  const query = (await searchParams).q ?? '';
  // Cursor BEFORE the queue, deliberately. An event landing between the two
  // reads then makes the cursor OLDER than what was rendered, which costs one
  // spurious refresh; the other order would make it newer, and the change
  // would go unseen until the next one.
  const cursor = await queueCursor();
  const orders = await loadQueue();
  // The SAME gate the customer's checkout asks. Staff see the live answer —
  // including an auto-pause nobody switched on — rather than the switch's
  // own position (P0-6).
  const gateState = await loadGateState();
  const gate = checkoutGate(gateState, restaurantClock(now, gateState.timezone));
  const groups = groupQueue(orders.filter((order) => matchesLookup(order, query)));
  // Counted off the UNFILTERED list, deliberately. A cook who has typed a name
  // into the lookup box is still the person who has to hear the next order
  // arrive — an alert that a search can silence is an alert that will be
  // silenced during exactly the rush it exists for (P0-12).
  const unacknowledged = orders.filter((order) => needsAcknowledgment(order.status)).length;

  return (
    <main className="mx-auto max-w-5xl p-6">
      <LiveUpdates cursor={cursor} />
      <NewOrderAlert count={unacknowledged} />
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h1 className="text-3xl font-semibold">Kitchen queue</h1>
        <div className="flex flex-wrap items-center gap-4">
          <Link href="/kitchen/availability" className="text-sm underline underline-offset-4">
            Availability
          </Link>
          <Link href="/kitchen/menu" className="text-sm underline underline-offset-4">
            Edit menu
          </Link>
          <Link href="/kitchen/settings" className="text-sm underline underline-offset-4">
            Settings
          </Link>
          <Link href="/kitchen/report" className="text-sm underline underline-offset-4">
            Sales
          </Link>
          <Link href="/menu" className="text-sm underline underline-offset-4">
            Customer menu
          </Link>
          {/* The counterpart of the sign-in. A wall-mounted screen never taps
              it; a manager's laptop in the office is why it exists (C-037).
              ≥48px like every other BUTTON on this screen — the neighbours are
              links and are not held to it, but rush.spec asserts the rule
              across every visible button on a full queue, and it is right to:
              "staff rarely tap this one" is how the exceptions start. */}
          <form action={signOut}>
            <button
              type="submit"
              className="min-h-12 px-1 text-sm underline underline-offset-4"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>

      <PauseSwitch gate={gate} paused={gateState.paused} />

      {/* A plain GET form: the walk-up lookup works before hydration, and the
          result is a URL a second screen can be opened on (P0-11). */}
      <form className="mt-4 flex flex-wrap gap-2">
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
            href="/kitchen"
            className="mt-6 flex min-h-12 items-center rounded-lg px-4 underline underline-offset-4"
          >
            Show all
          </Link>
        )}
      </form>

      {groups.map(({ status, orders: inGroup }) => (
        <section key={status} className="mt-8">
          <h2 className="text-xl font-semibold">
            {STATUS_LABEL[status]}{' '}
            <span className="font-normal text-neutral-600">({inGroup.length})</span>
          </h2>

          {inGroup.length === 0 ? (
            <p className="mt-2 text-neutral-600">Nothing here.</p>
          ) : (
            <ul className="mt-3 grid gap-4 md:grid-cols-2">
              {inGroup.map((order) => {
                const aging = queueAging(order, now, DEFAULT_AGING);
                const undoMs = undoRemainingMs(order.status, order.events[0], now);

                return (
                  <li
                    key={order.id}
                    className={`rounded-xl border-2 p-4 ${
                      // Un-acknowledged outranks "running late". Both are
                      // urgent; only one of them names the tap that fixes it,
                      // and a placed order cannot be late in a way that
                      // accepting it does not also address.
                      needsAcknowledgment(order.status)
                        ? 'alert-pulse border-sky-700 bg-sky-50'
                        : aging.noShowLevel >= 2 || aging.overdue
                          ? 'border-red-500 bg-red-50'
                          : 'border-neutral-300'
                    }`}
                  >
                    {/* The badge, not the animation, is what carries this to
                        a cook who has motion turned off. */}
                    {needsAcknowledgment(order.status) && (
                      <p className="mb-2 w-fit rounded bg-sky-700 px-2 py-1 text-lg font-bold uppercase text-white">
                        New — not yet accepted
                      </p>
                    )}
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <h3 className="text-3xl font-bold tabular-nums">
                        {formatOrderNumber(order.seq)}
                      </h3>
                      <p className="text-2xl font-semibold">{order.customerName}</p>
                    </div>

                    {/* P1-8. The counter has to collect before the bag leaves,
                        and the amount is on the badge because a cook who has to
                        open the receipt to find it will wave the order through.
                        Amber, not the red the aging flags own: money owed is
                        not the same alarm as food going cold. */}
                    {order.paymentState === 'unpaid' && (
                      <p className="mt-2 w-fit rounded bg-amber-200 px-2 py-1 text-lg font-bold uppercase text-amber-900">
                        {PAYMENT_LABEL.unpaid} — {formatCents(order.totalCents)}
                      </p>
                    )}

                    <p
                      className={`mt-1 text-lg ${
                        aging.overdue ? 'font-bold text-red-700' : 'text-neutral-700'
                      }`}
                    >
                      {aging.waitingMinutes} min since ordered
                      {aging.overdue && ' — running late'}
                    </p>
                    {aging.noShowLevel > 0 && (
                      <p className="text-lg font-bold text-red-700">
                        On the shelf {aging.readyMinutes} min — no-show?
                      </p>
                    )}

                    <ul className="mt-3 flex flex-col gap-3">
                      {order.lines.map((line) => (
                        <li key={line.id}>
                          {/* Quantity first and prominent: "2×" is not a
                              footnote (P0-11). */}
                          <p className="text-xl font-semibold">
                            <span className="tabular-nums">{line.quantity}×</span> {line.itemName}
                          </p>
                          {optionsByGroup(line).map(([groupName, options]) => (
                            <p key={groupName} className="text-lg">
                              <span className="text-neutral-600">{groupName}:</span>{' '}
                              {options.map((option, index) => {
                                const { text, negated } = describeSelection(
                                  option.optionName,
                                  option.intensity,
                                );
                                return (
                                  <span key={option.id}>
                                    {index > 0 && ', '}
                                    {/* A removal rendered like an addition is
                                        the phone-transcription bug this whole
                                        product exists to kill. */}
                                    <span
                                      className={
                                        negated
                                          ? 'rounded bg-red-700 px-1 font-bold uppercase text-white'
                                          : ''
                                      }
                                    >
                                      {text}
                                    </span>
                                  </span>
                                );
                              })}
                            </p>
                          ))}
                          {line.note && (
                            <p className="mt-1 rounded border-2 border-amber-500 bg-amber-50 p-2 text-lg font-medium">
                              {line.note}
                            </p>
                          )}
                        </li>
                      ))}
                    </ul>

                    {order.orderNote && (
                      <p className="mt-3 rounded border-2 border-amber-500 bg-amber-50 p-2 text-lg font-medium">
                        Order note: {order.orderNote}
                      </p>
                    )}

                    <QueueControls
                      orderId={order.id}
                      status={order.status}
                      paymentState={order.paymentState}
                      undoMs={undoMs}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ))}
    </main>
  );
}
