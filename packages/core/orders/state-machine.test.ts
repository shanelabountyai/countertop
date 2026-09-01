import { describe, expect, it } from 'vitest';
import {
  acknowledge,
  ALERT_STATUSES,
  canCollectPayment,
  applyTransition,
  MAX_CANCEL_NOTE_LENGTH,
  OPEN_STATUSES,
  ORDER_STATUSES,
  placementEvent,
  previousStatus,
  QUEUE_STATUSES,
  TERMINAL_STATUSES,
  UNDOABLE_EXIT_STATUSES,
  type OrderAction,
  type OrderState,
  type OrderStatus,
  type RefusalReason,
} from './state-machine';

// The engine takes `now` as a parameter and nothing here reads a clock.
const NOW = new Date(Date.UTC(2026, 6, 4, 18, 30, 0));

const order = (
  status: OrderStatus,
  overrides: Partial<OrderState> = {},
): OrderState => ({ status, paymentState: 'unpaid', totalCents: 1_499, ...overrides });

// ---------------------------------------------------------------------------
// The full transition table — every status against every action.
//
// 7 statuses x 5 actions, written out rather than derived, so a change to the
// machine has to be re-justified here row by row instead of agreeing with
// itself. Refusals are asserted BY REASON: a test that only checks "refused"
// passes against a machine that refuses everything.
// ---------------------------------------------------------------------------

const ACTIONS = {
  advance: { kind: 'advance', actor: 'staff' },
  revert: { kind: 'revert', actor: 'staff' },
  staffCancel: { kind: 'cancel', actor: 'staff', reason: 'too_busy' },
  customerCancel: { kind: 'cancel', actor: 'customer', reason: 'other', note: 'changed my mind' },
  abandon: { kind: 'abandon', actor: 'staff' },
} satisfies Record<string, OrderAction>;

type ActionName = keyof typeof ACTIONS;
type Expected = OrderStatus | RefusalReason;

const TABLE: Record<OrderStatus, Record<ActionName, Expected>> = {
  placed: {
    advance: 'accepted',
    revert: 'no_previous_status',
    staffCancel: 'cancelled',
    customerCancel: 'cancelled',
    abandon: 'abandon_not_allowed',
  },
  accepted: {
    advance: 'preparing',
    revert: 'placed',
    staffCancel: 'cancelled',
    customerCancel: 'customer_cancel_too_late',
    abandon: 'abandon_not_allowed',
  },
  preparing: {
    advance: 'ready',
    revert: 'accepted',
    staffCancel: 'cancelled',
    customerCancel: 'customer_cancel_too_late',
    abandon: 'abandon_not_allowed',
  },
  ready: {
    advance: 'picked_up',
    revert: 'preparing',
    staffCancel: 'cancel_not_allowed',
    customerCancel: 'cancel_not_allowed',
    abandon: 'abandoned',
  },
  picked_up: {
    advance: 'terminal_order',
    // Terminal, but the fat-fingered advance still gets its undo.
    revert: 'ready',
    staffCancel: 'cancel_not_allowed',
    customerCancel: 'cancel_not_allowed',
    abandon: 'abandon_not_allowed',
  },
  cancelled: {
    advance: 'terminal_order',
    revert: 'revert_not_allowed',
    staffCancel: 'cancel_not_allowed',
    customerCancel: 'cancel_not_allowed',
    abandon: 'abandon_not_allowed',
  },
  abandoned: {
    advance: 'terminal_order',
    revert: 'ready',
    staffCancel: 'cancel_not_allowed',
    customerCancel: 'cancel_not_allowed',
    abandon: 'abandon_not_allowed',
  },
};

const isStatus = (value: Expected): value is OrderStatus =>
  (ORDER_STATUSES as readonly string[]).includes(value);

