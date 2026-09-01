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
  EMPTY_CART,
  instantMinutesAfter,
  type CancelReason,
  type Cart,
  type Composition,
  type OrderStatus,
} from '@countertop/core';
import { prisma } from './index';
import { loadMenu } from './menu';
import { derivedIdempotencyKey, placeOrder } from './placement';
import { applyOrderAction } from './transitions';
import { resetDatabase, seedSampleMenu, seedSettings, seedStoreHours } from './testing/index';

/** Noon in Los Angeles on a fixed date, so the whole rush — including its
 *  45-minute tail — falls inside one business day and one report hour whatever
 *  timezone the process runs under. */
export const RUSH_ANCHOR = new Date(Date.UTC(2026, 6, 14, 19, 0, 0));

/** How long the script keeps running after the last arrival: the kitchen tail,
 *  long enough for the no-show to age past the third flag (30 min). */
export const RUSH_END_MINUTE = 45;

/** The option that runs out mid-rush, and the minute it does. */
export const EIGHTY_SIXED_OPTION = 'guacamole';
export const EIGHTY_SIX_MINUTE = 8;

export const PAUSE_MINUTE = 15;
export const RESUME_MINUTE = 18;

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
  | { at: number; step: 'abandon' };

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
  /** Replaces the default cadence outright. */
  kitchen?: KitchenStep[];
  /** Two concurrent submissions carrying the SAME idempotency key. */
  doubleSubmit?: true;
  /** This attempt is SUPPOSED to fail, with this error kind. Anything else
   *  refused is a defect, and `runRush` throws rather than reporting a rush
   *  that quietly lost orders. */
  expectRefusal?: 'option_unavailable' | 'ordering_closed';
  /** A second attempt by the same customer after a refusal. */
  retryOf?: string;
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
  { label: 'Ada Nkemelu', minute: 0, composition: 0 },
  { label: 'Ben Sorensen', minute: 0, composition: 1 },
  { label: 'Cleo Vance', minute: 1, composition: 8 },

  // UGLY CASE 3 — the no-show. Cooked fast, then nobody comes: ready at
  // minute 7 and still on the shelf 33 minutes later, past all three
  // no-show flags, when staff close it out.
  {
    label: 'Cass Iverson',
    minute: 1,
    composition: 3,
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
  {
    label: 'Owen Brandt',
    minute: 2,
    composition: 0,
    kitchen: [
      { at: 3, step: 'advance' },
      { at: 5, step: 'advance' },
      { at: 9, step: 'cancel', reason: 'out_of_item', note: 'Out of guacamole, called them' },
    ],
  },

  { label: 'Elin Haugen', minute: 3, composition: 4 },
  { label: 'Fitz Okonkwo', minute: 3, composition: 5 },
  { label: 'Gia Moretti', minute: 4, composition: 6 },

  // UGLY CASE 2 — the wrong card advanced, and undone. Rae's ticket is marked
  // ready at minute 12 by a cook reaching across the pass for someone else's;
  // the mistake is caught a minute later and reverted. The revert is a LOGGED
  // event, never a delete — so the time-in-state tally below still knows this
  // order was in `preparing` twice.
  {
    label: 'Rae Sutton',
    minute: 4,
    composition: 7,
    kitchen: [
      { at: 5, step: 'advance' },
      { at: 7, step: 'advance' },
      { at: 12, step: 'advance' },
      { at: 13, step: 'revert', reason: 'advanced the wrong card' },
      { at: 16, step: 'advance' },
      { at: 19, step: 'advance' },
    ],
  },

  { label: 'Hal Brennan', minute: 5, composition: 9 },
  { label: 'Ivy Castellanos', minute: 5, composition: 10, slow: 2 },
  { label: 'Jonah Reddick', minute: 6, composition: 11 },
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
  { label: 'Vik Ramsay', minute: 14, composition: 10 },

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

async function buildCart(order: RushOrder): Promise<Cart> {
  // The menu as it was when the customer composed, which for exactly one
  // customer is not the menu it will be priced against.
  const menu = await loadMenu();
  let cart: Cart = EMPTY_CART;
  for (const [index, composition] of COMPOSITIONS[order.composition]!.entries()) {
    const added = addLine(menu, cart, `${order.label}-${index}`, composition);
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

async function submit(order: RushOrder, anchor: Date, cart: Cart): Promise<RushAttempt> {
  const input = {
    cart,
    idempotencyKey: keyFor(order),
    now: at(anchor, order.minute),
    customerName: order.label,
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

  const result = await applyOrderAction(orderId, action, now);
  if (!result.ok) {
    throw new Error(`${label} could not ${step.step} at minute ${step.at}: ${result.failure.message}`);
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
  await seedSettings();
  await seedStoreHours();

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
        carts.set(order, await buildCart(order));
      }
    }

    // 3. This minute's checkouts, concurrently: the seq constraint is the
    //    thing under test, not the awaits.
    const arriving = RUSH_ORDERS.filter((order) => order.minute === minute);
    const placed = await Promise.all(
      arriving.map((order) => submit(order, anchor, carts.get(order)!)),
    );
    for (const [index, attempt] of placed.entries()) {
      attempts.push(attempt);
      const order = arriving[index]!;
      if (attempt.outcome === 'placed') {
        orderIds.set(attempt.label, attempt.orderId!);
        for (const step of order.kitchen ?? cadence(order.minute, order.slow)) {
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

  return { anchor, end: at(anchor, untilMinute), untilMinute, attempts, orderIds, finalStatuses };
}
