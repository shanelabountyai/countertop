import { describe, expect, it } from 'vitest';
import type { CartReview } from '../cart/cart';
import { placementLogLine, totalTampering, type PlacementLogInput } from './observability';

// C-084 / PRD 6 P0-1. Today, when an order goes missing at 7:10pm, the product
// cannot tell "never placed" from "placed and eaten", because it writes no log
// line anywhere. These tests are about the two things that make the line worth
// having: that every outcome produces exactly one, and that none of them can
// carry a customer.

const AT = new Date(Date.UTC(2026, 6, 14, 19, 30, 0));
const KEY = '9f2b4c1d-3e5a-4b7c-8d9e-0a1b2c3d4e5f';

const line = (outcome: PlacementLogInput['outcome'], mismatch?: PlacementLogInput['mismatch']) =>
  placementLogLine({ at: AT, idempotencyKey: KEY, outcome, ...(mismatch && { mismatch }) });

describe('placementLogLine — every outcome produces one correlatable line', () => {
  it('logs a placement with the order id and whether it was a replay', () => {
    expect(line({ result: 'placed', orderId: 'order-1', replayed: false })).toEqual({
      event: 'placement',
      at: '2026-07-14T19:30:00.000Z',
      key: KEY,
      result: 'placed',
      orderId: 'order-1',
      replayed: false,
    });
  });

  it('distinguishes a replay from a first placement', () => {
    // Two lines with the same key and the same order id is the correct record
    // of a double-tap, and `replayed` is what tells them apart. Without it, a
    // support question about a duplicate charge has two identical lines.
    expect(line({ result: 'placed', orderId: 'order-1', replayed: true })).toMatchObject({
      orderId: 'order-1',
      replayed: true,
    });
  });

  it('logs every refusal kind at once, not just the first', () => {
    expect(
      line({ result: 'refused', errorKinds: ['name_required', 'empty_cart'] }),
    ).toMatchObject({
      result: 'refused',
      refusals: ['name_required', 'empty_cart'],
    });
  });

  it('names the gate trigger, so a pause is countable rather than remembered', () => {
    // "The pause bounced eleven orders during the fryer outage" has to be a
    // number somebody can produce, and one line per bounce is how.
    for (const reason of [
      'manually_paused',
      'closed_today',
      'outside_hours',
      'closing_soon',
      'too_busy',
    ] as const) {
      expect(line({ result: 'refused', errorKinds: ['ordering_closed'], gateReason: reason })).toMatchObject({
        result: 'refused',
        refusals: ['ordering_closed'],
        gateReason: reason,
      });
    }
  });

  it('omits the gate reason entirely when the gate was not the refusal', () => {
    // Not `gateReason: null`. An absent key does not have to be explained to
    // whoever greps the log.
    expect(line({ result: 'refused', errorKinds: ['empty_cart'] })).not.toHaveProperty('gateReason');
  });
});

describe('placementLogLine — a throw is a line, not a silence', () => {
  it("passes through the engine's own unknown-id message, which IS the diagnostic", () => {
    // `priceLine` refuses an unknown id rather than pricing it as zero, and
    // until this item that throw had no handler and no log at all.
    expect(line({ result: 'threw', errorName: 'Error', message: 'Unknown option: guacamole' })).toMatchObject({
      result: 'threw',
      errorName: 'Error',
      message: 'Unknown option: guacamole',
    });
  });

  it('withholds a message it has not vetted, and says that it did', () => {
    // A Prisma error quotes the row it choked on. The class is still logged —
    // a withheld message is a worse log line; a leaked phone number is a
    // defect.
    const withheld = line({
      result: 'threw',
      errorName: 'PrismaClientKnownRequestError',
      message: 'Unique constraint failed on the fields: (`customerPhone`) value "555-0100"',
    });
    expect(withheld).toMatchObject({ errorName: 'PrismaClientKnownRequestError', messageWithheld: true });
    expect(withheld).not.toHaveProperty('message');
  });

  it('is not fooled by a message that merely starts like a safe one', () => {
    expect(
      line({
        result: 'threw',
        errorName: 'Error',
        message: 'Unknown option: guacamole — for Dana Reyes on 555-0100',
      }),
    ).toMatchObject({ messageWithheld: true });
  });
});

