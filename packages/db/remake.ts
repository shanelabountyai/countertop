// The remake link (PRD 3 P0-3, C-066).
//
// 6:52pm. Ivy is back at the counter with #012 — a torta she ordered with
// onions OFF, and a note saying "cut it in half please", and she got neither.
// Bea remakes it. Before this, the system offered nothing: the till loses
// $13.75 with no record, the report counts one torta sold at full price, the
// attach rate records "Onions — attached" on an order that said NO onions, and
// the only trace is Bea telling the GM at close.
//
// DECISION 7 of 2026-09-02 — a remake is a REAL SECOND ORDER. The PRD asked
// whether it should be that or an adjustment on the original, and named the
// tension as "the kitchen needs a ticket; the report needs a link". They do
// not pull evenly: either shape gives the report its number, and only this one
// gives the kitchen something to cook. A remake nobody is told to make is
// exactly the transcription failure this product exists to kill.
//
// So: a new order with its own number, its own ticket, its own age; the
// original's lines copied verbatim; a `remake` event pointing back; and a full
// comp, so nobody is ever shown "$13.75 due" for food nobody will be charged
// for.
import {
  adjustmentEvent,
  businessDayOf,
  MAX_ORDER_NOTE_LENGTH,
  type AdjustmentReason,
  type AdjustmentRefusalReason,
  remakeEvent,
} from '@countertop/core';
import { prisma } from './index';
import { loadSettings } from './menu';
import {
  derivedIdempotencyKey,
  eventRow,
  newStatusToken,
  ORDER_RECEIPT,
  takingNextOrderNumber,
  type OrderReceipt,
} from './placement';

export type RemakeResult =
  | { ok: true; order: OrderReceipt; replayed: boolean }
  | { ok: false; reason: AdjustmentRefusalReason | 'order_not_found'; message: string };

/**
 * Cook it again, on the house, with its own ticket.
 *
 * THE LINES ARE COPIED FROM THE ORIGINAL ORDER'S SNAPSHOT, never re-priced off
 * the live menu. Two reasons, and both are the snapshot rule: the remake has
 * to be the same food (Ivy's "NO onions" and her "cut it in half please" are
 * the entire point — a remake that loses them goes out wrong twice), and it
 * has to be the same money, so the comp beside it cancels exactly what was
 * charged. A menu repriced since 6:00pm must not change what a 6:52pm remake
 * is worth.
 *
 * `businessDay` is TODAY's, not the original's. A remake cooked tonight is
 * tonight's ticket and takes tonight's number; an order placed before midnight
 * and remade after it is two days' work, honestly recorded as such.
 */
