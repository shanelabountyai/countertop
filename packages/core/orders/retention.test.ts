import { describe, expect, it } from 'vitest';
import { instantMinutesAfter } from './business-day';
import { FORGOTTEN_CUSTOMER_NAME, retentionCutoff } from './retention';

// A frozen `now`, like every engine test here. The sweep destroys data from
// this arithmetic, so an off-by-one day is a customer's name kept a day too
// long or a day too few.
const NOW = new Date(Date.UTC(2026, 8, 2, 19, 0, 0));

describe('retentionCutoff', () => {
  it('is exactly the window back from now, to the millisecond', () => {
    expect(retentionCutoff(NOW, 365)).toEqual(new Date(Date.UTC(2025, 8, 2, 19, 0, 0)));
    expect(retentionCutoff(NOW, 1)).toEqual(new Date(Date.UTC(2026, 8, 1, 19, 0, 0)));
  });

  it('moves with `now` and with nothing else', () => {
    const later = instantMinutesAfter(NOW, 1440);
    expect(retentionCutoff(later, 365).getTime() - retentionCutoff(NOW, 365).getTime()).toBe(
      86_400_000,
    );
  });
});

describe('FORGOTTEN_CUSTOMER_NAME', () => {
  // It is written into a VarChar(40) and rendered as a name on the receipt,
  // the queue card and the chase list.
  it('fits the column and cannot be mistaken for somebody', () => {
    expect(FORGOTTEN_CUSTOMER_NAME.length).toBeLessThanOrEqual(40);
    expect(FORGOTTEN_CUSTOMER_NAME).toMatch(/^\(.*\)$/);
  });
});
