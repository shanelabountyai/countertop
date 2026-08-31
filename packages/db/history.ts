// Staff order history (post-queue receipt lookup).
//
// The kitchen queue (`loadQueue`) only ever loads the OPEN statuses — that is
// its whole point, so a search there can't answer "what did we serve Dana on
// Tuesday" once her order has left the live queue. This is the other half:
// every status, unbounded by `QUEUE_STATUSES`, for the walk-up dispute a day
// later rather than the one happening right now.
//
// Same shape as everything else that reads back a placed order: `ORDER_RECEIPT`,
// never a menu `include` (CLAUDE.md, the snapshot rule).
import { Prisma, prisma } from './index';
import { ORDER_RECEIPT, type OrderReceipt } from './placement';

/** A history search is a lookup, not a report — cap it so a bare search box
 *  cannot become an accidental "load every order this restaurant has ever
 *  taken" query. */
const HISTORY_RESULT_LIMIT = 50;

/**
 * A search term as a LITERAL, not a pattern.
 *
 * `contains` compiles to SQL `LIKE`, and Prisma passes the term through
 * unescaped — so a typed `%` searches for everything rather than for a percent
 * sign, and every search box in the world eventually receives one. Backslash
 * first, because it is the escape character being introduced.
 */
const likeLiteral = (term: string): string => term.replace(/[\\%_]/g, '\\$&');

/**
 * Builds the `where` a history search runs — pulled out as its own function
 * because it is the one piece of this file with a decision in it (name vs.
 * order number), and a decision is what gets a test, not a query.
 *
 * A bare number matches by `seq` ALONE, deliberately: `seq` resets every
 * business day (`packages/db/placement.ts`), so "#047" is not a unique key
 * across history the way it is on today's queue (`matchesLookup`, which never
 * has to consider a second day). Matching on `seq` alone can surface more than
 * one order for an old number — shown as a list, dated, for a person to pick
 * from — rather than silently narrowing to the wrong day's #047.
 */
export function historyWhere(query: string): Prisma.OrderWhereInput {
  const trimmed = query.trim();
  if (trimmed === '') return {};

  const name = { contains: likeLiteral(trimmed), mode: 'insensitive' } as const;
  const digits = trimmed.replace(/^#/, '');
  if (/^\d+$/.test(digits)) {
    return { OR: [{ seq: Number(digits) }, { customerName: name }] };
  }
  return { customerName: name };
}

/** Every order matching the search, newest first — every status, not just the
 *  ones still open. */
export function searchOrderHistory(query: string): Promise<OrderReceipt[]> {
  return prisma.order.findMany({
    where: historyWhere(query),
    orderBy: { placedAt: 'desc' },
    take: HISTORY_RESULT_LIMIT,
    ...ORDER_RECEIPT,
  });
}

/** One order's full receipt, by its internal id — a staff-only lookup, so the
 *  id itself is fine to use directly (unlike the customer's `statusToken`,
 *  which exists because a URL that leaves the building must not be a key). */
export function findOrderByIdForStaff(id: string): Promise<OrderReceipt | null> {
  return prisma.order.findUnique({ where: { id }, ...ORDER_RECEIPT });
}
