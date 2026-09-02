// Placing an order (P0-3, P0-8, P0-9, P0-10). The one write path that turns a
// cart into rows.
//
// Everything it decides, it decides with packages/core: the prices come from
// the price engine, the validity from THE orderability function, the business
// day from the restaurant's timezone, the `placed` event from the ONE status
// module. This file's own job is the three things only a database can do —
// take the next order number without racing, refuse a second order for the
// same idempotency key, and write the snapshot and its event atomically.
import { createHash, randomBytes } from 'node:crypto';
import {
  buildOrderSnapshot,
  businessDayOf,
  checkClientTotal,
  totalTampering,
  normalizeIdentity,
  paymentEvent,
  placementEvent,
  readyEstimate,
  reviewCart,
  type Cart,
  type CartError,
  checkoutGate,
  restaurantClock,
  type CartReview,
  type GateReason,
  type IdentityViolation,
  type OrderEventDraft,
  type TotalMismatch,
} from '@countertop/core';
import { Prisma, prisma } from './index';
import { loadGateState } from './gate';
import { loadMenu } from './menu';

/**
 * Everything a receipt, a confirmation and a kitchen ticket render — and
 * nothing from a menu table. Exported so every reader of a placed order uses
 * the same shape; the day one of them adds a menu `include` is the day the
 * snapshot rule quietly stops holding.
 */
export const ORDER_RECEIPT = {
  include: {
    lines: {
      orderBy: { lineNumber: 'asc' },
      include: { options: { orderBy: { sortOrder: 'asc' } } },
    },
    // The money events, so any holder of a receipt can ask `orderBalance` what
    // is still owed (C-064). Two scalars per event, not the whole row: a
    // receipt has no business carrying the actor or the detail payload, and
    // this is the shape `MoneyEvent` asks for.
    events: { select: { kind: true, amountCents: true } },
  },
} as const satisfies Prisma.OrderDefaultArgs;

export type OrderReceipt = Prisma.OrderGetPayload<typeof ORDER_RECEIPT>;

export type PlacementError =
  | IdentityViolation
  | CartError
  | { kind: 'empty_cart'; message: string }
  | { kind: 'idempotency_key_required'; message: string }
  | { kind: 'price_changed'; message: string }
  // The checkout gate refusing the order (P0-6). Carries the trigger, so the
  // screen can say "we open at 11:00" rather than a generic failure — and so
  // the seeded rush can assert WHICH gate bounced an order.
  | { kind: 'ordering_closed'; reason: GateReason; message: string };

export type PlacementInput = {
  cart: Cart;
  /** Client-generated, unique-constrained (P0-10). The constraint is the
   *  mechanism; the disabled submit button is UX. */
  idempotencyKey: string;
  /** The instant of placement. Passed in, never read here — the engine takes
   *  `now` as a parameter and so does its caller. */
  now: Date;
  customerName?: string | null | undefined;
  customerPhone?: string | null | undefined;
  orderNote?: string | null | undefined;
  /** What the browser thought the total was. Input to a mismatch LOG, never
   *  to the database (P0-2). */
  clientTotalCents?: number;
  /** P1-8. The mock provider took the money at checkout; false (and absent) is
   *  "pay at pickup", which is what the kitchen card flags. A BOOLEAN, not a
   *  `PaymentState`: `refunded` is something that happens to an order later,
   *  never something a checkout request may ask for. */
  paidNow?: boolean;
};

export type PlacementResult =
  | { ok: true; order: OrderReceipt; replayed: boolean }
  | {
      ok: false;
      errors: PlacementError[];
      review: CartReview;
      /**
       * P0-2's evidence on the path that used to swallow it (C-084).
       *
       * The mismatch is computed inside the write path below, which means a
       * request that tampered with the total AND failed validation returned
       * from here before anything looked at the client's number — recorded
       * nowhere at all. Returned rather than logged here because this function
       * has four callers and only one of them is behind a request; the
       * boundary decides what reaches a log.
       */
      mismatch: TotalMismatch | null;
    };

/**
 * How many order numbers to try before giving up. Each retry means another
 * placement won that number in the microseconds since we read the maximum, so
 * this is a concurrency depth, not a delay — 25 simultaneous checkouts is
 * already a harder rush than the throttle (P0-6, default 60 units of open prep
 * weight — roughly 22 orders of the seeded menu) lets happen.
 */
