import { describe, expect, it } from 'vitest';
import {
  authorizationEvent,
  authorizationVoidedEvent,
  captureEvent,
  heldAuthorization,
  type AuthorizationEvent,
} from './authorization';

// PRD 3 P1-1 (C-069). `heldAuthorization` is the only thing in this product
// that follows the settlement link, and it exists for one caller: the writer,
// which has to name the hold it is settling because that id is the idempotency
// key the provider is handed. Everything that only needs the NUMBER asks
// `paymentTotals` instead.

const NOW = new Date(Date.UTC(2026, 6, 5, 3, 0, 0));

const hold = (id: string, amountCents: number): AuthorizationEvent => ({
  id,
  kind: 'authorization',
  amountCents,
  authorizationId: null,
});
const settlement = (
  id: string,
  kind: 'capture' | 'authorization_voided',
  authorizationId: string,
): AuthorizationEvent => ({ id, kind, amountCents: 3507, authorizationId });
const move = (id: string): AuthorizationEvent => ({
  id,
  kind: 'transition',
  amountCents: null,
  authorizationId: null,
});

describe('heldAuthorization', () => {
  it('is null on an order that was never prepaid', () => {
    expect(heldAuthorization([move('e1'), move('e2')])).toBeNull();
  });

  it('finds the hold nothing has settled', () => {
    expect(heldAuthorization([move('e1'), hold('a1', 3507)])).toEqual({
      id: 'a1',
      amountCents: 3507,
    });
  });

  it('is null once the hold was captured', () => {
    expect(heldAuthorization([hold('a1', 3507), settlement('c1', 'capture', 'a1')])).toBeNull();
  });

  it('is null once the hold was released', () => {
    expect(
      heldAuthorization([hold('a1', 3507), settlement('v1', 'authorization_voided', 'a1')]),
    ).toBeNull();
  });

  // The undo. `picked_up` is revertable on purpose, so "advance, undo,
  // advance" is an ordinary sequence at a counter — and the second advance
  // must not find a hold to charge. The database says the same thing with a
  // unique index, which is what makes it true under two screens rather than
  // one.
  it('does not offer a spent hold back to a second advance', () => {
    const log = [hold('a1', 3507), settlement('c1', 'capture', 'a1')];
    expect(heldAuthorization(log)).toBeNull();
    expect(heldAuthorization([...log, move('e9')])).toBeNull();
  });

  // BY LINKAGE, not by ordering: a settlement naming a different hold leaves
  // this one open. The point is the same one `pendingRefunds` makes — "last"
  // needs an ordering the receipt's select does not impose, and a frozen `now`
  // gives every row in a test the same instant.
  it('ignores a settlement that names some other hold', () => {
    expect(heldAuthorization([hold('a1', 3507), settlement('c1', 'capture', 'a-other')])).toEqual({
      id: 'a1',
      amountCents: 3507,
    });
  });
});

describe('the drafts', () => {
  // Money marks the timeline, it does not divide it — the same nulls
  // `payment`, `refund` and `adjustment` carry, so the time-in-state tally
  // steps over all three of these.
  it('are not status changes', () => {
    for (const draft of [
      authorizationEvent(NOW, 3507),
      captureEvent(NOW, 3507, 'a1', 'mock_capture_a1'),
      authorizationVoidedEvent(NOW, 3507, 'a1', 'no_show'),
    ]) {
      expect(draft.fromStatus).toBeNull();
      expect(draft.toStatus).toBeNull();
      expect(draft.amountCents).toBe(3507);
    }
  });

  // The customer's own tap authorized the card; the machine completes it at
  // the counter. Putting the cook who tapped "Picked up" on the capture would
  // be a name on a decision they did not make.
  it('name the customer for the hold and the machine for its settlement', () => {
    expect(authorizationEvent(NOW, 3507).actor).toBe('customer');
    expect(captureEvent(NOW, 3507, 'a1', 'ref').actor).toBe('system');
    expect(authorizationVoidedEvent(NOW, 3507, 'a1', 'no_show').actor).toBe('system');
  });

  it('point every settlement at the hold it settles', () => {
    expect(captureEvent(NOW, 3507, 'a1', 'ref').authorizationId).toBe('a1');
    expect(authorizationVoidedEvent(NOW, 3507, 'a1', 'cancelled').authorizationId).toBe('a1');
    // The hold itself names nothing: it IS the thing named.
    expect(authorizationEvent(NOW, 3507).authorizationId).toBeUndefined();
  });

  it('says why a hold was let go, and carries the provider’s words when it failed', () => {
    expect(authorizationVoidedEvent(NOW, 3507, 'a1', 'no_show').reason).toBe('no_show');
    const failed = authorizationVoidedEvent(NOW, 3507, 'a1', 'capture_failed', 'card declined');
    expect(failed.reason).toBe('capture_failed');
    expect(failed.detail).toEqual({ note: 'card declined' });
  });
});
