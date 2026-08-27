// How each order status reads to a person.
//
// One map, because the kitchen queue's section headings and the report's
// time-in-state rows have to call the same state the same thing. A cook who
// reads "Ready for pickup" on the queue and "ready" on the report has to work
// out that they are the same row.
//
// A `Record<OrderStatus, …>`, so a new state cannot ship without a name — the
// same trick `STATUS_FACTS` uses, applied to the words.
import type { OrderStatus, PaymentState } from '@countertop/core';

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
