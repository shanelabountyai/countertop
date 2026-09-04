// THE order state machine (P0-4, CLAUDE.md "One status module").
//
// Every reader — the kitchen queue's groupings, the throttle's open-weight
// sum, the poller's stop condition, the alert's eligibility set, the report
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

/**
 * The short preset list staff pick from (P0-4). `other` requires a note.
 *
 * Five since C-057, and the two new ones are the report's whole point (PRD 1
 * P0-6): "the customer changed their mind" and "we got it wrong" were the two
 * things that actually happened most, and both were being typed into `other`
 * as free text — which is a bucket nobody can count, so nobody could tell a
 * demand problem from a kitchen problem. `other` stays last because it is now
 * meant to be the rare one.
 *
 * ORDER IS THE DATABASE'S ORDER. `snapshot.test.ts` compares this array
 * against `pg_enum` by `enumsortorder`, so appending here means appending in
 * the migration too — the new values go BEFORE `other` with `ADD VALUE ...
 * BEFORE`, not at the end.
 */
export const CANCEL_REASONS = [
  'out_of_item',
  'too_busy',
  'customer_changed_mind',
  'kitchen_error',
  'other',
] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];

export const EVENT_ACTORS = ['customer', 'staff', 'system'] as const;
export type EventActor = (typeof EVENT_ACTORS)[number];

export const ORDER_EVENT_KINDS = [
  'transition',
  'revert',
  'total_mismatch',
  'refund',
  /** Money arriving (C-085). The mirror of `refund`, and added for the same
   *  reason that one exists: a payment is something that HAPPENED, at a time,
   *  for an amount — not a column that is simply true. Until this kind, an
   *  order collected at the counter carried no instant at all. */
  'payment',
  /** Money the restaurant chose not to ask for (PRD 3 P0-3, C-065): a comp or
   *  a partial write-off, appended beside the snapshot and never subtracted
   *  from it. The counter has always done this; until now it did it off-system,
   *  and the till and the report disagreed by an amount nobody wrote down. */
  'adjustment',
  /** This order replaces another one (PRD 3 P0-3, C-066). Decision 7 of
   *  2026-09-02: a remake is a REAL second order with its own number and its
   *  own ticket, so the link is what ties the two together. Carries no
   *  amount — the money is the full comp written beside it. */
  'remake',
] as const;
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
/**
 * P0-4: left the queue, but the last tap is still undoable.
 *
 * The fat-fingered advance's undo is only worth having if the cook can reach
 * it, and these are exactly the states whose card the queue stops drawing at
 * the moment it becomes undoable. Derived, not spelled out, so a new terminal
 * state with a `previous` joins the "just finished" strip by existing rather
 * than by someone remembering this file. `cancelled` is absent because it has
 * no `previous` — un-cancelling would have to un-refund.
 */
export const UNDOABLE_EXIT_STATUSES = ORDER_STATUSES.filter(
  (s) => !STATUS_FACTS[s].inQueue && STATUS_FACTS[s].previous !== null,
);
/** P1-1: the statuses a sales report counts as revenue. */
export const SOLD_STATUSES = statusesInSalesRole('sold');
/** P1-1: food made and never collected — the no-show rate's numerator. */
export const NO_SHOW_STATUSES = statusesInSalesRole('no_show');

/**
 * Is there money still to collect on this order (P1-8, rewritten C-064)?
 *
 * ONE predicate, three readers — the queue card's collect button, the history
 * receipt's, and the server action behind both — for the same reason the gate
 * and the orderability check are each one function.
 *
 * It took `paymentState` until C-064 and now takes an AMOUNT, from
 * `orderBalance` (PRD 3 P0-2). The enum could only say unpaid, and "unpaid"
 * is not a question about an order that has been half refunded or partly
 * comped; "is anything still owed" is, and it has the same answer for every
 * case the enum could express. A number rather than the balance object so
 * this module keeps knowing nothing about the payment stream — the two are
 * deliberately not coupled, and the caller does the one computation.
 *
 * A balance is necessary and not sufficient: on a `cancelled` or `abandoned`
 * order the outstanding amount is the correct permanent answer and still must
 * not be collected, because nobody took the food. `sold` is the case the
 * queue card structurally cannot serve — it has already dropped that order —
 * which is how an unpaid order used to become uncollectable forever by being
 * handed over.
 */