describe('the transition table', () => {
  for (const from of ORDER_STATUSES) {
    for (const name of Object.keys(ACTIONS) as ActionName[]) {
      const expected = TABLE[from][name];
      const verb = isStatus(expected) ? `moves to ${expected}` : `is refused: ${expected}`;

      it(`${from} + ${name} ${verb}`, () => {
        const result = applyTransition(order(from), ACTIONS[name], NOW);
        if (isStatus(expected)) {
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          expect(result.status).toBe(expected);
          // A status that moved without an event is a hole in the history.
          expect(result.events.length).toBeGreaterThan(0);
          expect(result.events[0]?.fromStatus).toBe(from);
          expect(result.events[0]?.toStatus).toBe(expected);
          expect(result.events[0]?.at).toBe(NOW);
        } else {
          expect(result.ok).toBe(false);
          if (result.ok) return;
          expect(result.refusal.reason).toBe(expected);
          expect(result.refusal.from).toBe(from);
          expect(result.refusal.message).not.toBe('');
        }
      });
    }
  }

  it('covers every status, and reaches every status', () => {
    expect(Object.keys(TABLE).sort()).toEqual([...ORDER_STATUSES].sort());
    const reachable = new Set(
      Object.values(TABLE)
        .flatMap((row) => Object.values(row))
        .filter(isStatus),
    );
    // `placed` is also reached by placement itself, not only by a revert.
    reachable.add('placed');
    expect([...reachable].sort()).toEqual([...ORDER_STATUSES].sort());
  });

  it('counts more than the eight invalid transitions the PRD asks for', () => {
    const refusals = Object.values(TABLE)
      .flatMap((row) => Object.values(row))
      .filter((e) => !isStatus(e));
    expect(refusals.length).toBeGreaterThanOrEqual(8);
    expect(new Set(refusals).size).toBeGreaterThanOrEqual(6);
  });
});

describe('the status lists every reader derives from', () => {
  it('opens the throttle count on unfinished kitchen work only', () => {
    // `ready` food is made: it holds a spot on the queue but must not hold
    // checkout closed (P0-6).
    expect(OPEN_STATUSES).toEqual(['placed', 'accepted', 'preparing']);
  });

  it('stops polling on the three terminal states', () => {
    expect(TERMINAL_STATUSES).toEqual(['picked_up', 'cancelled', 'abandoned']);
  });

  it('alerts on exactly the un-acknowledged state', () => {
    expect(ALERT_STATUSES).toEqual(['placed']);
  });

  it('groups the kitchen queue over the four live states, in flow order', () => {
    expect(QUEUE_STATUSES).toEqual(['placed', 'accepted', 'preparing', 'ready']);
  });

  it('names the states whose undo the queue can no longer draw a card for', () => {
    // Not a list to keep in step by hand: it is every status that leaves the
    // queue while still having somewhere to go back to, and the kitchen's
    // "Just finished" strip is rendered off exactly this. `cancelled` is out
    // because it has no `previous` — un-cancelling would have to un-refund.
    expect(UNDOABLE_EXIT_STATUSES).toEqual(['picked_up', 'abandoned']);
    for (const status of UNDOABLE_EXIT_STATUSES) {
      expect(QUEUE_STATUSES).not.toContain(status);
      expect(previousStatus(status)).not.toBeNull();
    }
  });

  it('never calls a status both open and terminal', () => {
    expect(OPEN_STATUSES.filter((s) => TERMINAL_STATUSES.includes(s))).toEqual([]);
    expect(QUEUE_STATUSES.filter((s) => TERMINAL_STATUSES.includes(s))).toEqual([]);
  });
});

describe('money still to collect (P1-8)', () => {
  it('is unpaid AND the customer has the food, or is going to', () => {
    // in_flight: the counter collects before the bag leaves.
    expect(canCollectPayment('placed', 'unpaid')).toBe(true);
    expect(canCollectPayment('ready', 'unpaid')).toBe(true);
    // sold: handed over without collecting. The case the queue card cannot
    // serve, because it has already dropped this order.
    expect(canCollectPayment('picked_up', 'unpaid')).toBe(true);
  });

  it('is never a state where nobody took the food', () => {
    // `unpaid` on these is the correct permanent answer, not an outstanding
    // debt — collecting would invent revenue for food that was never handed
    // over, and a no-show is the numerator of a rate the owner acts on.
    expect(canCollectPayment('abandoned', 'unpaid')).toBe(false);
    expect(canCollectPayment('cancelled', 'unpaid')).toBe(false);
  });

  it('is never anything but unpaid — there is no un-pay, and a refund is a cancel', () => {
    for (const status of ORDER_STATUSES) {
      expect(canCollectPayment(status, 'paid')).toBe(false);
      expect(canCollectPayment(status, 'refunded')).toBe(false);
    }
  });
});