const MAX_SEQ_ATTEMPTS = 25;

/** ≥128 bits, so order numbers cannot be walked into someone else's status
 *  page (P0-8, hardened in P1-5). 24 bytes = 192 bits.
 *
 *  Exported at C-066: a remake is a real order and its customer watches it on
 *  a real status link, so it needs a real token. One generator, because "how
 *  many bits is a status token" must have exactly one answer. */
export const newStatusToken = (): string => randomBytes(24).toString('base64url');

/** The unique constraint a P2002 names, or null if it was some other error. */
function uniqueViolationTarget(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return null;
  }
  // `target` is the field list for a Prisma-generated index and the index name
  // for a hand-written one; both spell the column, so match on the text.
  return JSON.stringify(error.meta?.target ?? '');
}

/**
 * Take the next order number for a business day, contending on the UNIQUE
 * CONSTRAINT rather than on a check-then-write (CLAUDE.md's database rule).
 *
 * Extracted at C-066, when a remake became a second thing that needs an order
 * number. It is deliberately not left inline and copied: the whole point of
 * the rule is that nothing reads the maximum and then trusts it, and a second
 * hand-written copy of a retry loop is the obvious place for that to be got
 * subtly wrong. One loop, two callers — the same discipline as the one status
 * module and the one orderability function.
 *
 * `create` is handed a candidate number and does the insert. A collision on
 * `seq` or `statusToken` is the retry this exists to force; the maximum is
 * re-read on every attempt, because a retry only happens when somebody else
 * took the number and a cached maximum would collide again.
 *
 * `recover` is for a unique violation that is NOT a number collision and is
 * not an error either — placement's idempotency replay is the only one. It
 * returns a value to stop with, or null to rethrow.
 */
export async function takingNextOrderNumber<T>(
  businessDay: string,
  create: (seq: number) => Promise<T>,
  recover?: (target: string) => Promise<T | null>,
): Promise<T> {
  for (let attempt = 0; attempt < MAX_SEQ_ATTEMPTS; attempt += 1) {
    // Read the maximum fresh on every attempt: a retry only happens because
    // someone else took the number, so a cached maximum would collide again.
    const highest = await prisma.order.aggregate({
      where: { businessDay },
      _max: { seq: true },
    });

    try {
      return await create((highest._max.seq ?? 0) + 1);
    } catch (error) {
      const target = uniqueViolationTarget(error);
      if (target === null) throw error;

      if (recover) {
        const recovered = await recover(target);
        if (recovered !== null) return recovered;
      }

      // A seq or a statusToken collision: take the next number and a new
      // token. This is the retry the unique constraint exists to force —
      // never a check-then-write, which has a window between the two.
      if (!target.includes('seq') && !target.includes('statusToken')) throw error;
    }
  }

  throw new Error(
    `Could not take an order number for ${businessDay} in ${MAX_SEQ_ATTEMPTS} attempts`,
  );
}

/** One `OrderEvent` row from an engine draft. Exported because every writer of
 *  the append-only log — placement here, the queue's transitions in
 *  `transitions.ts` — must spell a row the same way. */
export const eventRow = (draft: OrderEventDraft, staffId?: string | null) => ({
  at: draft.at,
  kind: draft.kind,
  fromStatus: draft.fromStatus,
  toStatus: draft.toStatus,
  actor: draft.actor,
  // Null rather than absent, so the CHECK sees what it is meant to: money
  // events carry an amount and nothing else may.
  amountCents: draft.amountCents ?? null,
  providerRef: draft.providerRef ?? null,
  // The order this event points at (C-066). Null on everything but a `remake`.
  relatedOrderId: draft.relatedOrderId ?? null,
  // WHICH staff member, where `actor` says what KIND (C-086). Stamped ONLY on
  // an event the engine attributes to staff: the customer's placement and the
  // system's refund are not somebody's tap, and putting the cook who cancelled
  // an order onto the refund the engine wrote would be a name on a row that
  // person did not write. The refund's actor is the seam where that gets
  // revisited, and PRD 3 is where it belongs.
  staffId: draft.actor === 'staff' ? (staffId ?? null) : null,
  reason: draft.reason,
  ...(draft.detail === undefined ? {} : { detail: draft.detail as Prisma.InputJsonObject }),
});

