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
import type {
  EventActor,
  OrderEventKind,
  OrderStatus,
} from '@countertop/core';
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

/**
 * One order's activity log, for the staff receipt (C-086).
 *
 * The append-only log has had no reader on any screen since C-003 — it is
 * read by the report's time-in-state tally and by tests, and by nothing a
 * person looks at. Adding a name to every row and then rendering it nowhere
 * would have shipped the column and not the feature, which is the pattern
 * this backlog has already had to come back and fix three times (the operator
 * settings, the intensity surcharge, payment state).
 *
 * `staff` is a join to a NAME, and the snapshot rule does not object: a person
 * is not a menu row, nobody's name is part of the money, and a cook who
 * changes their display name should change on every row they wrote. That is
 * the opposite of a price, which must never move under a placed order.
 */
export type ActivityEntry = {
  at: Date;
  kind: OrderEventKind;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus | null;
  actor: EventActor;
  reason: string | null;
  /** Money this event moved, in cents (C-065). Null on everything that moved
   *  none — the same CHECK the database enforces. The receipt is where a
   *  disputed comp is read, and "Adjusted" with no figure on it is the row
   *  that starts the argument rather than settling it. */
  amountCents: number | null;
  /** Null where the actor was not staff, and null on every event written
   *  before C-086 — an honest "we did not record this". */
  staffName: string | null;
  /** The order this event points at (C-066): on a `remake`, the one it
   *  replaces. The NUMBER as well as the id, because "Remade from #012" is
   *  what a person reads and a receipt that names an order nobody can click
   *  sends them back to the search box. */
  relatedOrder: { id: string; seq: number } | null;
  /**
   * What somebody typed, out of the event's `detail` payload (PRD 2 P0-4).
   *
   * The column has been written since C-003 — the cancel note goes in it — and
   * read by nothing a person looks at, which is the exact mistake C-066 had to
   * come back and fix on the remake's correction. A revert's optional text has
   * only one place it could ever be read, and this is it, so the note is
   * lifted out here rather than a second channel being invented for it.
   *
   * Lifted, not passed through: `detail` also carries a mismatch payload and a
   * refund's provider, and a receipt has no business rendering either.
   */
  note: string | null;
};

export async function loadOrderActivity(orderId: string): Promise<ActivityEntry[]> {
  const events = await prisma.orderEvent.findMany({
    where: { orderId },
    orderBy: { at: 'asc' },
    select: {
      at: true,
      kind: true,
      fromStatus: true,
      toStatus: true,
      actor: true,
      reason: true,
      amountCents: true,
      detail: true,
      staff: { select: { name: true } },
      relatedOrder: { select: { id: true, seq: true } },
    },
  });
  return events.map(({ staff, detail, ...event }) => ({
    ...event,
    staffName: staff?.name ?? null,
    note: readNote(detail),
  }));
}

/**
 * The orders that REPLACED this one (C-066).
 *
 * The reverse of the link. It is stored in one direction only — on the
 * remake's own event, naming the original — because one fact in two places is
 * two things that can disagree; this is the query that pays for that choice,
 * and it costs an index lookup on `OrderEvent.relatedOrderId`.
 *
 * A list rather than one row: a remake can itself go out wrong, and the second
 * remake is a third order. The receipt shows them all, in order.
 */
export async function loadRemakesOf(orderId: string): Promise<{ id: string; seq: number }[]> {
  const events = await prisma.orderEvent.findMany({
    where: { kind: 'remake', relatedOrderId: orderId },
    orderBy: { at: 'asc' },
    select: { order: { select: { id: true, seq: true } } },
  });
  return events.map((event) => event.order);
}

/** `detail.note` when there is one, and null for every other payload shape.
 *  `detail` is untyped JSON, so this is the one place that asserts what is in
 *  it rather than every caller re-guessing. */
function readNote(detail: Prisma.JsonValue | null): string | null {
  if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) return null;
  const note = (detail as Prisma.JsonObject).note;
  return typeof note === 'string' && note !== '' ? note : null;
}
