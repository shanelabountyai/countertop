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
 * A business day the caller may filter on, or nothing.
 *
 * `businessDay` is `Char(10)` holding "YYYY-MM-DD" in the RESTAURANT's
 * timezone (schema.prisma), which is exactly what `<input type="date">`
 * submits — so the filter is string equality and there is no timezone
 * arithmetic anywhere in this path. Anything else is ignored rather than
 * refused: the only way to produce a malformed value is by hand-editing the
 * URL, the date input renders blank for one, and unfiltered results next to a
 * blank date box is the coherent answer.
 */
const businessDayFilter = (day: string): string | undefined =>
  /^\d{4}-\d{2}-\d{2}$/.test(day.trim()) ? day.trim() : undefined;

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
 *
 * `day` is the other half of that: once the list has shown which days a number
 * lands on, picking one is how you get to the single order. Sits beside the
 * term rather than inside it — top-level fields are ANDed by Prisma, so a day
 * narrows the `OR` instead of joining it.
 */
export function historyWhere(query: string, day = ''): Prisma.OrderWhereInput {
  const businessDay = businessDayFilter(day);
  const on = businessDay === undefined ? {} : { businessDay };

  const trimmed = query.trim();
  if (trimmed === '') return on;

  const name = { contains: likeLiteral(trimmed), mode: 'insensitive' } as const;
  const digits = trimmed.replace(/^#/, '');
  if (/^\d+$/.test(digits)) {
    return { ...on, OR: [{ seq: Number(digits) }, { customerName: name }] };
  }
  return { ...on, customerName: name };
}

/** Every order matching the search, newest first — every status, not just the
 *  ones still open. */
export function searchOrderHistory(query: string, day = ''): Promise<OrderReceipt[]> {
  return prisma.order.findMany({
    where: historyWhere(query, day),
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
