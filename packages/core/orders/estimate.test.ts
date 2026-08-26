import { describe, expect, it } from 'vitest';
import { readyEstimate, type EstimateState } from './estimate';

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
