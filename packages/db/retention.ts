// Forgetting a customer (PRD 6 P0-4, C-091).
//
// Two callers, ONE write. The nightly sweep and the staff receipt's "forget
// this customer" do exactly the same thing to exactly the same columns — the
// only difference is which orders they select — so they share `forgetOrders`
// below. A fifth column that turns out to be identity is then one edit, not
// two, and the sweep cannot quietly diverge from the button.
//
// THE LOYALTY MEMBER IS A SIBLING, NOT A PARAMETER (C-105). Both entry points
// also delete a `LoyaltyMember`, but that is a different verb on a different
// table: the order is SCRUBBED because it is a snapshot of a sale and has to
// survive, and the member is DELETED because it is nothing but who somebody
// is. Two operations that happen together, not one operation with a filter.
//
// THIS UPDATEs A SNAPSHOT TABLE, which is the one thing this project's rules
// make hardest (CLAUDE.md, the snapshot rule). It holds because of WHAT it
// touches: a name, a phone, and free text the customer typed. Not one column
// the receipt's arithmetic or the report's buckets depend on. The gate for
// that claim is `retention.test.ts`'s byte-identical assertion, and the PRD
// says it plainly — if that test cannot be made to pass, the sweep is wrong,
// not the test.
import { FORGOTTEN_CUSTOMER_NAME, cutoffDaysBefore, normalizePhone } from '@countertop/core';
import { Prisma, prisma } from './index';
import { hasLoyaltyPepper, phoneDigest } from './loyalty';

/** What identity looks like once it is gone. `customerName` is a placeholder
 *  rather than a null because the column is `NOT NULL` and eleven screens
 *  render it unguarded. */
const FORGOTTEN = {
  customerName: FORGOTTEN_CUSTOMER_NAME,
  customerPhone: null,
  orderNote: null,
} as const;

/**
 * Orders that still have something to forget.
 *
 * Wrapped around the caller's own filter so a repeated sweep reports an honest
 * zero instead of re-counting rows it scrubbed last night. Four conditions
 * because the line note is on a different table and an order can be half done
 * only if something failed mid-transaction — which is precisely when an honest
 * count matters.
 */
const stillHasIdentity = (where: Prisma.OrderWhereInput): Prisma.OrderWhereInput => ({
  ...where,
  OR: [
    { customerName: { not: FORGOTTEN_CUSTOMER_NAME } },
    { customerPhone: { not: null } },
    { orderNote: { not: null } },
    { lines: { some: { note: { not: null } } } },
  ],
});

/**
 * Strip identity from every order matching `where`.
 *
 * ONE TRANSACTION over two tables, because `OrderLine.note` is the same class
 * of data as `orderNote` — free text the customer typed, which is where "for
 * Dana's birthday" lives — and a forget that leaves half of it behind is a
 * forget that is a lie. The PRD names three columns; this is four, and the
 * fourth is deliberate.
 *
 * Nothing is written to the event log. That is a recorded ceiling rather than
 * an oversight: an `OrderEvent` kind for this would be a new enum value and a
 * widened CHECK, and the sweep would write one row per order per night for the
 * rest of the restaurant's life. Who ran the sweep is a deployment question;
 * who tapped the button is not recorded at all, and `docs/RETENTION.md` says
 * so out loud.
 */
async function forgetOrders(where: Prisma.OrderWhereInput): Promise<number> {
  // LINES FIRST, and the order is load-bearing: both statements select on
  // `stillHasIdentity`, and scrubbing the orders first would leave every line
  // note behind because the orders no longer match.
  const [, orders] = await prisma.$transaction([
    prisma.orderLine.updateMany({
      where: { order: stillHasIdentity(where), note: { not: null } },
      data: { note: null },
    }),
    prisma.order.updateMany({ where: stillHasIdentity(where), data: FORGOTTEN }),
  ]);
  return orders.count;
}

/**
 * The job: every order past the window (P0-4).
 *
 * `now` is a parameter, like everywhere else in this repo that decides
 * something from a clock — this is the one job that DESTROYS data from a clock
 * reading, so the reading is an argument its test can freeze.
 *
 * The window is read from the settings row and `findUniqueOrThrow` is
 * deliberate: a missing row must not become a default that forgets everything
 * or nothing. Same reason `loadSettings` throws rather than defaulting to 0%
 * tax.
 */
