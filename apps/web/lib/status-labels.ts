// How each order status reads to a person.
//
// One map, because the kitchen queue's section headings and the report's
// time-in-state rows have to call the same state the same thing. A cook who
// reads "Ready for pickup" on the queue and "ready" on the report has to work
// out that they are the same row.
//
// A `Record<OrderStatus, …>`, so a new state cannot ship without a name — the
// same trick `STATUS_FACTS` uses, applied to the words.
import type { OrderStatus } from '@countertop/core';

export const STATUS_LABEL: Record<OrderStatus, string> = {
  placed: 'New',
  accepted: 'Accepted',
  preparing: 'Preparing',
  ready: 'Ready for pickup',
  picked_up: 'Picked up',
  cancelled: 'Cancelled',
  abandoned: 'No-show',
};
