// THE order state machine (P0-4, CLAUDE.md "One status module").
//
// Every reader — the kitchen queue's groupings, the throttle's open-order
// count, the poller's stop condition, the alert's eligibility set, the report
// queries — derives its status list from the ONE table below. None of them
// hard-codes a status string. Adding a state means the compiler walks you
// through the readers, because `STATUS_FACTS` is a `Record<OrderStatus, …>`
// and a new key with a missing field does not compile.
//
// Nothing here reads the clock: `now` is a parameter (CLAUDE.md time rules).

export const ORDER_STATUSES = [
  'placed',
  'accepted',
  'preparing',
  'ready',
  'picked_up',
  'cancelled',
  'abandoned',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** The short preset list staff pick from (P0-4). `other` requires a note. */
export const CANCEL_REASONS = ['out_of_item', 'too_busy', 'other'] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];

export const EVENT_ACTORS = ['customer', 'staff', 'system'] as const;
export type EventActor = (typeof EVENT_ACTORS)[number];

export const ORDER_EVENT_KINDS = ['transition', 'revert', 'total_mismatch', 'refund'] as const;
export type OrderEventKind = (typeof ORDER_EVENT_KINDS)[number];

export const PAYMENT_STATES = ['unpaid', 'paid', 'refunded'] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];

/** Matches the `cancelNote` / `orderNote` column width. */
export const MAX_CANCEL_NOTE_LENGTH = 140;

type StatusFacts = {
  /** The forward move an "advance" tap makes. Null where there is none. */
  next: OrderStatus | null;
  /** Where a revert (including the 5-second undo) puts the order back. */
  previous: OrderStatus | null;
  /** Counts toward the P0-6 auto-pause threshold: work the kitchen still owes. */
  open: boolean;
  /** Nothing more happens. Polling stops here (P0-5). */
  terminal: boolean;
  /** Un-acknowledged: chimes and flashes until a staff tap (P0-12). */
  alerts: boolean;
  /** Appears on the kitchen queue, in this order as a grouping. */
  inQueue: boolean;
  cancellableByStaff: boolean;
  cancellableByCustomer: boolean;
  /** Staff closing out a no-show (P0-4). */
  abandonable: boolean;
  /**
   * Which side of the sales report this order lands on (P1-1).
   *
   * A field rather than a list, and exhaustive rather than a boolean, so a new
   * state cannot ship without deciding whether it sold food, lost food, or is
   * still in flight — the compiler asks, instead of a report quietly counting
   * it as nothing.
   *
   *   sold      the customer took the food. Items, revenue and attach rates
   *             are all counted over exactly these.
   *   no_show   the food was made and nobody came for it. Not revenue; it is
   *             the numerator of the no-show rate.
   *   cancelled never handed over, and counted in neither.
   *   in_flight the kitchen is not finished with it. A report run at 2pm must
   *             not book lunch that is still on the pass.
   */
  salesRole: 'sold' | 'no_show' | 'cancelled' | 'in_flight';
};

/**
 * The whole lifecycle, in one table.
 *
 *   placed → accepted → preparing → ready → picked_up
 *
 * with `cancelled` reachable from anywhere pre-`ready`, `abandoned` reachable
 * from `ready`, and every backward move going through `previous` as a LOGGED
 * revert — never a delete, never a silent overwrite.
 */