describe('acknowledging the alert', () => {
  it('IS the placed -> accepted transition, not a separate chore', () => {
    const result = acknowledge(order('placed'), NOW);
    expect(result.ok && result.status).toBe('accepted');
  });

  it('refuses a second acknowledgment of the same card', () => {
    const result = acknowledge(order('accepted'), NOW);
    expect(!result.ok && result.refusal.reason).toBe('unexpected_target');
  });

  it('refuses an advance whose target is already behind (two cooks, one card)', () => {
    const result = applyTransition(
      order('preparing'),
      { kind: 'advance', actor: 'staff', to: 'preparing' },
      NOW,
    );
    expect(!result.ok && result.refusal.reason).toBe('unexpected_target');
  });
});

describe('undo is a logged revert', () => {
  it('writes a revert event rather than undoing the forward one', () => {
    const result = applyTransition(
      order('ready'),
      { kind: 'revert', actor: 'staff', reason: 'tapped the wrong card' },
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe('preparing');
    expect(result.events).toEqual([
      {
        at: NOW,
        kind: 'revert',
        fromStatus: 'ready',
        toStatus: 'preparing',
        actor: 'staff',
        reason: 'tapped the wrong card',
      },
    ]);
  });

  it('refuses a revert to a state that is not the one before this', () => {
    const result = applyTransition(
      order('ready'),
      { kind: 'revert', actor: 'staff', to: 'placed' },
      NOW,
    );
    expect(!result.ok && result.refusal.reason).toBe('unexpected_target');
  });
});

describe('cancellation', () => {
  it('records the preset reason and the optional text', () => {
    const result = applyTransition(
      order('accepted'),
      { kind: 'cancel', actor: 'staff', reason: 'out_of_item', note: 'no carnitas left' },
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events[0]?.reason).toBe('out_of_item');
    expect(result.events[0]?.detail).toEqual({ note: 'no carnitas left' });
  });

  it('writes a mock refund record when the order was paid', () => {
    const result = applyTransition(
      order('preparing', { paymentState: 'paid', totalCents: 2_350 }),
      { kind: 'cancel', actor: 'staff', reason: 'too_busy' },
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events.map((e) => e.kind)).toEqual(['transition', 'refund']);
    expect(result.events[1]).toMatchObject({
      at: NOW,
      actor: 'system',
      detail: { amountCents: 2_350, provider: 'mock' },
    });
  });

  it('writes no refund for an unpaid order', () => {
    const result = applyTransition(
      order('placed'),
      { kind: 'cancel', actor: 'staff', reason: 'too_busy' },
      NOW,
    );
    expect(result.ok && result.events.map((e) => e.kind)).toEqual(['transition']);
  });

  it('refuses "other" with no text — a reason nobody can act on later', () => {
    const result = applyTransition(
      order('placed'),
      { kind: 'cancel', actor: 'staff', reason: 'other', note: '   ' },
      NOW,
    );
    expect(!result.ok && result.refusal.reason).toBe('cancel_note_required');
  });

  it('refuses a reason that is not on the preset list', () => {
    const result = applyTransition(
      order('placed'),
      { kind: 'cancel', actor: 'staff', reason: 'because' as 'other' },
      NOW,
    );
    expect(!result.ok && result.refusal.reason).toBe('unknown_cancel_reason');
  });

  it('refuses a note longer than the column holds', () => {
    const result = applyTransition(
      order('placed'),
      { kind: 'cancel', actor: 'staff', reason: 'too_busy', note: 'x'.repeat(MAX_CANCEL_NOTE_LENGTH + 1) },
      NOW,
    );
    expect(!result.ok && result.refusal.reason).toBe('cancel_note_too_long');
  });
});

describe('who may do what', () => {
  const notPermitted: OrderAction[] = [
    { kind: 'advance', actor: 'customer' },
    { kind: 'revert', actor: 'customer' },
    { kind: 'abandon', actor: 'customer' },
    { kind: 'cancel', actor: 'system', reason: 'too_busy' },
  ];

  for (const action of notPermitted) {
    it(`refuses ${action.actor} ${action.kind}`, () => {
      const result = applyTransition(order('ready'), action, NOW);
      expect(!result.ok && result.refusal.reason).toBe('actor_not_permitted');
    });
  }
});

describe('placement', () => {
  it('logs the arrival as a transition from nothing', () => {
    expect(placementEvent(NOW)).toEqual({
      at: NOW,
      kind: 'transition',
      fromStatus: null,
      toStatus: 'placed',
      actor: 'customer',
      reason: null,
    });
  });
});
