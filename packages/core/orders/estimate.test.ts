import { describe, expect, it } from 'vitest';
import {
  estimateAccuracy,
  readyEstimate,
  remainingEstimate,
  type EstimateState,
  type QuoteSample,
} from './estimate';

// Firebird Kitchen's defaults: 12 minutes for a ticket with nothing in front
// of it, one more minute per unit of work already open (P1-7 — a burrito is 2,
// a bottle of water is 0).
const state = (overrides: Partial<EstimateState> = {}): EstimateState => ({
  prepBaseMinutes: 12,
  prepPerWeightMinutes: 1,
  openWeight: 0,
  ...overrides,
});

describe('readyEstimate', () => {
  it('is a range, never a point', () => {
    const estimate = readyEstimate(state());
    expect(estimate.highMinutes).toBeGreaterThan(estimate.lowMinutes);
    expect(estimate.label).toBe('10–20 min');
  });

  it('grows with the WORK in the queue, not the ticket count', () => {
    // 12 + 4 = 16 -> the 15 step, so the whole range moves up together. Four
    // units of work is two burritos, or four ticketsful of bottled water
    // (which is zero) — the estimate can now tell those apart.
    expect(readyEstimate(state({ openWeight: 4 })).label).toBe('15–25 min');
    expect(readyEstimate(state({ openWeight: 12 })).label).toBe('20–30 min');
  });

  it('honours a per-weight increment above one minute', () => {
    expect(readyEstimate(state({ prepPerWeightMinutes: 3, openWeight: 6 })).label).toBe(
      '30–40 min',
    );
  });

  it('rounds the low end DOWN, so the promise cannot drift later', () => {
    // 19 minutes of arithmetic must not be sold as "20–30".
    expect(readyEstimate(state({ openWeight: 7 })).lowMinutes).toBe(15);
  });

  it('never promises "right now", whatever the settings say', () => {
    expect(readyEstimate(state({ prepBaseMinutes: 0 })).label).toBe('5–15 min');
    expect(readyEstimate(state({ prepBaseMinutes: 2, openWeight: 0 })).lowMinutes).toBe(5);
  });

  it('ignores a negative open weight rather than shortening the estimate', () => {
    expect(readyEstimate(state({ openWeight: -5 }))).toEqual(readyEstimate(state()));
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
    expect(remainingEstimate(readyEstimate(state({ openWeight: 12 })), 4)?.label).toBe(
      '16–26 min',
    );
  });

  it('ignores a clock skewed backwards rather than lengthening the wait', () => {
    expect(remainingEstimate(quoted, -5)).toEqual(quoted);
  });
});

// --- P1-4: grading the promise (C-042) -------------------------------------

// A quote of 15–25 min, which is what the default settings say for a queue of
// four. `at` is what the kitchen actually took.
const sample = (actualMinutes: number, quotedOpenWeight = 4): QuoteSample => ({
  quotedLowMinutes: 15,
  quotedHighMinutes: 25,
  quotedOpenWeight,
  actualMinutes,
});

/** n samples, all the same. Enough of them to clear MIN_SAMPLES. */
const many = (actualMinutes: number, count = 12, quotedOpenWeight = 4): QuoteSample[] =>
  Array.from({ length: count }, () => sample(actualMinutes, quotedOpenWeight));

describe('estimateAccuracy (P1-4)', () => {
  it('counts anywhere inside the window as on time — that is what a range is for', () => {
    const accuracy = estimateAccuracy([sample(15), sample(20), sample(25)]);
    expect(accuracy.all.onTime).toBe(3);
    expect(accuracy.all.medianMissMinutes).toBe(0);
  });

  it('separates early from late, and counts early as a miss', () => {
    const accuracy = estimateAccuracy([sample(6), sample(20), sample(40)]);
    expect(accuracy.all).toMatchObject({ samples: 3, early: 1, onTime: 1, late: 1 });
    // -9, 0, +15 → the median order landed inside the window.
    expect(accuracy.all.medianMissMinutes).toBe(0);
  });

  it('measures the miss from the nearest EDGE, never from the centre', () => {
    expect(estimateAccuracy([sample(31)]).all.medianMissMinutes).toBe(6);
    expect(estimateAccuracy([sample(9)]).all.medianMissMinutes).toBe(-6);
  });

  it('says nothing at all with no samples', () => {
    const accuracy = estimateAccuracy([]);
    expect(accuracy.all).toMatchObject({ samples: 0, medianMissMinutes: null });
    expect(accuracy.suggestion).toBeNull();
  });

  it('refuses to retune a restaurant off a handful of orders', () => {
    // Every one of them 20 minutes late, and it still suggests nothing.
    expect(estimateAccuracy(many(45, 9)).suggestion).toBeNull();
    expect(estimateAccuracy(many(45, 10)).suggestion).not.toBeNull();
  });

  it('ignores a miss smaller than the rounding the estimate already does', () => {
    // 27 against a 15–25 window: two minutes out, under one 5-minute step.
    expect(estimateAccuracy(many(27)).suggestion).toBeNull();
  });

  it('blames the BASE when every queue depth misses the same way', () => {
    const flat = [...many(45, 6, 0), ...many(45, 6, 40)];
    expect(estimateAccuracy(flat).suggestion).toEqual({
      setting: 'prepBaseMinutes',
      direction: 'up',
    });
  });

  it('blames the INCREMENT when only the busy half runs late', () => {
    // Light queue lands inside the window; the busy half is half an hour out.
    const uneven = [...many(20, 6, 0), ...many(55, 6, 40)];
    const accuracy = estimateAccuracy(uneven);
    expect(accuracy.lightQueue.medianMissMinutes).toBe(0);
    expect(accuracy.busyQueue.medianMissMinutes).toBe(30);
    expect(accuracy.suggestion).toEqual({
      setting: 'prepPerWeightMinutes',
      direction: 'up',
    });
  });

  it('sends the setting DOWN when the food is consistently ready early', () => {
    expect(estimateAccuracy(many(4)).suggestion).toEqual({
      setting: 'prepBaseMinutes',
      direction: 'down',
    });
  });

  it('splits at the median open weight, not at the order it was handed in', () => {
    // Handed over busiest-first: the split must still put 0 and 1 in the light
    // half, because it sorts by the queue and not by the array.
    const accuracy = estimateAccuracy([
      sample(50, 40),
      sample(50, 30),
      sample(16, 1),
      sample(16, 0),
    ]);
    expect(accuracy.lightQueue.medianMissMinutes).toBe(0);
    expect(accuracy.busyQueue.medianMissMinutes).toBe(25);
  });
});