describe('placementLogLine — no line can carry a person', () => {
  it('serialises to something containing no name, phone or status token', () => {
    // The structural argument is the input type, which has no field for any of
    // them. This is the assertion that notices if somebody widens it.
    const serialised = JSON.stringify([
      line({ result: 'placed', orderId: 'order-1', replayed: false }),
      line({ result: 'refused', errorKinds: ['name_required'], gateReason: null }),
      line({ result: 'threw', errorName: 'Error', message: 'Unknown item: burrito' }),
      line({ result: 'placed', orderId: 'order-1', replayed: false }, {
        serverTotalCents: 1456,
        clientTotalCents: 1,
      }),
    ]);

    for (const forbidden of ['Dana', 'Reyes', '555-0100', 'statusToken', 'customerName', 'customerPhone']) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it('records a tampered total on a line that would otherwise be a plain refusal', () => {
    // The defect this half fixes: the mismatch used to be computed inside the
    // write path, so a request that tampered AND failed validation was
    // recorded nowhere at all.
    expect(
      line({ result: 'refused', errorKinds: ['name_required'] }, { serverTotalCents: 1456, clientTotalCents: 1 }),
    ).toMatchObject({
      result: 'refused',
      refusals: ['name_required'],
      clientTotalCents: 1,
      serverTotalCents: 1456,
    });
  });
});

describe('placementLogLine — the enrolment the customer ticked a box for', () => {
  // PRD 7 P0-1 / C-101. Every outcome except `enrolled` is invisible to the
  // customer: the order succeeded and nothing on the receipt says the punch
  // card did not start. `loyalty_pepper_unset` has no other symptom at all.
  const placed = { result: 'placed', orderId: 'order-1', replayed: false } as const;

  it('names what happened, in one word from a closed set', () => {
    for (const enrolment of [
      'enrolled',
      'loyalty_disabled',
      'loyalty_pepper_unset',
      'phone_not_enrollable',
      'enrolment_threw',
    ] as const) {
      expect(
        placementLogLine({ at: AT, idempotencyKey: KEY, outcome: placed, enrolment }),
      ).toMatchObject({ result: 'placed', enrolment });
    }
  });

  it('says nothing at all when nobody asked to join', () => {
    expect(placementLogLine({ at: AT, idempotencyKey: KEY, outcome: placed })).not.toHaveProperty(
      'enrolment',
    );
    expect(
      placementLogLine({ at: AT, idempotencyKey: KEY, outcome: placed, enrolment: null }),
    ).not.toHaveProperty('enrolment');
  });

  it('carries no phone number, because the type has no field for one', () => {
    // The structural argument again: an enrolment is about a phone number and
    // this line still cannot hold one.
    expect(
      JSON.stringify(
        placementLogLine({
          at: AT,
          idempotencyKey: KEY,
          outcome: placed,
          enrolment: 'phone_not_enrollable',
        }),
      ),
    ).not.toContain('555');
  });
});

describe('totalTampering — evidence, not noise', () => {
  // Built through the same field the cart computes, so a test cannot assert a
  // combination `reviewCart` would never produce.
  const review = (totalCents: number, placeable = true): Pick<CartReview, 'totals' | 'placeable'> => ({
    totals: { subtotalCents: totalCents, taxCents: 0, totalCents },
    placeable,
  });

  it('reports a client claiming a different number for a cleanly priced cart', () => {
    expect(totalTampering(review(1456), 1)).toEqual({ serverTotalCents: 1456, clientTotalCents: 1 });
  });

  it('is silent when the client agrees', () => {
    expect(totalTampering(review(1456), 1456)).toBeNull();
  });

  it('is silent when the client sent nothing', () => {
    expect(totalTampering(review(1456), undefined)).toBeNull();
  });

  it('is silent on any cart the server would refuse to price cleanly', () => {
    // `placeable` is false for a line that needs fixing (an 86 prices only what
    // still prices), for a price that moved under the customer (C-026's confirm
    // panel exists for exactly that), and for a cart emptied in another tab.
    // All three make the two totals differ for an honest reason.
    expect(totalTampering(review(800, false), 1200)).toBeNull();
  });

  it('is silent on an empty cart, which used to log a false tamper', () => {
    // Observed in a real sweep the day the logging shipped:
    //   {"result":"refused","refusals":["empty_cart"],
    //    "clientTotalCents":1185,"serverTotalCents":0}
    // The cart emptied in another tab; the customer's screen honestly still
    // showed $11.85. Calling that tampering is the noise this function exists
    // to keep out, and the bug was re-deriving `placeable` instead of asking.
    expect(totalTampering(review(0, false), 1185)).toBeNull();
  });
});
