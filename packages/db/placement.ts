// Placing an order (P0-3, P0-8, P0-9, P0-10). The one write path that turns a
// cart into rows.
//
// Everything it decides, it decides with packages/core: the prices come from
// the price engine, the validity from THE orderability function, the business
// day from the restaurant's timezone, the `placed` event from the ONE status
// module. This file's own job is the three things only a database can do —
// take the next order number without racing, refuse a second order for the
// same idempotency key, and write the snapshot and its event atomically.
import { randomBytes } from 'node:crypto';
import {
  buildOrderSnapshot,
  businessDayOf,
  checkClientTotal,
  normalizeIdentity,
  placementEvent,
  reviewCart,
  type Cart,
  type CartError,
  type CartReview,
  type IdentityViolation,
  type OrderEventDraft,
} from '@countertop/core';
import { Prisma, prisma } from './index';
import { loadMenu, loadSettings } from './menu';

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
  },
} as const satisfies Prisma.OrderDefaultArgs;

export type OrderReceipt = Prisma.OrderGetPayload<typeof ORDER_RECEIPT>;

export type PlacementError =
  | IdentityViolation
  | CartError
  | { kind: 'empty_cart'; message: string }
  | { kind: 'idempotency_key_required'; message: string }
  | { kind: 'price_changed'; message: string };

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
};

export type PlacementResult =
  | { ok: true; order: OrderReceipt; replayed: boolean }
  | { ok: false; errors: PlacementError[]; review: CartReview };

/**
 * How many order numbers to try before giving up. Each retry means another
 * placement won that number in the microseconds since we read the maximum, so
 * this is a concurrency depth, not a delay — 25 simultaneous checkouts is
 * already a harder rush than the throttle (P0-6, default 25 open orders) lets
 * happen.
 */
const MAX_SEQ_ATTEMPTS = 25;

/** ≥128 bits, so order numbers cannot be walked into someone else's status
 *  page (P0-8, hardened in P1-5). 24 bytes = 192 bits. */
const newStatusToken = (): string => randomBytes(24).toString('base64url');

/** The unique constraint a P2002 names, or null if it was some other error. */
function uniqueViolationTarget(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return null;
  }
  // `target` is the field list for a Prisma-generated index and the index name
  // for a hand-written one; both spell the column, so match on the text.
  return JSON.stringify(error.meta?.target ?? '');
}

/** One `OrderEvent` row from an engine draft. Exported because every writer of
 *  the append-only log — placement here, the queue's transitions in
 *  `transitions.ts` — must spell a row the same way. */
export const eventRow = (draft: OrderEventDraft) => ({
  at: draft.at,
  kind: draft.kind,
  fromStatus: draft.fromStatus,
  toStatus: draft.toStatus,
  actor: draft.actor,
  reason: draft.reason,
  ...(draft.detail === undefined ? {} : { detail: draft.detail as Prisma.InputJsonObject }),
});

export const findOrderByIdempotencyKey = (idempotencyKey: string): Promise<OrderReceipt | null> =>
  prisma.order.findUnique({ where: { idempotencyKey }, ...ORDER_RECEIPT });

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

  const [menu, settings] = await Promise.all([loadMenu(), loadSettings()]);
  const review = reviewCart(menu, cart, settings.taxRatePpm);
  const identity = normalizeIdentity(input);
  const errors: PlacementError[] = identity.ok ? [] : [...identity.violations];

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

  if (errors.length > 0 || !identity.ok) return { ok: false, errors, review };

  // ponytail: the re-check above and the write below are not one transaction,
  // so an 86 landing in the milliseconds between them is snapshotted anyway.
  // Deliberate: that order is indistinguishable from one placed a second
  // before the 86, which no isolation level can prevent either, and the
  // operational answer already exists — staff cancel it with reason
  // `out_of_item` (C-004). Locking the menu rows for every checkout would buy
  // a millisecond of a window that stays open for minutes regardless.
  const snapshot = buildOrderSnapshot(menu, cart, settings.taxRatePpm);
  const businessDay = businessDayOf(now, settings.timezone);

  // The server's number is the answer; the client's is evidence (P0-2).
  const mismatch =
    input.clientTotalCents === undefined
      ? null
      : checkClientTotal(snapshot.totalCents, input.clientTotalCents);
  const events: OrderEventDraft[] = [placementEvent(now)];
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

  for (let attempt = 0; attempt < MAX_SEQ_ATTEMPTS; attempt += 1) {
    // Read the maximum fresh on every attempt: a retry only happens because
    // someone else took the number, so a cached maximum would collide again.
    const highest = await prisma.order.aggregate({
      where: { businessDay },
      _max: { seq: true },
    });

    try {
      const order = await prisma.order.create({
        data: {
          businessDay,
          seq: (highest._max.seq ?? 0) + 1,
          ...identity.identity,
          status: 'placed',
          placedAt: now,
          statusChangedAt: now,
          subtotalCents: snapshot.subtotalCents,
          taxCents: snapshot.taxCents,
          taxRatePpm: snapshot.taxRatePpm,
          totalCents: snapshot.totalCents,
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
          events: { create: events.map(eventRow) },
        },
        ...ORDER_RECEIPT,
      });
      return { ok: true, order, replayed: false };
    } catch (error) {
      const target = uniqueViolationTarget(error);
      if (target === null) throw error;

      // Two double-taps racing: the loser reads the winner's order and returns
      // it, which is the same answer the fast path gives.
      if (target.includes('idempotencyKey')) {
        const winner = await findOrderByIdempotencyKey(idempotencyKey);
        if (winner) return { ok: true, order: winner, replayed: true };
        throw error;
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
