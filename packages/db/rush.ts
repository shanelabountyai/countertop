// The seeded rush (C-017) — the capstone demo AND a test.
//
// Thirty orders arrive in twenty minutes, the kitchen works them, and five
// deliberately ugly things happen in the middle of it. The PRD is blunt about
// why: "the rush includes the ugly cases, or the demo proves nothing". A happy
// path replayed thirty times proves the happy path thirty times.
//
//   1. A modifier option is 86'd mid-rush, with a cart already holding it.
//   2. A cook advances the wrong card and undoes it.
//   3. A cooked order is never collected and ages out to `abandoned`.
//   4. A customer double-taps Place order.
//   5. Orders arrive while the restaurant is paused.
//
// SIMULATED TIME, not wall-clock. Every call takes its instant as a parameter
// — placement, transitions, the gate — so twenty minutes of rush runs in a few
// seconds and lands the same rows it would have at 1× speed. That is only
// possible because nothing in packages/core reads the clock (CLAUDE.md); the
// rush is the payoff for that rule, not a workaround for it.
//
// Everything below goes through the REAL paths: `placeOrder` for placements,
// `applyOrderAction` for every move, the settings row for the pause, the
// `available` column for the 86. A rush that wrote its own rows would agree
// with itself and prove nothing.
import {
  addLine,
  availableSlots,
  EMPTY_CART,
  instantMinutesAfter,
  type AdjustmentReason,
  type CancelReason,
  type Cart,
  type Composition,
  type OrderStatus,
} from '@countertop/core';
import { loadGateState } from './gate';
import { prisma } from './index';
import { enrolMember, expireInactiveBalances, hasLoyaltyPepper, redeemReward } from './loyalty';
import { loadClock, loadMenu } from './menu';
import { derivedIdempotencyKey, placeOrder } from './placement';
import { requestRefund, reverseRefund } from './refund';
import {
  confirmPhoneVerificationForCheckout,
  startPhoneVerification,
} from './verification';
import { applyOrderAction } from './transitions';
import {
  resetDatabase,
  seedSampleMenu,
  seedSettings,
  seedStaff,
  seedStoreHours,
} from './testing/index';

/**
 * Two cooks working the rush (C-086).
 *
 * A demo where every event is unattributed would show the column and not the
 * feature. Alternating by order — deterministically, like the paid/unpaid mix
 * — puts both names through the log, which is also what makes "two people, two
 * identities" assertable against a real service rather than against a fixture
 * built to prove it.
 */
const COOKS = ['staff-noor', 'staff-theo'] as const;
const cookFor = (label: string): string =>
  COOKS[[...label].reduce((sum, char) => sum + char.charCodeAt(0), 0) % COOKS.length]!;

/** Noon in Los Angeles on a fixed date, so the whole rush — including its
 *  45-minute tail — falls inside one business day and one report hour whatever
 *  timezone the process runs under. */
export const RUSH_ANCHOR = new Date(Date.UTC(2026, 6, 14, 19, 0, 0));

/** How long the script keeps running after the last arrival: the kitchen tail.
 *
 *  Long enough for the no-show to age past the third flag (30 min), and — since
 *  C-124 — long enough for the LATEST pickup slot the rush can resolve to be
 *  collected nine minutes after it. That slot depends on where the anchor falls
 *  against the restaurant's 15-minute grid, so the worst case is minute 40 and
 *  the tail has to clear 49. See `resolveScheduledSlot`. */
export const RUSH_END_MINUTE = 50;

/** The option that runs out mid-rush, and the minute it does. */
export const EIGHTY_SIXED_OPTION = 'guacamole';
export const EIGHTY_SIX_MINUTE = 8;

export const PAUSE_MINUTE = 15;
export const RESUME_MINUTE = 18;

// ── The punch card (PRD 7, C-120) ───────────────────────────────────────────
//
// SEEDED STATE, NOT A SIXTH UGLY CASE. The rush's five cases are the master
// PRD's Success Metrics verbatim and this session deliberately did not touch
// that list. What it adds is a restaurant that has regulars: five of the
// thirty customers are on the punch card, two of them with a reward saved up,
// and the demo therefore has something on the loyalty screen, a Rewards
// column on the sales report, and a receipt with a discount on it.
//
// Without this the capstone recording walks somebody through a product whose
// last five sessions built a feature it never shows.

/** What a regular arrived with, before today. */
type RushRegular = {
  label: string;
  phone: string;
  /** Points carried in. `0` is a member with a card and nothing on it — the
   *  ordinary case, and the one that makes "40 people can walk in with $10
   *  off" a number rather than a guess. */
  openingPoints: number;
  /** Last seen this many days before the rush, past the 365-day expiry
   *  window. Enrolled and last active then, never orders today. */
  lapsedDaysAgo?: number;
};

/**
 * The members, enrolled before the rush opens.
 *
 * Their opening points are written as `earn` rows with a NULL `orderId` and
 * an instant a month before the anchor — a paper punch card carried over,
 * which is the honest shape for "points this system did not issue". An
 * `adjust` would have been easier and would have put "Staff corrections
 * +260" on the program screen for corrections nobody made (C-118's own trap,
 * one table over).
 *
 * The partial unique index is on `(orderId) WHERE kind = 'earn'`, and in
 * Postgres NULLs are distinct in a unique index, so several of these coexist
 * without contending — which is correct: they are different members' history,
 * not two earns on one order.
 */
const RUSH_REGULARS: RushRegular[] = [
  // The two with a reward ready. Both spend it at checkout — one order is
  // collected, the other is cancelled out from under it, which is the pair
  // C-119's settlement exists for.
  { label: 'Ivy Castellanos', phone: '5550102233', openingPoints: 100 },
  { label: 'Owen Brandt', phone: '5550104417', openingPoints: 100 },
  // Rae's ticket is the one a cook advances by mistake and reverts. Her earn
  // therefore lands on an order that reached `picked_up` the long way, which
  // is C-102's revert-safety visible in the demo rather than only in a test.
  { label: 'Rae Sutton', phone: '5550108890', openingPoints: 40 },
  // The no-show. A member who never collects earns nothing — the contrast
  // that makes the earn mean something.
  { label: 'Cass Iverson', phone: '5550106654', openingPoints: 75 },
  // A reward spent at the COUNTER, not at checkout (C-152): Ada pays at
  // pickup, and the cashier spends it from the staff receipt before she pays.
  { label: 'Ada Nkemelu', phone: '5550101102', openingPoints: 100 },
  // Not seen in over a year. The nightly sweep before service expires her
  // points, so the demo's loyalty screen has an `expire` row on it (C-152).
  { label: 'Lena Marsh', phone: '5550109921', openingPoints: 60, lapsedDaysAgo: 400 },
];