export const STATUS_FACTS: Record<OrderStatus, StatusFacts> = {
  placed: {
    next: 'accepted',
    previous: null,
    open: true,
    terminal: false,
    // The order the customer is waiting on and nobody has looked at yet. This
    // single fact is what makes the alert survive a page reload: it is derived
    // from state, not from a client-side "new order arrived" event (P0-12).
    alerts: true,
    inQueue: true,
    cancellableByStaff: true,
    cancellableByCustomer: true,
    abandonable: false,
    salesRole: 'in_flight',
  },
  accepted: {
    next: 'preparing',
    previous: 'placed',
    open: true,
    terminal: false,
    alerts: false,
    inQueue: true,
    cancellableByStaff: true,
    // Past this point the kitchen has committed; a customer cancel becomes a
    // phone call, not a button (P0-4).
    cancellableByCustomer: false,
    abandonable: false,
    salesRole: 'in_flight',
  },
  preparing: {
    next: 'ready',
    previous: 'accepted',
    open: true,
    terminal: false,
    alerts: false,
    inQueue: true,
    // "Out of item" is often discovered with the pan already hot.
    cancellableByStaff: true,
    cancellableByCustomer: false,
    abandonable: false,
    salesRole: 'in_flight',
  },
  ready: {
    next: 'picked_up',
    previous: 'preparing',
    // The food is made. It no longer competes for kitchen capacity, so it must
    // not hold the throttle closed — but it is still on the queue, aging,
    // until someone collects it.
    open: false,
    terminal: false,
    alerts: false,
    inQueue: true,
    // Cancelling cooked food is not a cancellation; a no-show is `abandoned`.
    cancellableByStaff: false,
    cancellableByCustomer: false,
    abandonable: true,
    salesRole: 'in_flight',
  },
  picked_up: {
    next: null,
    // Terminal, but still revertable: the fat-fingered advance needs its undo
    // (P0-4), and undo is a logged revert.
    previous: 'ready',
    open: false,
    terminal: true,
    alerts: false,
    inQueue: false,
    cancellableByStaff: false,
    cancellableByCustomer: false,
    abandonable: false,
    salesRole: 'sold',
  },
  cancelled: {
    next: null,
    // Deliberately not revertable: a cancel may have written a refund, and
    // un-cancelling would have to re-charge. Place a new order instead.
    previous: null,
    open: false,
    terminal: true,
    alerts: false,
    inQueue: false,
    cancellableByStaff: false,
    cancellableByCustomer: false,
    abandonable: false,
    salesRole: 'cancelled',
  },
  abandoned: {
    next: null,
    previous: 'ready',
    open: false,
    terminal: true,
    alerts: false,
    inQueue: false,
    cancellableByStaff: false,
    cancellableByCustomer: false,
    abandonable: false,
    salesRole: 'no_show',
  },
};

const statusesWhere = (fact: keyof StatusFacts): readonly OrderStatus[] =>
  ORDER_STATUSES.filter((s) => STATUS_FACTS[s][fact] === true);

const statusesInSalesRole = (role: StatusFacts['salesRole']): readonly OrderStatus[] =>
  ORDER_STATUSES.filter((s) => STATUS_FACTS[s].salesRole === role);

/** P0-6's throttle counts these, and only these. */
export const OPEN_STATUSES = statusesWhere('open');
/** P0-5: the customer's status page stops polling here. */
export const TERMINAL_STATUSES = statusesWhere('terminal');
/** P0-12: chiming and flashing until acknowledged. */
export const ALERT_STATUSES = statusesWhere('alerts');
/** P0-4: the kitchen queue's groupings, in display order. */
export const QUEUE_STATUSES = statusesWhere('inQueue');
/** P1-1: the statuses a sales report counts as revenue. */
export const SOLD_STATUSES = statusesInSalesRole('sold');
/** P1-1: food made and never collected — the no-show rate's numerator. */
export const NO_SHOW_STATUSES = statusesInSalesRole('no_show');

export const isOpen = (status: OrderStatus): boolean => STATUS_FACTS[status].open;
export const isTerminal = (status: OrderStatus): boolean => STATUS_FACTS[status].terminal;
export const needsAcknowledgment = (status: OrderStatus): boolean => STATUS_FACTS[status].alerts;
export const salesRoleOf = (status: OrderStatus): StatusFacts['salesRole'] =>
  STATUS_FACTS[status].salesRole;
