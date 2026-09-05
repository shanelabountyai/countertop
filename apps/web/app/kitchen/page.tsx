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
  isLeftOver,
  isTerminal,
  matchesLookup,
  needsAcknowledgment,
  orderBalance,
  restaurantClock,
  queueAging,
  STATUS_FACTS,
  undoRemainingMs,
} from '@countertop/core';
import { loadGateState } from '@countertop/db/gate';
import {
  loadQueue,
  loadRecentlyFinished,
  queueCursor,
  type QueueOrder,
} from '@countertop/db/queue';
import { LiveUpdates } from '@/lib/live-updates';
import { describeSelection } from '@/lib/menu-labels';
import { PAYMENT_LABEL, STATUS_LABEL } from '@/lib/status-labels';
import { formatCents } from '@/lib/money';
import { signOut } from './login/actions';
import { NewOrderAlert } from './new-order-alert';
import { currentShift } from '@/lib/shift';
import { PauseSwitch } from './pause-switch';
import { ShiftControl } from './shift-control';
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
  // Who this tablet is stamping rows as (C-086). Read from the cookie in one
  // place; the server actions read it again for themselves rather than taking
  // it off the screen, because a staff id that travels through a request is
  // one anybody can type.
  const onShift = await currentShift();
  // The two states that leave the queue the instant they become undoable
  // (P0-4). Without this the 5-second undo on "Picked up" and "No-show" is
  // real in the engine and unreachable on the screen — the card carrying the
  // button stops being drawn by the very tap that starts the countdown.
  const justFinished = (await loadRecentlyFinished()).filter(
    (order) => undoRemainingMs(order.status, order.events[0], now) > 0,
  );
  // The SAME gate the customer's checkout asks. Staff see the live answer —
  // including an auto-pause nobody switched on — rather than the switch's
  // own position (P0-6).
  const gateState = await loadGateState(now);
  const clock = restaurantClock(now, gateState.timezone);
  const gate = checkoutGate(gateState, clock);
  // Handoff P0-2: the lookup MARKS, it does not filter. Danny answers Cass at
  // the front while Ada waits behind her; a Find box that empties the board
  // means the second question costs a re-type, and for the length of the first
  // answer the whole queue — the new tickets, the aging shelf — is off the
  // screen. Every card stays drawn and exactly the matches are ringed.
  const searching = query.trim() !== '';
  const matches = searching ? orders.filter((order) => matchesLookup(order, query)) : [];
  // Handoff P0-3: the just-finished orders are passed in as HOLDING SLOTS, so
  // the card that was tapped is replaced in place by a tile carrying its undo
  // rather than vanishing from under the hand that tapped it. They are not
  // queue orders and nothing else on this page counts them.
  const groups = groupQueue(orders, justFinished);
  // P1-6, off the UNFILTERED list for the same reason the alert count is: a
  // chore a search can hide is a chore nobody does.
  const leftOver = orders.filter((order) => isLeftOver(order, clock.day));
  // Counted off the UNFILTERED list, deliberately. A cook who has typed a name
  // into the lookup box is still the person who has to hear the next order
  // arrive — an alert that a search can silence is an alert that will be
  // silenced during exactly the rush it exists for (P0-12).
  //
  // Leftovers are excluded: the chime means "a customer is standing there
  // now". A `placed` ticket from Tuesday that chimes on every page load is an
  // alarm staff learn to ignore, and then the alert is worth nothing during
  // the rush it exists for. The banner below is how that order gets seen.
  const unacknowledged = orders.filter(
    (order) => needsAcknowledgment(order.status) && !isLeftOver(order, clock.day),
  ).length;

  return (
    <main className="mx-auto max-w-5xl p-6">
      <LiveUpdates cursor={cursor} />
      <NewOrderAlert count={unacknowledged} />
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h1 className="text-3xl font-semibold">Kitchen queue</h1>
        {/* ≥48px on every link here, not just the buttons: "Availability" is
            the exact page a cook 86's an item from mid-rush (CLAUDE.md's own
            trap list) — it is not the rarely-tapped exception "Sign out" is. */}
        <div className="flex flex-wrap items-center gap-4">
          <Link
            href="/kitchen/availability"
            className="flex min-h-12 min-w-12 items-center justify-center px-2 text-sm underline underline-offset-4"
          >
            Availability
          </Link>
          <Link
            href="/kitchen/menu"
            className="flex min-h-12 min-w-12 items-center justify-center px-2 text-sm underline underline-offset-4"
          >
            Edit menu
          </Link>
          <Link
            href="/kitchen/settings"
            className="flex min-h-12 min-w-12 items-center justify-center px-2 text-sm underline underline-offset-4"
          >
            Settings
          </Link>
          <Link
            href="/kitchen/report"
            className="flex min-h-12 min-w-12 items-center justify-center px-2 text-sm underline underline-offset-4"
          >
            Sales
          </Link>
          <Link
            href="/kitchen/loyalty"
            className="flex min-h-12 min-w-12 items-center justify-center px-2 text-sm underline underline-offset-4"
          >
            Punch card
          </Link>
          <Link
            href="/kitchen/orders"
            className="flex min-h-12 min-w-12 items-center justify-center px-2 text-sm underline underline-offset-4"
          >
            Order history
          </Link>
          <Link
            href="/menu"
            className="flex min-h-12 min-w-12 items-center justify-center px-2 text-sm underline underline-offset-4"
          >
            Customer menu
          </Link>
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

      {/* Who is on shift (C-086). Above the pause switch because it is the
          thing to set once when someone takes over the pass, and below the
          queue itself because the queue is what the screen is for. */}
      <div className="mt-6">
        <ShiftControl name={onShift?.name ?? null} />
      </div>

      <PauseSwitch gate={gate} paused={gateState.paused} />

      {/* The end-of-day sweep (P1-6). A count and a sentence, not a section:
          each leftover stays in its own status group with its normal controls,
          because closing one out is a real transition and only staff know
          which — `abandoned` for food nobody collected, a reason'd `cancelled`
          for a ticket that was never cooked. Guessing that for them would
          invent a no-show in the sales report. */}
      {leftOver.length > 0 && (
        <p className="mt-4 rounded-lg border-2 border-red-500 bg-red-50 p-4 text-lg font-semibold text-red-800">
          {leftOver.length === 1 ? '1 order is' : `${leftOver.length} orders are`} still open from
          an earlier day, the oldest from {leftOver[0]?.businessDay}. Close{' '}
          {leftOver.length === 1 ? 'it' : 'them'} out — marked below — so today&rsquo;s queue is
          today&rsquo;s work.
        </p>
      )}

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
        {searching && (
          <Link
            href="/kitchen"
            className="mt-6 flex min-h-12 items-center rounded-lg px-4 underline underline-offset-4"
          >
            Show all
          </Link>
        )}
      </form>

      {/* The count is the answer to "did it find anything?", which a marked
          card cannot give on its own once the board is 22 cards long and the
          match is four sections down. Zero is the case that most needs saying:
          a queue that looks exactly like it did before the search. */}
      {searching && (
        <p className="mt-2 text-lg font-semibold">
          {matches.length === 1 ? '1 match' : `${matches.length} matches`} for &ldquo;
          {query.trim()}&rdquo; &mdash; every order stays on the board.
        </p>
      )}

      {/* The undo strip (P0-4). Above the groups because five seconds is the
          whole window, and NOT filtered by the lookup box for the same reason
          the alert count is not: a cook who has typed a name in is still the
          person who just mis-tapped "Picked up". It shows only while the undo
          is live, so it cannot become a second, competing list of finished
          orders — that is `/kitchen/orders`. */}
      {justFinished.length > 0 && (
        <section
          aria-label="Just finished"
          className="mt-6 rounded-xl border-2 border-amber-600 bg-amber-50 p-4"
        >
          <h2 className="text-xl font-semibold text-amber-900">
            Just finished — undo if that was a mistake
          </h2>
          <ul className="mt-3 grid gap-4 md:grid-cols-2">
            {justFinished.map((order) => (
              <li key={order.id} className="rounded-lg border border-amber-500 bg-white p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-3xl font-bold tabular-nums">
                    {formatOrderNumber(order.seq)}
                  </h3>
                  <p className="text-2xl font-semibold">{order.customerName}</p>
                </div>
                <p className="mt-1 text-lg text-neutral-700">{STATUS_LABEL[order.status]}</p>
                <QueueControls
                  orderId={order.id}
                  status={order.status}
                  outstandingCents={orderBalance(order).outstandingCents}
                  undoMs={undoRemainingMs(order.status, order.events[0], now)}
                  shelfLocation={order.shelfLocation}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      {groups.map(({ status, orders: inGroup }) => (
        <section key={status} className="mt-8">
          {/* The count is LIVE cards. A tile is an order that has left the
              queue holding its slot for five seconds, and a section heading
              that counted it would say the shelf still has food on it. */}
          <h2 className="text-xl font-semibold">
            {STATUS_LABEL[status]}{' '}
            <span className="font-normal text-neutral-600">
              ({inGroup.filter((order) => !isTerminal(order.status)).length})
            </span>
          </h2>

          {inGroup.length === 0 ? (
            <p className="mt-2 text-neutral-600">Nothing here.</p>
          ) : (
            <ul className="mt-3 grid gap-4 md:grid-cols-2">
              {inGroup.map((order) => {
                // Handoff P0-3. The undo lived only in the strip at the top of
                // the page, which is the right place to FIND it and the wrong
                // place to REACH it: the tap that starts the five seconds is
                // often at the bottom of a board eleven cards deep, and the
                // control it starts was a scroll away. The slot stays, holding
                // the same order number, the same name and the undo — asked of
                // the status module, because a terminal order in a queue
                // section can only have got here as a holding slot.
                if (isTerminal(order.status)) {
                  return (
                    <li
                      key={order.id}
                      className="rounded-xl border-2 border-dashed border-amber-600 bg-amber-50 p-4"
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <h3 className="text-3xl font-bold tabular-nums">
                          {formatOrderNumber(order.seq)}
                        </h3>
                        <p className="text-2xl font-semibold">{order.customerName}</p>
                      </div>
                      <p className="mt-1 text-lg font-semibold text-amber-900">
                        {STATUS_LABEL[order.status]} — undo if that was a mistake
                      </p>
                      <QueueControls
                        orderId={order.id}
                        shelfLocation={order.shelfLocation}
                        status={order.status}
                        outstandingCents={orderBalance(order).outstandingCents}
                        undoMs={undoRemainingMs(order.status, order.events[0], now)}
                      />
                    </li>
                  );
                }

                const aging = queueAging(order, now, DEFAULT_AGING);
                const undoMs = undoRemainingMs(order.status, order.events[0], now);
                const leftOverCard = isLeftOver(order, clock.day);
                const matched = searching && matchesLookup(order, query);

                return (
                  <li
                    key={order.id}
                    className={`rounded-xl border-2 p-4 ${
                      // The match ring sits OUTSIDE the alarm colours below
                      // rather than joining them: a card can be both the order
                      // Cass is asking about and the one that has been on the
                      // shelf 26 minutes, and a search must not be able to
                      // repaint an alarm.
                      matched ? 'ring-4 ring-sky-700 ring-offset-2 ' : ''
                    }${
                      // Left over outranks everything, because it is the
                      // only one of the three whose answer is not a tap on
                      // this card's advance button (P1-6). Then
                      // un-acknowledged over "running late": both are urgent,
                      // only one names the tap that fixes it, and a placed
                      // order cannot be late in a way that accepting it does
                      // not also address.
                      leftOverCard
                        ? 'border-red-600 bg-red-50'
                        : needsAcknowledgment(order.status)
                          ? 'alert-pulse border-sky-700 bg-sky-50'
                          : aging.noShowLevel >= 2 || aging.overdue
                            ? 'border-red-500 bg-red-50'
                            : // Receding is a muted SURFACE, never a lowered
                              // opacity. Dimming the card dims its text with
                              // it, and 18px neutral-600 at 60% is under 3:1
                              // on white — an unreadable ticket is a worse
                              // answer than an un-dimmed one. A card carrying
                              // an alarm never recedes at all: it is one of
                              // the branches above.
                              searching && !matched
                              ? 'border-neutral-200 bg-neutral-100'
                              : 'border-neutral-300'
                    }`}
                  >
                    {/* The ring says "this one" in colour alone, which is
                        nothing to a cook reading a glare-washed tablet at an
                        angle, and nothing to anyone colour-blind. The badge is
                        the same fact in words. */}
                    {matched && (
                      <p className="mb-2 w-fit rounded bg-sky-700 px-2 py-1 text-lg font-bold uppercase text-white">
                        Match
                      </p>
                    )}
                    {/* P1-6. Above the new-order badge and never instead of
                        it: a leftover in `placed` is BOTH, and the older fact
                        is the one that explains why nothing chimed. */}
                    {leftOverCard && (
                      <p className="mb-2 w-fit rounded bg-red-700 px-2 py-1 text-lg font-bold uppercase text-white">
                        Left over from {order.businessDay} — close it out
                      </p>
                    )}
                    {/* The badge, not the animation, is what carries this to
                        a cook who has motion turned off. */}
                    {needsAcknowledgment(order.status) && !leftOverCard && (
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

                    {/* WHERE THE BAG IS (PRD 2 P0-5), directly under the name
                        because the number, the name and the shelf are the
                        three things said out loud at the counter and they
                        should be read in one glance. Rendered on any card
                        whose state `onShelf`, never on `status === 'ready'`.

                        A bordered chip rather than a filled one: red is the
                        aging alarm, amber is money and notes, sky is new and
                        matched — a fourth filled colour on this card would be
                        a fourth thing shouting. This one is loud by SIZE,
                        which is the right axis for a label somebody is reading
                        while holding a bag. */}
                    {STATUS_FACTS[order.status].onShelf && order.shelfLocation && (
                      <p
                        data-testid="shelf-location"
                        className="mt-2 w-fit rounded border-2 border-neutral-900 px-2 py-1 text-2xl font-bold"
                      >
                        {order.shelfLocation}
                      </p>
                    )}

                    {/* P1-8. The counter has to collect before the bag leaves,
                        and the amount is on the badge because a cook who has to
                        open the receipt to find it will wave the order through.
                        Amber, not the red the aging flags own: money owed is
                        not the same alarm as food going cold. */}
                    {orderBalance(order).outstandingCents > 0 && (
                      <p className="mt-2 w-fit rounded bg-amber-200 px-2 py-1 text-lg font-bold uppercase text-amber-900">
                        {/* The BALANCE, not the order total (C-064). Identical
                            today and deliberately not the same expression: the
                            badge must say what is owed, or a partly-settled
                            order sends a cook to collect the whole amount. */}
                        {PAYMENT_LABEL.unpaid} — {formatCents(orderBalance(order).outstandingCents)}
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
                      outstandingCents={orderBalance(order).outstandingCents}
                      undoMs={undoMs}
                      shelfLocation={order.shelfLocation}
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