/** How long before the rush the regulars enrolled. Inside the 365-day expiry
 *  window by a wide margin, so nothing the demo shows is about to vanish. */
const ENROLLED_DAYS_AGO = 30;

// ── Order ahead (P1-2, C-124) ───────────────────────────────────────────────
//
// TWO OF THE THIRTY, NOT TWO MORE. The master PRD's Success Metric is "30
// orders in 20 minutes via script" and this file's tests assert that number;
// adding customers to demonstrate a feature would have restated a metric the
// rush exists to hold. A real lunch rush has some order-ahead in it. It does
// not have two extra people standing outside.
//
// BOTH BOOK THE SAME SLOT, which is not laziness. `weightBySlot` is summed
// from the open scheduled orders, so the second booking is re-checked against
// a slot the first one has already eaten into — one order per slot would
// leave that arithmetic untouched by the demo.
//
// They differ in the ONE comparison `isPastDue` makes for a scheduled ticket
// (C-123): when the food was ready against when it was promised. Both are
// written as OFFSETS from the slot, since which rush minute that is depends on
// the anchor — the minutes in brackets are the ones at `RUSH_ANCHOR`, where
// the slot resolves to 30 and `rush.test.ts` hand-tallies them.
//
//   * Hal Brennan's is bagged at `slot - 10` (minute 20), ten minutes EARLY,
//     and collected at `slot + 1` (31). The KITCHEN makes his slot, so he is
//     never `scheduledLate`; the no-show clock is the part worth showing. It
//     starts at the LATER of ready and the promised minute, so the food sits
//     across the slot having spent zero minutes being a no-show. Before C-123
//     this exact ticket read `noShowLevel: 1` and put "On the shelf 10 min —
//     no-show?" in red on a card that was doing everything right.
//
//     `slot - 10` IS CHOSEN AGAINST BOTH DEFECTS AT ONCE, and neither margin
//     is spare. Ten minutes before the slot is the first no-show mark
//     exactly, so the pre-C-123 clock reaches it. It is ALSO fifteen minutes
//     after he ordered — `queueFlagMinutes` exactly, at the anchor the test
//     pins — so the pre-C-123 `isPastDue` calls this ticket LATE at the
//     instant it reached `ready`, and the report's `scheduledLate` counts two
//     where it should count one. Bagged two minutes earlier, the report would
//     have said "1" under the defect as well, by arithmetic coincidence, and
//     this whole demo would have agreed with the bug it exists to rule out.
//
//     He IS `overdue` for the one minute between his slot and his arrival,
//     and that is the flag working: `isPastDue` is `>=`, so a 12:30 pickup is
//     due AT 12:30 and a customer a minute late is a minute late. The red
//     C-123 removed was the KITCHEN being blamed for it.
//   * Jonah Reddick's is not ready until `slot + 6` (36), six minutes LATE,
//     and collected at `slot + 9` (39). His card reads "6 min past pickup —
//     running late" and he is the whole of the report's `scheduledLate`.
//
// The first two taps of each are left exactly where the default cadence put
// them, so the mid-service screen `e2e/rush.spec.ts` reads at minute 12 is the
// queue it was before this item with a countdown added to two cards — a demo
// whose unrelated assertions all moved would not be showing this feature, it
// would be hiding it.
//
// NEITHER IS QUOTED A RANGE. `placeOrder` writes a null quote for a scheduled
// order because its promise IS the slot, so these two leave the P1-4 accuracy
// sample. That exclusion is keyed on a DIFFERENT column from the one
// `serviceTimes` splits on — `quotedLowMinutes IS NULL` against
// `requestedFor IS NOT NULL` — and the two agree only because placement sets
// them together. `rush.test.ts` asserts they still pick out the same orders.

/** The later of the two order-ahead arrivals. The slot is resolved as of this
 *  minute so that BOTH customers can book it: a slot inside Jonah's lead time
 *  is inside Hal's too, the minute before. */
export const SCHEDULED_BOOKED_AT_MINUTE = 6;