export const nextStatus = (status: OrderStatus): OrderStatus | null => STATUS_FACTS[status].next;
export const previousStatus = (status: OrderStatus): OrderStatus | null =>
  STATUS_FACTS[status].previous;

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/** What the machine needs to know about an order. A row, not an ORM object. */
export type OrderState = {
  status: OrderStatus;
  paymentState: PaymentState;
  totalCents: number;
};

export type OrderAction =
  | { kind: 'advance'; actor: EventActor; to?: OrderStatus }
  | { kind: 'revert'; actor: EventActor; to?: OrderStatus; reason?: string }
  | { kind: 'cancel'; actor: EventActor; reason: CancelReason; note?: string }
  | { kind: 'abandon'; actor: EventActor };

/**
 * An event to append, exactly as the `OrderEvent` row will read. The log is
 * append-only (a trigger enforces it); a revert ADDS a row.
 */
export type OrderEventDraft = {
  at: Date;
  kind: OrderEventKind;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus | null;
  actor: EventActor;
  reason: string | null;
  detail?: Record<string, unknown>;
};

export type RefusalReason =
  | 'terminal_order'
  | 'no_previous_status'
  | 'revert_not_allowed'
  | 'unexpected_target'
  | 'actor_not_permitted'
  | 'cancel_not_allowed'
  | 'customer_cancel_too_late'
  | 'unknown_cancel_reason'
  | 'cancel_note_required'
  | 'cancel_note_too_long'
  | 'abandon_not_allowed';

/** Refusals carry the REASON, not just the failure — a test asserting only
 *  "rejected" passes against a machine that rejects everything. */
export type TransitionRefusal = {
  reason: RefusalReason;
  message: string;
  from: OrderStatus;
  to?: OrderStatus;
};

export type TransitionResult =
  | { ok: true; status: OrderStatus; events: OrderEventDraft[] }
  | { ok: false; refusal: TransitionRefusal };

const refuse = (
  reason: RefusalReason,
  message: string,
  from: OrderStatus,
  to?: OrderStatus,
  // Spread rather than `to`: `exactOptionalPropertyTypes` distinguishes an
  // absent key from a present `undefined` one.
): TransitionResult => ({ ok: false, refusal: { reason, message, from, ...(to && { to }) } });

/** The `placed` row's own event: a transition from nothing (C-006 writes it). */
export function placementEvent(now: Date): OrderEventDraft {
  return {
    at: now,
    kind: 'transition',
    fromStatus: null,
    toStatus: 'placed',
    actor: 'customer',
    reason: null,
  };
}

/**
 * Apply an action to an order. Pure: it decides, it does not persist.
 *
 * Callers write `events` to the append-only log and `status` to the order in
 * the SAME transaction — a status that moved without an event is a hole in the
 * history the reports read.
 */