export async function sweepRetention(
  now: Date,
): Promise<{ retentionDays: number; forgotten: number; members: number }> {
  const { retentionDays } = await prisma.restaurantSettings.findUniqueOrThrow({
    where: { id: 'singleton' },
    select: { retentionDays: true },
  });
  const cutoff = cutoffDaysBefore(now, retentionDays);
  const forgotten = await forgetOrders({ placedAt: { lt: cutoff } });
  // The member is selected on its OWN clock, not on the orders just scrubbed
  // — see `forgetInactiveMembers`.
  const members = await forgetInactiveMembers(cutoff);
  return { retentionDays, forgotten, members };
}

/**
 * Delete every member who has done nothing for the whole retention window
 * (P0-5, C-105).
 *
 * A REAL DELETE, and the `onDelete: Cascade` on `LoyaltyEvent.memberId` takes
 * the ledger with it. That is the asymmetry PRD 7 argues for at length: the
 * order event log is a financial record and its trigger blocks DELETE, while a
 * loyalty balance is an entitlement held for the customer's benefit, and
 * refusing to delete one is the behaviour the forget path exists to prevent.
 * `displayName` and `phoneLast4` are the same class of fact as the name on the
 * order, so they age out on the same window.
 *
 * SELECTED ON `lastActivityAt`, NOT ON THE ORDERS JUST SCRUBBED, and the
 * difference matters: a customer who ordered 400 days ago and again last week
 * has one order scrubbed and a live punch card, and deleting their member row
 * because of the old order would destroy a balance they are about to spend.
 * The member's own clock is the only honest selector.
 *
 * `loyaltyExpiryDays <= retentionDays` is what makes this safe to run beside
 * the expiry sweep rather than in some particular order: a member cannot reach
 * this window still holding points, because their balance expired first. The
 * CHECK in this item's migration is that guarantee, and it is a constraint
 * rather than a comment for exactly this reason.
 */
async function forgetInactiveMembers(cutoff: Date): Promise<number> {
  const { count } = await prisma.loyaltyMember.deleteMany({
    where: { lastActivityAt: { lt: cutoff } },
  });
  return count;
}

/**
 * Delete the member enrolled under this order's phone, if there is one
 * (P0-5, C-105).
 *
 * THE PHONE IS THE ONLY WAY IN, and it is hashed before it reaches a `where`,
 * exactly as `memberByPhone` does — this file must not become the second place
 * a plaintext number is matched against a column. It is also why this has to
 * run BEFORE the scrub: `forgetOrders` nulls `customerPhone`, and after that
 * there is nothing left to key the member on.
 *
 * NO PEPPER, NO MEMBER TO FIND. A rotated or unset `LOYALTY_PHONE_PEPPER`
 * makes every stored digest unreachable by construction (C-101), so this
 * reports zero rather than pretending; the order is still scrubbed, and
 * `docs/RETENTION.md` carries the manual `DELETE` for that case.
 *
 * `deleteMany` rather than `delete`: not being a member is the ordinary case,
 * not an error.
 */
async function forgetMemberByPhone(phone: string | null): Promise<number> {
  if (!phone || !hasLoyaltyPepper()) return 0;
  const normalized = normalizePhone(phone);
  if (!normalized) return 0;
  const { count } = await prisma.loyaltyMember.deleteMany({
    where: { phoneDigest: phoneDigest(normalized.digits) },
  });
  return count;
}

/**
 * The other half: one order, now, from the staff receipt.
 *
 * No window and no clock — a customer who asks to be forgotten is not asking
 * to be forgotten in eleven months. Returns whether anything was actually
 * stripped, so the screen can tell "done" from "there was nothing left to
 * remove" and from an id that matches no order.
 */
export async function forgetOrderCustomer(
  orderId: string,
): Promise<{ ok: boolean; forgotten: number; members: number }> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { customerPhone: true },
  });
  if (!order) return { ok: false, forgotten: 0, members: 0 };
  // MEMBER FIRST, and the order is load-bearing for the second time in this
  // file: the phone is the key, and the scrub below removes it.
  const members = await forgetMemberByPhone(order.customerPhone);
  return { ok: true, forgotten: await forgetOrders({ id: orderId }), members };
}