// ── The compositions ────────────────────────────────────────────────────────
// Hand-written against the 25-item menu. Indices are referenced by the order
// table below; anything containing the 86'd option can only be used by an
// order that arrives BEFORE minute 8, and `runRush` throws if that slips.
const COMPOSITIONS: Composition[][] = [
  // 0 — the founding case: a negation, an add-on, and the option that runs out.
  [
    {
      itemId: 'burrito',
      quantity: 1,
      selections: [
        { groupId: 'protein', optionId: 'chicken' },
        { groupId: 'addons', optionId: 'guacamole' },
        { groupId: 'toppings', optionId: 'onions', intensity: 'none' },
      ],
    },
  ],
  // 1
  [
    {
      itemId: 'bowl',
      quantity: 1,
      selections: [
        { groupId: 'size', optionId: 'large' },
        { groupId: 'protein', optionId: 'steak' },
        { groupId: 'salsa', optionId: 'chipotle', intensity: 'extra' },
      ],
    },
  ],
  // 2
  [
    {
      itemId: 'taco-plate',
      quantity: 1,
      selections: [
        { groupId: 'fillings', optionId: 'al-pastor' },
        { groupId: 'fillings', optionId: 'fish' },
      ],
    },
  ],
  // 3
  [{ itemId: 'chips', quantity: 2, selections: [] }],
  // 4
  [
    {
      itemId: 'california-burrito',
      quantity: 1,
      selections: [
        { groupId: 'protein', optionId: 'carnitas' },
        { groupId: 'tortilla-style', optionId: 'corn-tortilla' },
        { groupId: 'addons', optionId: 'queso' },
      ],
    },
  ],
  // 5
  [
    {
      itemId: 'garden-bowl',
      quantity: 1,
      selections: [
        { groupId: 'size', optionId: 'medium' },
        { groupId: 'rice', optionId: 'brown-rice' },
        { groupId: 'toppings', optionId: 'cheese', intensity: 'extra' },
      ],
    },
  ],
  // 6
  [
    { itemId: 'quesadilla', quantity: 1, selections: [{ groupId: 'protein', optionId: 'chicken' }] },
    { itemId: 'churros', quantity: 1, selections: [] },
  ],
  // 7
  [
    {
      itemId: 'enchilada-plate',
      quantity: 1,
      selections: [
        { groupId: 'protein', optionId: 'veggie' },
        // A negation that is a whole option: "no rice" is a choice the line
        // cook has to read, not the absence of one.
        { groupId: 'rice', optionId: 'no-rice' },
      ],
    },
    {
      itemId: 'horchata',
      quantity: 2,
      selections: [{ groupId: 'size', optionId: 'large' }],
    },
  ],
  // 8 — the other guacamole order.
  [
    {
      itemId: 'nachos',
      quantity: 1,
      selections: [
        { groupId: 'protein', optionId: 'steak' },
        { groupId: 'addons', optionId: 'guacamole' },
        { groupId: 'toppings', optionId: 'cilantro', intensity: 'none' },
      ],
    },
  ],
  // 9
  [
    {
      itemId: 'breakfast-burrito',
      quantity: 1,
      selections: [
        { groupId: 'protein', optionId: 'chicken' },
        { groupId: 'toppings', optionId: 'cheese' },
      ],
    },
    { itemId: 'agua-fresca', quantity: 1, selections: [{ groupId: 'size', optionId: 'small' }] },
  ],
  // 10
  [
    {
      itemId: 'torta',
      quantity: 1,
      selections: [
        { groupId: 'protein', optionId: 'carnitas' },
        { groupId: 'toppings', optionId: 'onions', intensity: 'light' },
        { groupId: 'addons', optionId: 'tortilla' },
      ],
      note: 'Cut it in half please',
    },
  ],
  // 11
  [
    {
      itemId: 'fajita-plate',
      quantity: 1,
      selections: [
        { groupId: 'protein', optionId: 'steak' },
        { groupId: 'tortilla-style', optionId: 'flour-tortilla' },
        { groupId: 'toppings', optionId: 'cilantro', intensity: 'extra' },
      ],
    },
    { itemId: 'paleta', quantity: 2, selections: [] },
  ],
  // 12
  [
    { itemId: 'tamale-plate', quantity: 1, selections: [] },
    { itemId: 'mexican-coke', quantity: 1, selections: [] },
    { itemId: 'churros', quantity: 1, selections: [] },
  ],
  // 13
  [
    {
      itemId: 'bowl',
      quantity: 1,
      selections: [
        { groupId: 'size', optionId: 'small' },
        { groupId: 'protein', optionId: 'veggie' },
        { groupId: 'salsa', optionId: 'verde' },
      ],
    },
    { itemId: 'bottled-water', quantity: 1, selections: [] },
  ],
  // 14 — composition 0 with the guacamole taken off: what the stranded cart
  // becomes once its owner fixes it.
  [
    {
      itemId: 'burrito',
      quantity: 1,
      selections: [
        { groupId: 'protein', optionId: 'chicken' },
        { groupId: 'toppings', optionId: 'onions', intensity: 'none' },
      ],
    },
  ],
];

// ── The kitchen's plan for one order ────────────────────────────────────────

type KitchenStep =
  | { at: number; step: 'advance' }
  | { at: number; step: 'revert'; reason: string }
  | { at: number; step: 'cancel'; reason: CancelReason; note?: string }
  | { at: number; step: 'abandon' }
  /**
   * Somebody at the counter sends money back (PRD 3 P0-6, C-071).
   *
   * NOT A KITCHEN TAP, and it is in this union anyway for the reason `cancel`
   * already is: what the union actually schedules is a STAFF ACTION at a
   * minute of the rush, and a second timetable beside this one would be a
   * second thing to keep in step with the loop that drains it.
   *
   * Only reachable on an order that was PREPAID and PICKED UP, which is the
   * whole point of the two orders that carry it — every other prepaid exit in
   * the rush is a void (C-069), so until now the refund machinery, its
   * failure row and its exceptions list appeared in no demo at all.
   */
  | {
      at: number;
      step: 'refund';
      /** What a person typed into the box, in cents. Bounded by what is held
       *  at the ATTEMPT, never by this number — `settleRefund` refuses it
       *  against the balance rather than trimming it, so a menu reprice that
       *  puts this above the total makes `refund` throw naming the customer. */
      amountCents: number;
      reason: AdjustmentReason;
      /** The provider REFUSES this one, in these words — a `refund_failed` row
       *  and an entry on the exceptions list, which is the half of P0-4 that a
       *  demo of the happy path can never show. */
      declined?: string;
    }
  /** The newest settled refund on this order was a mistake, and a person at
   *  the counter takes it back by name (C-133's `refund_reversed`). */
  | { at: number; step: 'reverseRefund'; note: string }
  /** A reward spent from the staff receipt (`redeemReward`), not at checkout. */
  | { at: number; step: 'redeem' };

/**
 * The default cadence: accepted a minute after it lands, on the grill two
 * minutes later, ready eight after that, collected three minutes on. `slow`
 * pushes the ready and the pickup back for the tickets that took longer, which
 * is what makes the time-in-state tally something other than one number times
 * thirty.
 */
const cadence = (minute: number, slow = 0): KitchenStep[] => [
  { at: minute + 1, step: 'advance' },
  { at: minute + 3, step: 'advance' },
  { at: minute + 11 + slow, step: 'advance' },
  { at: minute + 14 + slow, step: 'advance' },
];

type RushOrder = {
  label: string;
  /** Minute of the rush the customer taps Place order. */
  minute: number;
  composition: number;
  /** When the cart was composed, if that is not the minute it was placed. The
   *  86 lands in between for exactly one customer. */
  composedMinute?: number;
  slow?: number;
  /**
   * This customer ordered AHEAD (P1-2) and collects at the slot
   * `resolveScheduledSlot` books, rather than as soon as the kitchen gets to
   * it.
   *
   * A flag and not a minute, deliberately. WHICH slot is not this table's to
   * decide — it is whatever `availableSlots` offers on the day, and the table
   * cannot know that without doing the server's arithmetic a second time.
   * `submit` hands placement the minute it was offered and `placeOrder`
   * re-checks it exactly as it does for a browser, so a refusal makes `submit`
   * throw naming the customer.
   */
  ordersAhead?: true;
  /** Replaces the default cadence outright. A FUNCTION for an order-ahead
   *  ticket, whose last taps are written against the slot it booked rather
   *  than against a minute this table guessed. */
  kitchen?: KitchenStep[] | ((slot: number) => KitchenStep[]);
  /** Two concurrent submissions carrying the SAME idempotency key. */
  doubleSubmit?: true;
  /** This attempt is SUPPOSED to fail, with this error kind. Anything else
   *  refused is a defect, and `runRush` throws rather than reporting a rush
   *  that quietly lost orders. */
  expectRefusal?: 'option_unavailable' | 'ordering_closed';
  /** A second attempt by the same customer after a refusal. */
  retryOf?: string;
  /**
   * The number this customer hands over (P0-8's optional field, PRD 7 P0-1's
   * key). Present on a MINORITY of the rush, deliberately: the field is
   * optional on the real form and a demo where everybody fills it in is not
   * showing an optional field. It is also what `queueReadyNotification` is
   * gated on, so these are the tickets that put rows in the P1-3 outbox.
   */
  phone?: string;
  /**
   * This customer spends a punch-card reward at checkout (PRD 7 P1-1).
   *
   * NOT A SIXTH UGLY CASE, and the distinction is the one this session was
   * asked to keep: the five cases in the header are FAILURES the master PRD's
   * Success Metrics name verbatim, and this list already varies orders along
   * axes that document never mentions — `paidNow`, `slow`, which cook taps
   * the card. A customer with a full punch card is another such axis. No
   * order is added, removed or re-timed for it.
   *
   * Requires `phone`, a seeded balance of at least one reward, and a subtotal
   * the reward fits inside; `seedRushLoyalty` sets the first two up and
   * `runRush` throws if the third does not hold.
   */
  redeemsReward?: true;
};