export function applyTransition(
  order: OrderState,
  action: OrderAction,
  now: Date,
): TransitionResult {
  const from = order.status;
  const facts = STATUS_FACTS[from];

  switch (action.kind) {
    case 'advance': {
      if (action.actor !== 'staff') {
        return refuse('actor_not_permitted', 'Only staff advance an order.', from);
      }
      if (facts.terminal || facts.next === null) {
        return refuse('terminal_order', `A ${from} order cannot be advanced.`, from);
      }
      const to = facts.next;
      // Two cooks tapping the same card: the second tap names a target that is
      // already behind, and is refused rather than skipping a state.
      if (action.to !== undefined && action.to !== to) {
        return refuse(
          'unexpected_target',
          `This order is ${from}; the next state is ${to}, not ${action.to}.`,
          from,
          action.to,
        );
      }
      return {
        ok: true,
        status: to,
        events: [
          { at: now, kind: 'transition', fromStatus: from, toStatus: to, actor: 'staff', reason: null },
        ],
      };
    }

    case 'revert': {
      if (action.actor !== 'staff') {
        return refuse('actor_not_permitted', 'Only staff revert an order.', from);
      }
      // `cancelled` has no `previous` for a different reason than `placed`
      // does, and the staff-facing message has to say which.
      if (from === 'cancelled') {
        return refuse(
          'revert_not_allowed',
          'A cancelled order cannot be un-cancelled — place a new order.',
          from,
        );
      }
      const to = facts.previous;
      if (to === null) {
        return refuse('no_previous_status', 'A placed order has nothing to revert to.', from);
      }
      if (action.to !== undefined && action.to !== to) {
        return refuse(
          'unexpected_target',
          `This order is ${from}; a revert puts it back to ${to}, not ${action.to}.`,
          from,
          action.to,
        );
      }
      return {
        ok: true,
        status: to,
        events: [
          {
            at: now,
            kind: 'revert',
            fromStatus: from,
            toStatus: to,
            actor: 'staff',
            reason: action.reason ?? null,
          },
        ],
      };
    }

    case 'cancel': {
      if (action.actor === 'system') {
        return refuse('actor_not_permitted', 'A cancellation names a person.', from, 'cancelled');
      }
      if (!facts.cancellableByStaff) {
        return refuse(
          'cancel_not_allowed',
          `A ${from} order cannot be cancelled.`,
          from,
          'cancelled',
        );
      }
      if (action.actor === 'customer' && !facts.cancellableByCustomer) {
        return refuse(
          'customer_cancel_too_late',
          'The kitchen has already started this order — call the restaurant.',
          from,
          'cancelled',
        );
      }
      if (!CANCEL_REASONS.includes(action.reason)) {
        return refuse(
          'unknown_cancel_reason',
          `"${action.reason}" is not a cancel reason.`,
          from,
          'cancelled',
        );
      }
      // "Other" with no text is the reason nobody can act on later.
      if (action.reason === 'other' && !action.note?.trim()) {
        return refuse('cancel_note_required', 'Say what happened.', from, 'cancelled');
      }
      if ((action.note?.length ?? 0) > MAX_CANCEL_NOTE_LENGTH) {
        return refuse(
          'cancel_note_too_long',
          `Keep the cancel note to ${MAX_CANCEL_NOTE_LENGTH} characters.`,
          from,
          'cancelled',
        );
      }

      const events: OrderEventDraft[] = [
        {
          at: now,
          kind: 'transition',
          fromStatus: from,
          toStatus: 'cancelled',
          actor: action.actor,
          reason: action.reason,
          ...(action.note && { detail: { note: action.note } }),
        },
      ];
      // The mock provider's refund record (P0-4). It is an event, not a
      // column: refunding is something that happened at a time, by someone.
      if (order.paymentState === 'paid') {
        events.push({
          at: now,
          kind: 'refund',
          fromStatus: from,
          toStatus: 'cancelled',
          actor: 'system',
          reason: action.reason,
          detail: { amountCents: order.totalCents, provider: 'mock' },
        });
      }
      return { ok: true, status: 'cancelled', events };
    }

    case 'abandon': {
      if (action.actor !== 'staff') {
        return refuse('actor_not_permitted', 'Only staff close out a no-show.', from, 'abandoned');
      }
      if (!facts.abandonable) {
        // `abandoned` is a distinct business signal from `cancelled` — the
        // no-show rate is a number the owner acts on (P0-4, P1-1).
        return refuse(
          'abandon_not_allowed',
          `Only an order that is ready can be closed out as a no-show; this one is ${from}.`,
          from,
          'abandoned',
        );
      }
      return {
        ok: true,
        status: 'abandoned',
        events: [
          {
            at: now,
            kind: 'transition',
            fromStatus: from,
            toStatus: 'abandoned',
            actor: 'staff',
            reason: null,
          },
        ],
      };
    }
  }
}

/**
 * Acknowledging the alert IS `placed → accepted` (P0-4, P0-12). There is no
 * separate accept chore, and no second code path — this is `advance` with the
 * target named, so a card acked twice is refused by `unexpected_target`.
 */
export function acknowledge(order: OrderState, now: Date): TransitionResult {
  return applyTransition(order, { kind: 'advance', actor: 'staff', to: 'accepted' }, now);
}