export function canCollectPayment(status: OrderStatus, outstandingCents: number): boolean {
  if (outstandingCents <= 0) return false;
  const role = STATUS_FACTS[status].salesRole;
  return role === 'in_flight' || role === 'sold';
}

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
  /**
   * Money this event MOVED, in integer cents (PRD 3 P0-1, C-063).
   *
   * Required on `payment` and `refund` and forbidden on everything else — the
   * database says the same thing as a CHECK, written as an equivalence so the
   * two halves cannot drift. Direction is the KIND and never the sign: a
   * refund of -300 and a payment of 300 would be the same row twice over.
   *
   * A field rather than a `detail` key because the event stream is now the
   * truth about payment (decision 5, 2026-09-01), and a balance summed out of
   * JSON is one no index can help and no constraint can defend.
   */
  amountCents?: number;
  /** The processor's own reference, for the day there is a processor. */
  providerRef?: string;
  /**
   * Another ORDER this event points at (PRD 3 P0-3, C-066).
   *
   * Set only on `remake` today, and only in one direction: the remake's own
   * event names the order it replaces. The original finds its remake by
   * reverse lookup, because storing the link on both orders would be one fact
   * in two places and two places can disagree.
   */
  relatedOrderId?: string;
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
 * Money arriving, as an event (C-085, PRD 6 P0-3).
 *
 * Deliberately the mirror of the `refund` draft `applyTransition` pushes on a
 * cancelled paid order: same amount, same shape, opposite direction. A payment
 * used to be a column flipping from `unpaid` to `paid` with no instant, no
 * actor and no amount, which is the systems review's complaint word for word —
 * and it meant "when did we take that money?" had no answer at all for an
 * order collected at the counter.
 *
 * `where` is the thing the column could never say. Both are staff-adjacent —
 * the mock provider at checkout is still the restaurant taking money — but
 * they reconcile against different things, and a payment event that cannot
 * tell the drawer from the processor is a payment event nobody can use.
 *
 * NOT a status change: `fromStatus` and `toStatus` are null, so the
 * time-in-state tally steps over it exactly as it steps over `refund`.
 */
export function paymentEvent(
  now: Date,
  amountCents: number,
  where: 'checkout' | 'counter',
): OrderEventDraft {
  return {
    at: now,
    kind: 'payment',
    fromStatus: null,
    toStatus: null,
    // The customer pays; the staff collect. At checkout the customer's own tap
    // took the money, at the counter somebody handed it over a till.
    actor: where === 'checkout' ? 'customer' : 'staff',
    reason: null,
    amountCents,
    // `detail` keeps its copy: it is what the rows written before C-063 have,
    // and dropping it would make an old event and a new one different shapes
    // for no gain. The COLUMN is what anything sums.
    detail: { amountCents, where, provider: 'mock' },
  };
}

/**
 * The link that says this order replaces another (PRD 3 P0-3, C-066).
 *
 * NOT a status change and NOT money: `fromStatus`/`toStatus` are null so the
 * time-in-state tally steps over it, and there is no `amountCents` because the
 * money is the full comp the same transaction writes beside it. Two facts, two
 * rows — "we cooked this again" and "we charged nothing for it" are separate
 * sentences, and folding them into one row would make the second invisible to
 * a balance that only sums money kinds.
 *
 * `reason` carries the same preset an adjustment does, so "why did we remake
 * things on Friday" is the same `GROUP BY` as "why did we comp things".
 */
export function remakeEvent(
  now: Date,
  /** The order being replaced. */
  relatedOrderId: string,
  reason: string,
): OrderEventDraft {
  return {
    at: now,
    kind: 'remake',
    fromStatus: null,
    toStatus: null,
    actor: 'staff',
    reason,
    relatedOrderId,
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
          amountCents: order.totalCents,
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