/**
 * The rush. Thirty orders land; two more customers bounce off the pause and
 * do not come back, which is a real outcome and is counted as one.
 *
 * Arrival minutes are deliberately clustered — minute 11 takes three at once —
 * because CONCURRENT placement is what the `(businessDay, seq)` unique
 * constraint exists for. Orders sharing a minute are submitted with
 * `Promise.all`, so the retry loop in `placeOrder` is exercised by the demo
 * rather than only by a unit test.
 */
export const RUSH_ORDERS: RushOrder[] = [
  {
    label: 'Ada Nkemelu',
    minute: 0,
    composition: 0,
    phone: '5550101102',
    // Her default cadence, with the counter redemption the minute before she
    // collects (C-152).
    kitchen: [...cadence(0).slice(0, 3), { at: 14, step: 'redeem' }, cadence(0)[3]!],
  },
  { label: 'Ben Sorensen', minute: 0, composition: 1 },
  { label: 'Cleo Vance', minute: 1, composition: 8 },

  // UGLY CASE 3 — the no-show. Cooked fast, then nobody comes: ready at
  // minute 7 and still on the shelf 33 minutes later, past all three
  // no-show flags, when staff close it out.
  {
    label: 'Cass Iverson',
    minute: 1,
    composition: 3,
    phone: '5550106654',
    kitchen: [
      { at: 2, step: 'advance' },
      { at: 4, step: 'advance' },
      { at: 7, step: 'advance' },
      { at: 40, step: 'abandon' },
    ],
  },

  { label: 'Dev Raman', minute: 2, composition: 2 },

  // UGLY CASE 1b — the third surface an 86 touches. This order was placed
  // with guacamole six minutes before the kitchen ran out. Its SNAPSHOT does
  // not care and never will; the operational answer is a staff cancel with
  // the reason attached, which is what happens at minute 9.
  //
  // He also spent a punch-card reward on it (PRD 7 P1-1, C-120). The
  // cancellation hands the points back — a logged `adjust`, never a delete —
  // which is C-119's settlement happening in the demo rather than only in a
  // unit test. $13.45 of food, $10.00 off, 28c of tax, $3.73 authorised and
  // then voided.
  {
    label: 'Owen Brandt',
    minute: 2,
    composition: 0,
    phone: '5550104417',
    redeemsReward: true,
    kitchen: [
      { at: 3, step: 'advance' },
      { at: 5, step: 'advance' },
      { at: 9, step: 'cancel', reason: 'out_of_item', note: 'Out of guacamole, called them' },
    ],
  },

  { label: 'Elin Haugen', minute: 3, composition: 4 },
  { label: 'Fitz Okonkwo', minute: 3, composition: 5 },
  // A REFUND THAT GOES THROUGH (PRD 3 P0-6). Prepaid at checkout, collected at
  // minute 18, and at 22 she is back at the counter with burnt churros. The
  // counter sends $4.95 back — the churros' own price, the food and not its
  // share of the tax, because a refund is a number a person types rather than
  // a line the product re-derives.
  //
  // NOT a sixth ugly case, the same distinction `redeemsReward` carries: the
  // five in the header are the master PRD's Success Metrics verbatim. No order
  // is added, removed or re-timed for this — only her default cadence is spelt
  // out so a fifth step can follow it.
  //
  // $8.95 quesadilla + $0.00 chicken + $4.95 churros = $13.90, tax $1.15,
  // $15.05 held and captured at pickup. $4.95 of it goes back, which leaves
  // `paymentState` at `paid` and not `refunded` — the lossy-enum case
  // `derivePaymentState` exists to get right.
  {
    label: 'Gia Moretti',
    minute: 4,
    composition: 6,
    // At 23 a second cashier, not seeing the first, sends the same $4.95
    // again; at 24 it is caught and that one refund is reversed by name
    // (C-152). Net refunded stays $4.95 — the report must not move.
    kitchen: [
      ...cadence(4),
      { at: 22, step: 'refund', amountCents: 495, reason: 'quality' },
      { at: 23, step: 'refund', amountCents: 495, reason: 'quality' },
      { at: 24, step: 'reverseRefund', note: 'churros refunded twice' },
    ],
  },

  // UGLY CASE 2 — the wrong card advanced, and undone. Rae's ticket is marked
  // ready at minute 12 by a cook reaching across the pass for someone else's;
  // the mistake is caught a minute later and reverted. The revert is a LOGGED
  // event, never a delete — so the time-in-state tally below still knows this
  // order was in `preparing` twice.
  {
    label: 'Rae Sutton',
    minute: 4,
    composition: 7,
    phone: '5550108890',
    kitchen: [
      { at: 5, step: 'advance' },
      { at: 7, step: 'advance' },
      { at: 12, step: 'advance' },
      { at: 13, step: 'revert', reason: 'advanced the wrong card' },
      { at: 16, step: 'advance' },
      { at: 19, step: 'advance' },
    ],
  },

  // ORDER AHEAD, and the kitchen makes it (P1-2). Ordered at 12:05 for the
  // first slot he is offered, cooked ten minutes early and left on the shelf
  // across it: the ticket whose no-show clock must read zero at its slot.
  // `slot - 10` is load-bearing in two directions — see the `Order ahead`
  // block above.
  {
    label: 'Hal Brennan',
    minute: 5,
    composition: 9,
    ordersAhead: true,
    kitchen: (slot) => [
      { at: 6, step: 'advance' },
      { at: 8, step: 'advance' },
      // Ten minutes before his slot, and both taps AFTER it are written
      // against the slot for the same reason the first two are not: a kitchen
      // works a scheduled ticket to the clock, and only the first two taps
      // belong to the minute it was ordered.
      { at: slot - 10, step: 'advance' },
      { at: slot + 1, step: 'advance' },
    ],
  },
  // A regular with a full punch card, spending it at checkout (PRD 7 P1-1).
  // $13.75 of food, $10.00 off, tax on the $3.75 that is left: 31c, so $4.06.
  // Collected at the counter, so the reward appears on a sold order and the
  // sales report's Rewards column has something in it.
  { label: 'Ivy Castellanos', minute: 5, composition: 10, slow: 2, phone: '5550102233', redeemsReward: true },
  // ORDER AHEAD, missed (P1-2). Hal's slot, six minutes late to it. The only
  // ticket in the rush that `serviceTimes` counts as `scheduledLate`, and the
  // only card in it that ever reads "past pickup".
  {
    label: 'Jonah Reddick',
    minute: 6,
    composition: 11,
    ordersAhead: true,
    kitchen: (slot) => [
      { at: 7, step: 'advance' },
      { at: 9, step: 'advance' },
      { at: slot + 6, step: 'advance' },
      { at: slot + 9, step: 'advance' },
    ],
  },
  { label: 'Kira Lindqvist', minute: 7, composition: 12 },
  { label: 'Luca Ferrante', minute: 7, composition: 13 },
  { label: 'Mira Halvorsen', minute: 8, composition: 1 },
  { label: 'Nate Boateng', minute: 9, composition: 2 },

  // UGLY CASE 1a — the stranded cart. Composed at minute 6 with guacamole on
  // it, submitted at minute 9, an hour of kitchen time after the last tub was
  // scraped out. The server refuses it at the OPTION grain: out of avocado is
  // not out of burritos.
  {
    label: 'Nia Feldman',
    minute: 9,
    composedMinute: 6,
    composition: 0,
    expectRefusal: 'option_unavailable',
  },
  // …and the same customer, a minute later, with the guacamole taken off.
  { label: 'Nia Feldman', minute: 10, composition: 14, retryOf: 'Nia Feldman' },

  { label: 'Ola Sjoberg', minute: 10, composition: 3, slow: 4 },
  { label: 'Pia Grimaldi', minute: 11, composition: 4 },
  { label: 'Quinn Adeyemi', minute: 11, composition: 5 },
  { label: 'Rosa Delgado', minute: 11, composition: 6, slow: 3 },
  { label: 'Sol Nakamura', minute: 12, composition: 7 },
  { label: 'Tam Okoro', minute: 13, composition: 9, slow: 2 },
  // A REFUND THE PROCESSOR REFUSES, and the reason this pair is two orders
  // rather than one. Everything on this side of the seam is real — the ask is
  // written and durable BEFORE the provider is called, so when the call fails
  // the request stands, a `refund_failed` row carries the processor's own
  // words onto the receipt, and the order is on the exceptions list at close
  // with the retry button beside it. That list is empty in every other run of
  // this demo, which is exactly the problem: the machinery P0-4 exists for is
  // the machinery a happy path cannot show.
  //
  // LEFT FAILING, deliberately. A retry that succeeded would empty the list
  // again by minute 50 and the demo would end looking like the one before it.
  //
  // $11.50 torta + $1.50 carnitas + $0.75 extra tortilla = $13.75, tax $1.13,
  // $14.88 held and captured at pickup — and all of it is asked for, because
  // "the whole ticket" is what somebody types when the food was wrong.
  {
    label: 'Vik Ramsay',
    minute: 14,
    composition: 10,
    kitchen: [
      ...cadence(14),
      {
        at: 31,
        step: 'refund',
        amountCents: 1488,
        reason: 'wrong_item',
        declined: 'Card issuer declined the refund (do_not_honor).',
      },
    ],
  },

  // UGLY CASE 4 — the double-tap. Two submissions, same idempotency key,
  // fired concurrently. The unique constraint is the mechanism; the disabled
  // button is UX (P0-10).
  { label: 'Theo Marsh', minute: 14, composition: 11, doubleSubmit: true },

  // UGLY CASE 5 — orders arriving while the restaurant is paused. Two
  // customers give up; one comes back after the pause lifts.
  { label: 'Juno Park', minute: 16, composition: 12, expectRefusal: 'ordering_closed' },
  { label: 'Lila Ortiz', minute: 16, composition: 13, expectRefusal: 'ordering_closed' },
  { label: 'Bram Whitfield', minute: 17, composition: 1, expectRefusal: 'ordering_closed' },

  { label: 'Wren Adeyemi', minute: 18, composition: 2 },
  { label: 'Xan Moreau', minute: 19, composition: 3 },
  { label: 'Juno Park', minute: 19, composition: 12, retryOf: 'Juno Park' },
  { label: 'Yara Solano', minute: 20, composition: 4, slow: 1 },
];

