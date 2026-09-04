// How each order status reads to a person.
//
// One map, because the kitchen queue's section headings and the report's
// time-in-state rows have to call the same state the same thing. A cook who
// reads "Ready for pickup" on the queue and "ready" on the report has to work
// out that they are the same row.
//
// A `Record<OrderStatus, …>`, so a new state cannot ship without a name — the
// same trick `STATUS_FACTS` uses, applied to the words.
import type {
  AdjustmentReason,
  CancelReason,
  EventActor,
  OrderEventKind,
  OrderStatus,
  PaymentState,
} from '@countertop/core';

export const STATUS_LABEL: Record<OrderStatus, string> = {
  placed: 'New',
  accepted: 'Accepted',
  preparing: 'Preparing',
  ready: 'Ready for pickup',
  picked_up: 'Picked up',
  cancelled: 'Cancelled',
  abandoned: 'No-show',
};

/**
 * The cancellation preset, in words.
 *
 * Here rather than in the queue since C-057, because the report now names the
 * same reasons the cancel buttons do — and a screen that says "Kitchen error"
 * beside a button that said something else is two names for one row. Staff
 * facing; the customer gets `CANCEL_EXPLANATION` on the status page, which is
 * deliberately different wording for a different audience.
 *
 * A `Record<CancelReason, …>`, so a sixth reason cannot ship without the
 * compiler asking what it reads as.
 */
export const CANCEL_REASON_LABEL: Record<CancelReason, string> = {
  out_of_item: 'Out of an item',
  too_busy: 'Too busy',
  customer_changed_mind: 'Customer changed their mind',
  kitchen_error: 'Kitchen error',
  other: 'Other',
};

/**
 * How each payment state reads to a person (P1-8).
 *
 * Here rather than in three components because the counter, the customer's
 * status page and the receipt all have to call the same fact the same thing —
 * "pay at pickup" on the card and "unpaid" on the receipt is two words for one
 * state, and the customer is the one who gets to be confused by it.
 */
export const PAYMENT_LABEL: Record<PaymentState, string> = {
  unpaid: 'Pay at pickup',
  paid: 'Paid',
  refunded: 'Refunded',
};

/**
 * What one entry in an order's log says, in a sentence (C-086).
 *
 * A `switch` over the event kind with no default, so a sixth kind cannot ship
 * without the compiler asking what it reads as — the same discipline
 * `STATUS_LABEL` applies to the states.
 *
 * The payment's two flavours come off the ACTOR rather than off `detail`: the
 * engine already records the customer's own tap at checkout as `customer` and
 * a counter collection as `staff`, so the distinction is free and the query
 * does not have to select a JSON column to render a sentence.
 */
export function describeEvent(entry: {
  kind: OrderEventKind;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus | null;
  actor: EventActor;
}): string {
  switch (entry.kind) {
    case 'transition':
      // The only transition with no `fromStatus` is the placement itself.
      return entry.fromStatus === null
        ? 'Order placed'
        : `Moved to ${entry.toStatus === null ? 'a new state' : STATUS_LABEL[entry.toStatus]}`;
    case 'revert':
      return `Moved back to ${entry.toStatus === null ? 'a previous state' : STATUS_LABEL[entry.toStatus]}`;
    case 'payment':
      return entry.actor === 'customer' ? 'Paid at checkout' : 'Payment collected at the counter';
    case 'refund':
      return 'Refunded';
    case 'total_mismatch':
      return 'Total mismatch recorded';
    case 'remake':
      // The number it replaces is rendered beside this as a link, off the
      // event's `relatedOrderId` — a sentence naming an order the reader
      // cannot click is a sentence that sends them to the search box.
      return 'Remade from';
    case 'adjustment':
      // Deliberately not "Comped" or "Discounted": the amount is rendered
      // beside this on the receipt, and the log entry has to read the same for
      // a whole-order comp and a $3 partial. Which one it was is in `detail`,
      // and the amount is the thing a dispute is actually about.
      return 'Adjusted';
  }
}

/**
 * The adjustment preset, in words (C-065).
 *
 * A `Record<AdjustmentReason, …>` for the same reason `STATUS_LABEL` is one: a
 * fifth reason cannot ship without the compiler asking what it reads as. Staff
 * facing — the customer never sees these, and the status page is written so it
 * structurally cannot.
 */
export const ADJUSTMENT_REASON_LABEL: Record<AdjustmentReason, string> = {
  wrong_item: 'Wrong item',
  late: 'Took too long',
  quality: 'Quality',
  other: 'Other',
  // Never in a dropdown — `ADJUSTMENT_REASONS` is the staff-pickable set and
  // this one is not in it (C-104). It reaches a screen only through the
  // activity log, where "Adjusted $10.00 · Punch card reward" is the sentence
  // that tells a dispute why ten dollars came off.
  loyalty_reward: 'Punch card reward',
};

/**
 * Who did it, when the log knows.
 *
 * "Not recorded" is deliberately not blank and deliberately not a guess: every
 * staff event written before C-086 is anonymous permanently, and a row that
 * says so is more useful than one that quietly omits the column.
 */
export function describeActor(entry: { actor: EventActor; staffName: string | null }): string {
  if (entry.staffName !== null) return entry.staffName;
  switch (entry.actor) {
    case 'customer':
      return 'Customer';
    case 'system':
      return 'Automatic';
    case 'staff':
      return 'Staff — name not recorded';
  }
}

/**
 * The words for an event's `reason` column (C-065).
 *
 * The column holds a PRESET KEY, deliberately — "why were things comped on
 * Friday" has to be a `GROUP BY` and not a scan of typed sentences. That makes
 * it a key a screen must translate, and `quality` rendered raw in quotation
 * marks reads as something a cook typed.
 *
 * Only adjustments are mapped. A cancel reason has rendered raw since C-004
 * and fixing that here would change a string four specs assert on, under an
 * item about money — a separate, deliberate change, not a drive-by.
 */
export function describeEventReason(entry: {
  kind: OrderEventKind;
  reason: string | null;
}): string | null {
  if (entry.reason === null) return null;
  if (entry.kind !== 'adjustment' && entry.kind !== 'remake') return entry.reason;
  return ADJUSTMENT_REASON_LABEL[entry.reason as AdjustmentReason] ?? entry.reason;
}