export async function remakeOrder(
  originalId: string,
  reason: AdjustmentReason,
  now: Date,
  note?: string,
  /** Who made the call (C-086). */
  staffId?: string | null,
): Promise<RemakeResult> {
  const original = await prisma.order.findUnique({
    where: { id: originalId },
    select: {
      customerName: true,
      customerPhone: true,
      orderNote: true,
      subtotalCents: true,
      taxCents: true,
      taxRatePpm: true,
      totalCents: true,
      prepWeight: true,
      lines: {
        orderBy: { lineNumber: 'asc' },
        include: { options: { orderBy: { sortOrder: 'asc' } } },
      },
      // How many remakes this order already has. It is part of the idempotency
      // key below, so a second remake is possible and a double-tap is not.
      _count: { select: { remadeBy: true } },
    },
  });
  if (!original) {
    return { ok: false, reason: 'order_not_found', message: 'That order could not be found.' };
  }

  // The comp, built by the one function that validates and constructs together
  // (C-065). The new order has no events yet, so the whole total is adjustable
  // — and asking `adjustmentEvent` rather than hand-writing the row is what
  // keeps "an adjustment never exceeds the order" true on this path too.
  const comp = adjustmentEvent(
    { totalCents: original.totalCents, events: [] },
    { kind: 'comp', reason, ...(note ? { note } : {}) },
    now,
  );
  if (!comp.ok) return comp;

  const { timezone } = await loadSettings();
  const businessDay = businessDayOf(now, timezone);

  // Derived, not random: a double-tapped Remake button derives the SAME key
  // and loses on the unique constraint, exactly as a double-submitted checkout
  // does (P0-10). The remake COUNT is in the key so a genuine second remake —
  // the replacement also went out wrong — derives a different one and is
  // allowed. Two concurrent taps both read the same count and contend on the
  // constraint, which is the mechanism; nothing here checks-then-writes.
  const idempotencyKey = derivedIdempotencyKey(
    `remake:${originalId}:${original._count.remadeBy}`,
  );
  const existing = await prisma.order.findUnique({
    where: { idempotencyKey },
    ...ORDER_RECEIPT,
  });
  if (existing) return { ok: true, order: existing, replayed: true };

  const order = await takingNextOrderNumber(
    businessDay,
    (seq) =>
      prisma.order.create({
        data: {
          businessDay,
          seq,
          customerName: original.customerName,
          customerPhone: original.customerPhone,
          orderNote: remakeNote(original.orderNote, note),
          status: 'placed',
          placedAt: now,
          statusChangedAt: now,
          subtotalCents: original.subtotalCents,
          taxCents: original.taxCents,
          taxRatePpm: original.taxRatePpm,
          totalCents: original.totalCents,
          prepWeight: original.prepWeight,
          // The quote columns stay NULL, and the schema already calls that
          // "no record" rather than zero. A remake was never quoted a ready
          // time — nobody promised Ivy eight minutes — and copying the
          // original's quote would put a stale promise into C-042's accuracy
          // grading as though it had been made tonight.
          idempotencyKey,
          statusToken: newStatusToken(),
          lines: {
            create: original.lines.map((line) => ({
              lineNumber: line.lineNumber,
              menuItemId: line.menuItemId,
              itemName: line.itemName,
              categoryName: line.categoryName,
              basePriceCents: line.basePriceCents,
              quantity: line.quantity,
              unitPriceCents: line.unitPriceCents,
              lineTotalCents: line.lineTotalCents,
              note: line.note,
              options: {
                create: line.options.map((option) => ({
                  groupName: option.groupName,
                  optionName: option.optionName,
                  intensity: option.intensity,
                  appliedDeltaCents: option.appliedDeltaCents,
                  modifierOptionId: option.modifierOptionId,
                  sortOrder: option.sortOrder,
                })),
              },
            })),
          },
          events: {
            create: [
              // Placed by STAFF, not by a customer. The one place a remake's
              // placement event differs from a real one, and it is the honest
              // difference: Bea put this ticket on the line.
              eventRow(
                {
                  at: now,
                  kind: 'transition',
                  fromStatus: null,
                  toStatus: 'placed',
                  actor: 'staff',
                  reason: null,
                },
                staffId,
              ),
              eventRow(remakeEvent(now, originalId, reason), staffId),
              eventRow(comp.event, staffId),
            ],
          },
        },
        ...ORDER_RECEIPT,
      }),
    // Two taps genuinely in flight at once. Both read the same remake count,
    // derive the same key, and both miss the lookup above — so the CONSTRAINT
    // is what decides, and the loser reads the winner's order rather than
    // throwing. Exactly the shape placement uses for a double-submitted
    // checkout (P0-10): correctness never depends on the client behaving.
    async (target) => {
      if (!target.includes('idempotencyKey')) return null;
      return prisma.order.findUnique({ where: { idempotencyKey }, ...ORDER_RECEIPT });
    },
  );

  // A replay comes back with the key already on it; a fresh create is the only
  // one that took a new number.
  return { ok: true, order, replayed: false };
}

/**
 * What the cook reads on the remake's ticket.
 *
 * THE STAFF NOTE HAS TO REACH THE LINE, and getting this wrong once already
 * shipped in this item: the field was wired into the comp's `detail`, where
 * nothing on the kitchen card renders it. Ivy's whole complaint is that "no
 * onions" and "cut it in half" were lost — a remake that loses the correction
 * as well goes out wrong a second time, which is the failure this product
 * exists to kill.
 *
 * The customer's own note is kept and comes FIRST, because it is still true;
 * the correction is appended and marked. Capped at the column width rather
 * than allowed to overflow, and the correction wins the truncation fight — if
 * something has to be cut it is the note the kitchen already got wrong once.
 */
function remakeNote(customerNote: string | null, staffNote?: string): string | null {
  const correction = staffNote?.trim();
  if (!correction) return customerNote;
  const marked = `REMAKE: ${correction}`;
  if (!customerNote) return marked.slice(0, MAX_ORDER_NOTE_LENGTH);
  const combined = `${marked} · ${customerNote}`;
  return combined.slice(0, MAX_ORDER_NOTE_LENGTH);
}