// ── Running it ──────────────────────────────────────────────────────────────

export type RushAttempt = {
  label: string;
  minute: number;
  outcome: 'placed' | 'refused';
  /** Present when it was placed. */
  orderId?: string;
  seq?: number;
  /** The error kinds the server refused it with. */
  errors: string[];
  /** Both responses of the double-submit, to compare. */
  replayedOrderId?: string;
};

export type RushResult = {
  anchor: Date;
  /** The instant the run stopped — minute `untilMinute` of the rush. */
  end: Date;
  /** The rush minute the two order-ahead customers booked (P1-2). Resolved
   *  from the offered slots, so it moves with the anchor — 30 at
   *  `RUSH_ANCHOR`, and see `resolveScheduledSlot` for the range. */
  scheduledSlotMinute: number;
  /** Where it stopped. Below `RUSH_END_MINUTE` the kitchen is mid-service. */
  untilMinute: number;
  attempts: RushAttempt[];
  /** Label → order id, for the orders that made it in. A retry overwrites its
   *  own refused attempt, which is what the customer would say happened. */
  orderIds: Map<string, string>;
  finalStatuses: Record<OrderStatus, number>;
};

/** Minute N of the rush, as an instant. */
const at = (anchor: Date, minute: number): Date => instantMinutesAfter(anchor, minute);

