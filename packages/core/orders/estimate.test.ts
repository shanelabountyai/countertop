import { describe, expect, it } from 'vitest';
import { readyEstimate, remainingEstimate, type EstimateState } from './estimate';

// Firebird Kitchen's defaults: 12 minutes for a ticket with nothing in front
// of it, one more minute per order already open.
const state = (overrides: Partial<EstimateState> = {}): EstimateState => ({
  prepBaseMinutes: 12,
  prepPerOrderMinutes: 1,
  openOrderCount: 0,
  ...overrides,
});

describe('readyEstimate', () => {
  it('is a range, never a point', () => {
    const estimate = readyEstimate(state());
    expect(estimate.highMinutes).toBeGreaterThan(estimate.lowMinutes);
    expect(estimate.label).toBe('10–20 min');
  });

  it('grows with the queue', () => {
    // 12 + 4 = 16 -> the 15 step, so the whole range moves up together.
    expect(readyEstimate(state({ openOrderCount: 4 })).label).toBe('15–25 min');
    expect(readyEstimate(state({ openOrderCount: 12 })).label).toBe('20–30 min');
  });

  it('honours a per-order increment above one minute', () => {
    expect(readyEstimate(state({ prepPerOrderMinutes: 3, openOrderCount: 6 })).label).toBe(
      '30–40 min',
    );
  });

  it('rounds the low end DOWN, so the promise cannot drift later', () => {
    // 19 minutes of arithmetic must not be sold as "20–30".
    expect(readyEstimate(state({ openOrderCount: 7 })).lowMinutes).toBe(15);
  });

  it('never promises "right now", whatever the settings say', () => {
    expect(readyEstimate(state({ prepBaseMinutes: 0 })).label).toBe('5–15 min');
    expect(readyEstimate(state({ prepBaseMinutes: 2, openOrderCount: 0 })).lowMinutes).toBe(5);
  });

  it('ignores a negative open count rather than shortening the estimate', () => {
    expect(readyEstimate(state({ openOrderCount: -5 }))).toEqual(readyEstimate(state()));
  });
});

describe('remainingEstimate', () => {
  // The default queue: "10–20 min" at checkout.
  const quoted = readyEstimate(state());

  it('takes the time already spent off the same window', () => {
    expect(remainingEstimate(quoted, 4)?.label).toBe('6–16 min');
  });

  it('is the full window for an order placed a moment ago', () => {
    expect(remainingEstimate(quoted, 0)).toEqual(quoted);
  });

  it('goes null at the low end rather than counting down to zero', () => {
    // 10 minutes in, "0–10 min" is a promise about the past. The page says
    // "any minute now" instead (P0-7: never a precise wrong number).
    expect(remainingEstimate(quoted, 10)).toBeNull();
    expect(remainingEstimate(quoted, 45)).toBeNull();
  });

  it('never returns a negative range', () => {
    for (let spent = 0; spent <= 60; spent += 1) {
      const left = remainingEstimate(quoted, spent);
      if (left) expect(left.lowMinutes).toBeGreaterThan(0);
    }
  });

  it('moves OUT when the queue got busier since the order was placed', () => {
    // Same order, 4 minutes in, but 12 orders are now open: 20–30 quoted,
    // so 16–26 left — later than the 6–16 it would have had. An estimate that
    // could only shrink would be a countdown, not an estimate.
    expect(remainingEstimate(readyEstimate(state({ openOrderCount: 12 })), 4)?.label).toBe(
      '16–26 min',
    );
  });

  it('ignores a clock skewed backwards rather than lengthening the wait', () => {
    expect(remainingEstimate(quoted, -5)).toEqual(quoted);
  });
});