export const findOrderByIdempotencyKey = (idempotencyKey: string): Promise<OrderReceipt | null> =>
  prisma.order.findUnique({ where: { idempotencyKey }, ...ORDER_RECEIPT });

/**
 * A UUID derived from a name, for the scripts (C-052, defect D3).
 *
 * The seed and the rush cannot use `randomUUID()`: the rush's key is load-
 * bearing logic — a retry must get a NEW key because it is a different order,
 * and the double-submit must get the SAME one — and a seed that writes
 * different keys every run stops being a fixture. They wrote `seed-order-0`
 * and `rush-Dana-11` instead, which is a guessable read handle on a real
 * database, and the deployed demo has a table full of them.
 *
 * Name-based, like a UUIDv5, so the same name always yields the same UUID and
 * two different names never collide in practice. SHA-256 rather than the
 * RFC's SHA-1 because it costs nothing here and is one less thing to defend;
 * the version nibble still says 5, which is the truthful one — this value is
 * derived from a name, not random, and pretending it is a v4 would be a lie
 * told to a regex.
 *
 * This is NOT a way to make a public key safe. It is how a trusted script
 * writes rows that look like every other row.
 */
export function derivedIdempotencyKey(name: string): string {
  const hex = createHash('sha256').update(`countertop:idempotency:${name}`).digest('hex');
  const variant = ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

/**
 * The customer's status page (C-014, P0-5, P0-8).
 *
 * The token is the ONLY handle on an order from outside the building: the
 * UUID never appears in a URL, and the order NUMBER deliberately is not a key
 * here — #047 is guessable, and a page keyed on it would let anyone read
 * today's orders by counting. Same `ORDER_RECEIPT` shape as the confirmation,
 * so the status page renders from the snapshot with zero menu joins.
 */
export const findOrderByStatusToken = (statusToken: string): Promise<OrderReceipt | null> =>
  prisma.order.findUnique({ where: { statusToken }, ...ORDER_RECEIPT });

/**
 * Place the cart.
 *
 * Order of operations matters and is deliberate:
 *
 *   1. The idempotency key FIRST. A retry returns the original order even if
 *      the menu has since changed under it — the customer's second tap must
 *      not be told their food is sold out when it is already being made
 *      (P0-10).
 *   2. Then re-price and re-validate against the live menu. This is the
 *      placement call site of the orderability function, and the second of the
 *      two server-side price computations P0-2 requires.
 *   3. Then one `create`: order, lines, options and the `placed` event in a
 *      single statement, so a snapshot can never exist without the event that
 *      says it was placed.
 */
export async function placeOrder(input: PlacementInput): Promise<PlacementResult> {
  const { cart, idempotencyKey, now } = input;

  // Before anything else, and before the menu is even read: a retry answers
  // out of the orders table, not out of today's menu.
  if (idempotencyKey !== '') {
    const existing = await findOrderByIdempotencyKey(idempotencyKey);
    if (existing) return { ok: true, order: existing, replayed: true };
  }

  const [menu, settings] = await Promise.all([loadMenu(), loadGateState(now)]);
  const review = reviewCart(menu, cart, settings.taxRatePpm);
  const identity = normalizeIdentity(input);
  const errors: PlacementError[] = identity.ok ? [] : [...identity.violations];

  // The gate, asked HERE and not only by the screen (P0-6). A pause that stops
  // the button but not the POST is not a pause — and this is the same function
  // the cart page calls, so the two can never disagree about why.
  //
  // Deliberately AFTER the idempotency replay above: a retry of an order that
  // is already on the grill must return that order, not be told the restaurant
  // has since closed. The gate is asked about NEW orders only.
  const gate = checkoutGate(settings, restaurantClock(now, settings.timezone));
  if (!gate.open) {
    errors.push({ kind: 'ordering_closed', reason: gate.reason, message: gate.message });
  }

  if (idempotencyKey === '') {
    errors.push({
      kind: 'idempotency_key_required',
      message: 'That order could not be read. Try again.',
    });
  }
  if (cart.lines.length === 0) {
    errors.push({ kind: 'empty_cart', message: 'Your cart is empty.' });
  }
  for (const line of review.lines) errors.push(...line.problems);
  if (review.needsPriceConfirmation) {
    errors.push({
      kind: 'price_changed',
      message: 'A price changed while you were ordering. Check the new total before placing.',
    });
  }

  if (errors.length > 0 || !identity.ok) {
    return { ok: false, errors, review, mismatch: totalTampering(review, input.clientTotalCents) };
  }

  // ponytail: the re-check above and the write below are not one transaction,
  // so an 86 landing in the milliseconds between them is snapshotted anyway.
  // Deliberate: that order is indistinguishable from one placed a second
  // before the 86, which no isolation level can prevent either, and the
  // operational answer already exists — staff cancel it with reason
  // `out_of_item` (C-004). Locking the menu rows for every checkout would buy
  // a millisecond of a window that stays open for minutes regardless.
  const snapshot = buildOrderSnapshot(menu, cart, settings.taxRatePpm);
  const businessDay = businessDayOf(now, settings.timezone);

  // What we are promising this customer (P1-4), off the SAME `settings` read
  // the gate above used — so the quote stored on the order is the one the
  // checkout screen showed, not a second reading of a queue that moved in
  // between. `openWeight` here excludes this order, which is right: the wait
  // is the work already in front of it.
  const quote = readyEstimate(settings);

  // The server's number is the answer; the client's is evidence (P0-2).
  const mismatch =
    input.clientTotalCents === undefined
      ? null
      : checkClientTotal(snapshot.totalCents, input.clientTotalCents);
  const events: OrderEventDraft[] = [placementEvent(now)];
  // The charge the mock provider took at checkout (C-085). The column alone
  // used to be the whole record, which meant half of all payments — the ones
  // taken here rather than at the counter — had no instant either. Recording
  // only the counter half would have made "every payment has a time" a claim
  // that is false for most orders.
  if (input.paidNow) events.push(paymentEvent(now, snapshot.totalCents, 'checkout'));
  if (mismatch) {
    events.push({
      at: now,
      kind: 'total_mismatch',
      fromStatus: null,
      toStatus: null,
      actor: 'customer',
      reason: 'client total did not match the server total',
      detail: { ...mismatch },
    });
  }

  return takingNextOrderNumber(
    businessDay,
    async (seq) => {
      const order = await prisma.order.create({
        data: {
          businessDay,
          seq,
          ...identity.identity,
          status: 'placed',
          placedAt: now,
          statusChangedAt: now,
          subtotalCents: snapshot.subtotalCents,
          taxCents: snapshot.taxCents,
          taxRatePpm: snapshot.taxRatePpm,
          totalCents: snapshot.totalCents,
          prepWeight: snapshot.prepWeight,
          quotedLowMinutes: quote.lowMinutes,
          quotedHighMinutes: quote.highMinutes,
          quotedOpenWeight: settings.openWeight,
          paymentState: input.paidNow ? 'paid' : 'unpaid',
          statusToken: newStatusToken(),
          idempotencyKey,
          lines: {
            create: snapshot.lines.map((line) => ({
              lineNumber: line.lineNumber,
              menuItemId: line.menuItemId,
              itemName: line.itemName,
              categoryName: line.categoryName,
              basePriceCents: line.basePriceCents,
              quantity: line.quantity,
              unitPriceCents: line.unitPriceCents,
              lineTotalCents: line.lineTotalCents,
              note: line.note,
              options: { create: line.options },
            })),
          },
          // Not point-free: `eventRow` takes a second argument now (C-086's
          // staff id) and `map` would hand it the index. Every event written
          // here is the customer's own — a placement, its charge, its
          // mismatch — so none of them is stamped anyway.
          events: { create: events.map((draft) => eventRow(draft)) },
        },
        ...ORDER_RECEIPT,
      });
      return { ok: true, order, replayed: false } as PlacementResult;
    },
    // Two double-taps racing: the loser reads the winner's order and returns
    // it, which is the same answer the fast path gives. Null means "not this
    // constraint" and lets the retry loop go on doing its job.
    async (target) => {
      if (!target.includes('idempotencyKey')) return null;
      const winner = await findOrderByIdempotencyKey(idempotencyKey);
      return winner ? ({ ok: true, order: winner, replayed: true } as PlacementResult) : null;
    },
  );
}