/** Every order's idempotency key, derived so a retry gets a NEW one — it is a
 *  different order, not a resubmission — and the double-submit gets the same. */
const keyFor = (order: RushOrder): string =>
  derivedIdempotencyKey(`rush-${order.label}-${order.minute}`);

/**
 * Enrol the regulars and hand them the points they walked in with (C-120).
 *
 * BEFORE minute 0 and through `enrolMember`, the real writer — so the digests
 * are peppered the way every other member's are and the demo's loyalty tables
 * are not a customer list. A rush that inserted `LoyaltyMember` rows itself
 * would agree with itself and prove nothing, which is the same sentence this
 * file's header already makes about orders.
 *
 * THROWS on an unset pepper rather than quietly running a rush with no punch
 * card in it. `enrolMember` refuses by name — `loyalty_pepper_unset` — and a
 * capstone demo that silently dropped the feature it exists to show is worse
 * than one that will not start.
 */
async function seedRushLoyalty(anchor: Date): Promise<void> {
  if (!hasLoyaltyPepper()) {
    throw new Error(
      'LOYALTY_PHONE_PEPPER is not set: the rush enrols members and would silently seed none. ' +
        'Set it in .env.local / .env.test, as .env.example describes.',
    );
  }
  for (const regular of RUSH_REGULARS) {
    const enrolledAt = instantMinutesAfter(
      anchor,
      -(regular.lapsedDaysAgo ?? ENROLLED_DAYS_AGO) * 24 * 60,
    );
    const result = await enrolMember({
      phone: regular.phone,
      displayName: regular.label,
      now: enrolledAt,
    });
    if (!result.ok) {
      throw new Error(`could not enrol ${regular.label} for the rush: ${result.reason}`);
    }
    if (regular.openingPoints === 0) continue;

    await prisma.loyaltyEvent.create({
      data: {
        memberId: result.memberId,
        // NULL: these points predate this system. See `RUSH_REGULARS`.
        orderId: null,
        at: enrolledAt,
        kind: 'earn',
        points: regular.openingPoints,
      },
    });
    // `enrolMember` deliberately does not move `lastActivityAt` (C-101), and
    // an `earn` written directly is not `earnForOrder`, so the expiry clock
    // is set here — otherwise these regulars would look like they had not
    // been seen since the day they signed up, which is not what carrying a
    // balance in means.
    await prisma.loyaltyMember.update({
      where: { id: result.memberId },
      data: { lastActivityAt: enrolledAt },
    });
  }

  // The nightly sweep, run before the doors open, through the real writer.
  // It has to take exactly the lapsed regulars' points and nobody else's.
  const swept = await expireInactiveBalances(anchor);
  const lapsed = RUSH_REGULARS.filter((regular) => regular.lapsedDaysAgo !== undefined);
  const expected = lapsed.reduce((sum, regular) => sum + regular.openingPoints, 0);
  if (swept.members !== lapsed.length || swept.points !== expected) {
    throw new Error(
      `the pre-service expiry sweep took ${swept.points} points from ${swept.members} members; ` +
        `expected ${expected} from ${lapsed.length}`,
    );
  }
}

/**
 * A verified-phone bearer token for the one checkout attempt that spends a
 * reward (C-116, spent C-118).
 *
 * THROUGH THE REAL TWO CALLS, never a hand-built string: the code is issued,
 * echoed by the stub provider (C-115's `SmsVerifyProvider` seam — there is no
 * carrier), and confirmed against the same `idempotencyKey` the placement
 * carries. So the rush exercises verification end to end, which no other
 * script does.
 */
async function verifiedTokenFor(order: RushOrder, now: Date): Promise<string> {
  const phone = order.phone!;
  const started = await startPhoneVerification(phone, now);
  if (!started.ok) {
    throw new Error(`${order.label} could not request a code: ${started.reason}`);
  }
  if (started.echoedCode === null) {
    throw new Error(
      `${order.label}: the SMS provider returned no code to confirm with. A real provider is ` +
        'plugged in, and the rush has no way to read a text message.',
    );
  }
  const confirmed = await confirmPhoneVerificationForCheckout(
    phone,
    started.echoedCode,
    keyFor(order),
    now,
  );
  if (!confirmed.ok) {
    throw new Error(`${order.label} could not confirm their code: ${confirmed.reason}`);
  }
  return confirmed.token;
}

/**
 * Which slot the two order-ahead customers actually get — ASKED, not assumed.
 *
 * The first version of this hard-coded "minute 30 of the rush", which is the
 * right answer for `RUSH_ANCHOR` and wrong for the demo. Slots are offered on
 * the RESTAURANT's grid — every 15 minutes from local midnight — and the demo
 * anchors the rush so it ends NOW, at whatever minute past the hour that is.
 * Anchored at 09:18, minute 30 is 09:48, which is not a slot any customer was
 * ever shown, and `placeOrder` refused it with `slot_unavailable` exactly as it
 * should have. The rush was wrong, not the server.
 *
 * So it books the way a browser books: take the list `availableSlots` offers
 * and pick the first one on it. That is the same list the picker renders and
 * the same one placement re-checks against, which is this file's rule for
 * everything — the real path, or no proof.
 *
 * The rush-minute OFFSET is what the kitchen script needs, and it varies with
 * the anchor, because the lead time lands somewhere different in each
 * fifteen-minute interval: 26 at its lowest, 40 at its highest, and
 * `RUSH_END_MINUTE` is sized to collect the latest of those. At `RUSH_ANCHOR`
 * — noon exactly — it is 30, which is why the numbers in `rush.test.ts` can be
 * hand-tallied at all.
 */
async function resolveScheduledSlot(
  anchor: Date,
): Promise<{ day: string; minuteOfDay: number; rushMinute: number }> {
  const bookedAt = at(anchor, SCHEDULED_BOOKED_AT_MINUTE);
  const clock = await loadClock(bookedAt);
  const state = await loadGateState(bookedAt);
  const schedule = availableSlots(state, state.scheduleConfig, state.weightBySlot, clock);

  if (!schedule.open) {
    throw new Error(
      `the rush could not book a pickup slot at minute ${SCHEDULED_BOOKED_AT_MINUTE}: ${schedule.message}`,
    );
  }
  const slot = schedule.slots[0];
  if (slot === undefined) {
    throw new Error(
      `the rush was offered no pickup slot at minute ${SCHEDULED_BOOKED_AT_MINUTE}. The anchor is too ` +
        'close to the end of the restaurant\'s day for order-ahead to have anywhere to go.',
    );
  }

  // Against the ANCHOR's minute, not this one, because every other number in
  // the script is. One business day is assumed here and everywhere else in
  // this file — see `RUSH_ANCHOR`.
  const openedAt = await loadClock(anchor);
  return { day: schedule.day, minuteOfDay: slot.minuteOfDay, rushMinute: slot.minuteOfDay - openedAt.minuteOfDay };
}

async function buildCart(order: RushOrder, anchor: Date): Promise<Cart> {
  const composedAt = at(anchor, order.composedMinute ?? order.minute);
  // The menu as it was when the customer composed, which for exactly one
  // customer is not the menu it will be priced against. Read AT that instant,
  // so a staged price (P1-2) is resolved on the same reading the daypart is.
  const menu = await loadMenu(composedAt);
  // And the CLOCK they composed against (P1-1), which for the one customer who
  // composes early is not the clock their order is placed on either.
  const clock = await loadClock(composedAt);
  let cart: Cart = EMPTY_CART;
  for (const [index, composition] of COMPOSITIONS[order.composition]!.entries()) {
    const added = addLine(menu, cart, `${order.label}-${index}`, composition, clock);
    if (!added.ok) {
      throw new Error(
        `${order.label} could not compose line ${index} at minute ${order.composedMinute ?? order.minute}: ` +
          added.errors.map((e) => e.message).join(' '),
      );
    }
    cart = added.cart;
  }
  return cart;
}

async function submit(
  order: RushOrder,
  anchor: Date,
  cart: Cart,
  slot: { day: string; minuteOfDay: number },
): Promise<RushAttempt> {
  const now = at(anchor, order.minute);
  const input = {
    cart,
    idempotencyKey: keyFor(order),
    now,
    customerName: order.label,
    // Optional on the real form and optional here (C-120): only the regulars
    // hand one over. It is what `earnForOrder` keys the punch card on and
    // what `queueReadyNotification` is gated on, so these five tickets are
    // also the ones that put rows in the P1-3 outbox.
    ...(order.phone === undefined ? {} : { customerPhone: order.phone }),
    // The punch card, spent (PRD 7 P1-1). Minted here rather than up front
    // because the token is bound to this attempt's own `idempotencyKey` and
    // to an instant ten minutes wide — a token issued at minute 0 for an
    // order placed at minute 5 would be fine, and one for minute 20 would
    // not, so it is simply made when it is used.
    ...(order.redeemsReward ? { verifiedPhoneToken: await verifiedTokenFor(order, now) } : {}),
    // Order ahead (P1-2, C-124). The slot the server itself offered, handed
    // straight back — never a minute this script worked out on its own.
    ...(order.ordersAhead ? { requestedForMinute: slot.minuteOfDay, requestedForDay: slot.day } : {}),
    // P1-8. Roughly a third of the rush pays at the counter, so the queue on
    // screen holds both kinds — a badge that is on every card is not a signal,
    // and one that is on none is not a demo. Derived from the arrival minute
    // so the mix is the same on every run.
    paidNow: order.minute % 3 !== 0,
  };

  // Two concurrent identical submissions for the double-tap; one otherwise.
  const results = order.doubleSubmit
    ? await Promise.all([placeOrder(input), placeOrder(input)])
    : [await placeOrder(input)];

  const [first, second] = results;
  if (!first!.ok) {
    const errors = first!.errors.map((e) => e.kind);
    if (!order.expectRefusal || !errors.includes(order.expectRefusal)) {
      throw new Error(
        `${order.label} was refused at minute ${order.minute} and should not have been: ${errors.join(', ')}`,
      );
    }
    return { label: order.label, minute: order.minute, outcome: 'refused', errors };
  }
  if (order.expectRefusal) {
    throw new Error(
      `${order.label} was accepted at minute ${order.minute} but should have been refused with ${order.expectRefusal}`,
    );
  }

  return {
    label: order.label,
    minute: order.minute,
    outcome: 'placed',
    orderId: first!.order.id,
    seq: first!.order.seq,
    errors: [],
    ...(second?.ok ? { replayedOrderId: second.order.id } : {}),
  };
}

async function move(
  orderId: string,
  step: KitchenStep,
  anchor: Date,
  label: string,
): Promise<void> {
  const now = at(anchor, step.at);
  if (step.step === 'refund') return refund(orderId, step, now, label);
  if (step.step === 'reverseRefund') return reverse(orderId, step, now, label);
  if (step.step === 'redeem') {
    const result = await redeemReward(orderId, now, cookFor(label));
    if (!result.ok) {
      throw new Error(`${label} could not redeem at minute ${step.at}: ${result.message}`);
    }
    return;
  }
  const action =
    step.step === 'advance'
      ? ({ kind: 'advance', actor: 'staff' } as const)
      : step.step === 'revert'
        ? ({ kind: 'revert', actor: 'staff', reason: step.reason } as const)
        : step.step === 'cancel'
          ? ({
              kind: 'cancel',
              actor: 'staff',
              reason: step.reason,
              ...(step.note === undefined ? {} : { note: step.note }),
            } as const)
          : ({ kind: 'abandon', actor: 'staff' } as const);

  // Whoever is on shift for this ticket. A script has no cookie, so the rush
  // passes the id directly — the same argument the screens fill from theirs.
  const result = await applyOrderAction(orderId, action, now, cookFor(label));
  if (!result.ok) {
    throw new Error(`${label} could not ${step.step} at minute ${step.at}: ${result.failure.message}`);
  }
}

/**
 * Send some of somebody's money back, through the real control (C-126).
 *
 * `requestRefund` and not two writes of its parts: the ask and the send are
 * one call for a person at the counter, and a rush that appended its own
 * `refund_requested` would prove the log's shape and nothing about the path
 * the receipt's button actually takes.
 *
 * THE DECLINE IS A PROVIDER, not a flag. `settleRefund` takes the processor as
 * a parameter precisely so the failure can be produced without a mode inside
 * it, so the refused one hands in a function that throws and everything after
 * that — the `refund_failed` row, the provider's own words on the receipt, the
 * entry on the exceptions list — is the product's real code path.
 */
async function refund(
  orderId: string,
  step: Extract<KitchenStep, { step: 'refund' }>,
  now: Date,
  label: string,
): Promise<void> {
  const result = await requestRefund(
    orderId,
    { amountCents: step.amountCents, reason: step.reason },
    now,
    cookFor(label),
    step.declined === undefined
      ? undefined
      : async () => {
          throw new Error(step.declined);
        },
  );

  // Both outcomes are scripted, so both are asserted here rather than only the
  // happy one: a decline that quietly succeeded would leave the exceptions
  // list empty and the demo would still look fine.
  if (step.declined === undefined) {
    if (!result.ok) {
      throw new Error(
        `${label}'s refund at minute ${step.at} did not go through: ${result.message}`,
      );
    }
    return;
  }
  if (result.ok || result.reason !== 'provider_failed') {
    throw new Error(
      `${label}'s refund at minute ${step.at} was supposed to be refused by the provider, and was ` +
        (result.ok ? 'sent' : `refused as ${result.reason}`),
    );
  }
}

/** Take back the newest settled refund on this order, through the real call. */
async function reverse(
  orderId: string,
  step: Extract<KitchenStep, { step: 'reverseRefund' }>,
  now: Date,
  label: string,
): Promise<void> {
  const latest = await prisma.orderEvent.findFirstOrThrow({
    where: { orderId, kind: 'refund' },
    orderBy: { at: 'desc' },
    select: { id: true },
  });
  const result = await reverseRefund(orderId, { refundId: latest.id, note: step.note }, now, cookFor(label));
  if (!result.ok) {
    throw new Error(`${label}'s refund reversal at minute ${step.at} failed: ${result.message}`);
  }
}

/**
 * Seed a fresh database and run the rush against it.
 *
 * Minute by minute, because ordering within a minute is the only thing that
 * matters: the pause has to be ON before the orders that bounce off it are
 * submitted, and the 86 has to have landed before the stranded cart is. So
 * everything that changes the RESTAURANT runs first, then the placements for
 * that minute go in together, then the kitchen's taps.
 *
 * `untilMinute` stops the clock early, which is the only way to see the thing
 * the whole product is about: a kitchen queue with live cards on it. Run to
 * the end and every order is terminal and `/kitchen` is empty — the right
 * RESULT, and a poor screenshot. Stopping is a truncation, not a variant: the
 * orders that had not arrived yet simply have not arrived.
 */
export async function runRush(
  anchor: Date = RUSH_ANCHOR,
  untilMinute: number = RUSH_END_MINUTE,
): Promise<RushResult> {
  await resetDatabase();
  await seedSampleMenu();
  // Shipping defaults, threshold included. The rush is supposed to FIT under
  // the throttle it ships with — and if it ever stops fitting, `submit` throws
  // naming the customer who bounced, rather than the script quietly delivering
  // twenty-eight orders and calling it thirty.
  //
  // Except for TWO switches, both shipping false and both on here for the
  // same reason: a demo cannot show a feature the seed leaves disabled.
  //
  // `loyaltyEnabled` ships false and every other seed leaves it false — the
  // invisibility requirement PRD 7 P0-1 asks for — but a demo of a restaurant
  // that runs a loyalty program has to have one running (C-120).
  //
  // `scheduledOrdersEnabled` is the same shape (C-124). Placement refuses a
  // `requestedForMinute` outright when it is off, so the two order-ahead
  // customers below would come back `slot_unavailable` and `submit` would
  // throw naming them — loudly, rather than a rush that quietly placed two
  // ASAP orders and called them scheduled. Nothing ELSE about the schedule is
  // overridden: 15-minute slots, a 20-minute lead and 20 points of prep per
  // slot are the shipping defaults, and the rush is supposed to fit under the
  // configuration it ships with — the same sentence this comment's first
  // paragraph makes about the throttle.
  await seedSettings({ loyaltyEnabled: true, scheduledOrdersEnabled: true });
  await seedStoreHours();
  await seedStaff(anchor);
  // The regulars, before the doors open. Throws rather than silently seeding
  // no members if the pepper is unset.
  await seedRushLoyalty(anchor);

  // Booked before the doors open, because the kitchen script for the two
  // order-ahead tickets is written against it and the loop below taps those
  // cards from minute 6 onwards.
  const slot = await resolveScheduledSlot(anchor);

  const attempts: RushAttempt[] = [];
  const orderIds = new Map<string, string>();
  const carts = new Map<RushOrder, Cart>();
  const kitchen: { orderId: string; label: string; step: KitchenStep }[] = [];

  for (let minute = 0; minute <= untilMinute; minute += 1) {
    // 1. The restaurant changes under the customers.
    if (minute === EIGHTY_SIX_MINUTE) {
      await prisma.modifierOption.update({
        where: { id: EIGHTY_SIXED_OPTION },
        data: { available: false },
      });
    }
    if (minute === PAUSE_MINUTE) {
      await prisma.restaurantSettings.update({
        where: { id: 'singleton' },
        data: { ordersPaused: true, pauseMessage: 'Slammed — back in a few minutes.' },
      });
    }
    if (minute === RESUME_MINUTE) {
      await prisma.restaurantSettings.update({
        where: { id: 'singleton' },
        data: { ordersPaused: false, pauseMessage: null },
      });
    }

    // 2. Carts get composed — for most customers, the minute they order.
    for (const order of RUSH_ORDERS) {
      if ((order.composedMinute ?? order.minute) === minute) {
        carts.set(order, await buildCart(order, anchor));
      }
    }

    // 3. This minute's checkouts, concurrently: the seq constraint is the
    //    thing under test, not the awaits.
    const arriving = RUSH_ORDERS.filter((order) => order.minute === minute);
    const placed = await Promise.all(
      arriving.map((order) => submit(order, anchor, carts.get(order)!, slot)),
    );
    for (const [index, attempt] of placed.entries()) {
      attempts.push(attempt);
      const order = arriving[index]!;
      if (attempt.outcome === 'placed') {
        orderIds.set(attempt.label, attempt.orderId!);
        const steps =
          typeof order.kitchen === 'function'
            ? order.kitchen(slot.rushMinute)
            : (order.kitchen ?? cadence(order.minute, order.slow));
        for (const step of steps) {
          kitchen.push({ orderId: attempt.orderId!, label: order.label, step });
        }
      }
    }

    // 4. The kitchen's taps for this minute, in the order they were scripted.
    for (const tap of kitchen.filter((t) => t.step.at === minute)) {
      await move(tap.orderId, tap.step, anchor, tap.label);
    }
  }

  const grouped = await prisma.order.groupBy({ by: ['status'], _count: true });
  const finalStatuses = Object.fromEntries(
    grouped.map((row) => [row.status, row._count]),
  ) as Record<OrderStatus, number>;

  return {
    anchor,
    end: at(anchor, untilMinute),
    scheduledSlotMinute: slot.rushMinute,
    untilMinute,
    attempts,
    orderIds,
    finalStatuses,
  };
}
