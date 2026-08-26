import { describe, expect, it } from 'vitest';
import { SAMPLE_MENU } from '../menu/sample-menu';
import type { Composition } from '../menu/types';
import {
  checkClientTotal,
  parsePriceInput,
  priceLine,
  priceOrder,
  taxOn,
  taxRatePpmFromPercent,
} from './pricing';

// EVERY number below is hand-calculated from packages/core/menu/sample-menu.ts
// and written out longhand. A fixture whose expected value came from running
// the code is not a fixture, it is a screenshot of a bug.

const RATE_8_25 = 82_500; // 8.25% — the PRD's default
const NO_TAX = 0;

const line = (c: Composition) => priceLine(SAMPLE_MENU, c);

describe('taxRatePpmFromPercent', () => {
  it('converts the PRD default', () => {
    expect(taxRatePpmFromPercent(8.25)).toBe(82_500);
  });

  it('expresses a rate basis points cannot (8.875% = 887.5bp)', () => {
    expect(taxRatePpmFromPercent(8.875)).toBe(88_750);
  });

  it('converts zero', () => {
    expect(taxRatePpmFromPercent(0)).toBe(0);
  });
});

describe('taxOn — the one rounding operation in the engine', () => {
  // THE BOUNDARY CENT. $10.00 × 8.25% = $0.825 exactly — a half-cent, dead on
  // the rounding boundary. Half-up: 83, not 82. This is the fixture that fails
  // if the rate is ever held as a float.
  it('rounds a dead-on half-cent up', () => {
    expect(taxOn(1000, RATE_8_25)).toBe(83);
  });

  it('rounds below the half-cent down: 500 × 8.25% = 41.25', () => {
    expect(taxOn(500, RATE_8_25)).toBe(41);
  });

  it('rounds above the half-cent up: 1199 × 8.25% = 98.9175', () => {
    expect(taxOn(1199, RATE_8_25)).toBe(99);
  });

  it('leaves an exact result alone: 4000 × 8.25% = 330', () => {
    expect(taxOn(4000, RATE_8_25)).toBe(330);
  });

  it('is zero at a zero rate, whatever the subtotal', () => {
    expect(taxOn(9_999_999, NO_TAX)).toBe(0);
  });

  it('is zero on a zero subtotal', () => {
    expect(taxOn(0, RATE_8_25)).toBe(0);
  });

  it('refuses a non-integer subtotal rather than rounding one silently', () => {
    expect(() => taxOn(10.5, RATE_8_25)).toThrow(/integer cents/i);
  });

  it('refuses a negative subtotal', () => {
    expect(() => taxOn(-100, RATE_8_25)).toThrow(/negative/i);
  });
});

describe('priceLine — (base + Σ deltas) × quantity', () => {
  it('prices an item with no modifiers at all: chips 350 × 3 = 1050', () => {
    expect(line({ itemId: 'chips', quantity: 3, selections: [] })).toEqual({
      unitPriceCents: 350,
      quantity: 3,
      lineTotalCents: 1050,
    });
  });

  // QUANTITY MATH: the deltas are inside the multiplication, not added after
  // it. 1095 + 150 + 250 = 1495; × 2 = 2990. Adding deltas outside the
  // multiply would give 1095×2 + 400 = 2590 — a $4.00 undercharge.
  it('multiplies AFTER summing the deltas: burrito + carnitas + guac, ×2', () => {
    expect(
      line({
        itemId: 'burrito',
        quantity: 2,
        selections: [
          { groupId: 'protein', optionId: 'carnitas' },
          { groupId: 'addons', optionId: 'guacamole' },
        ],
      }),
    ).toEqual({ unitPriceCents: 1495, quantity: 2, lineTotalCents: 2990 });
  });

  // NEGATIVE DELTAS, twice over, and S/M/L priced through the same mechanism
  // as everything else: 1195 − 150 (small) − 100 (veggie) = 945.
  it('subtracts negative deltas: small veggie bowl', () => {
    expect(
      line({
        itemId: 'bowl',
        quantity: 1,
        selections: [
          { groupId: 'size', optionId: 'small' },
          { groupId: 'protein', optionId: 'veggie' },
        ],
      }),
    ).toEqual({ unitPriceCents: 945, quantity: 1, lineTotalCents: 945 });
  });

  // INTENSITY, PRICED. Cheese is +50; at `extra` it costs its delta PLUS the
  // extra surcharge of +75. 1095 + 0 + 50 + 75 = 1220.
  it('charges the extra surcharge on top of the delta at `extra`', () => {
    expect(
      line({
        itemId: 'burrito',
        quantity: 1,
        selections: [
          { groupId: 'protein', optionId: 'chicken' },
          { groupId: 'toppings', optionId: 'cheese', intensity: 'extra' },
        ],
      }).unitPriceCents,
    ).toBe(1220);
  });

  it('charges `light` and `regular` alike — light sauce is not a discount', () => {
    const at = (intensity: 'light' | 'regular') =>
      line({
        itemId: 'burrito',
        quantity: 1,
        selections: [
          { groupId: 'protein', optionId: 'chicken' },
          { groupId: 'toppings', optionId: 'cheese', intensity },
        ],
      }).unitPriceCents;
    expect(at('light')).toBe(1145);
    expect(at('regular')).toBe(1145);
  });

  it('treats an omitted intensity as `regular`', () => {
    expect(
      line({
        itemId: 'burrito',
        quantity: 1,
        selections: [
          { groupId: 'protein', optionId: 'chicken' },
          { groupId: 'toppings', optionId: 'cheese' },
        ],
      }).unitPriceCents,
    ).toBe(1145);
  });

  // A NEGATION IS FREE. "No cheese" charges nothing even though cheese has a
  // +50 delta — you are not getting it.
  it('charges nothing for an option taken at `none`', () => {
    expect(
      line({
        itemId: 'burrito',
        quantity: 1,
        selections: [
          { groupId: 'protein', optionId: 'chicken' },
          { groupId: 'toppings', optionId: 'cheese', intensity: 'none' },
        ],
      }).unitPriceCents,
    ).toBe(1095);
  });

  it('ignores an extra surcharge when the option is not taken at `extra`', () => {
    expect(
      line({
        itemId: 'burrito',
        quantity: 1,
        selections: [
          { groupId: 'protein', optionId: 'chicken' },
          { groupId: 'salsa', optionId: 'chipotle', intensity: 'regular' },
        ],
      }).unitPriceCents,
    ).toBe(1095);
  });

  it('throws on an unknown item rather than pricing it at zero', () => {
    expect(() => line({ itemId: 'nope', quantity: 1, selections: [] })).toThrow(/nope/);
  });

  it('throws on an unknown option rather than pricing it at zero', () => {
    expect(() =>
      line({
        itemId: 'burrito',
        quantity: 1,
        selections: [{ groupId: 'addons', optionId: 'caviar' }],
      }),
    ).toThrow(/caviar/);
  });
});

describe('priceOrder — Σ lines + tax', () => {
  // 2990 (burrito fixture) + 945 (bowl fixture) = 3935 subtotal.
  // 3935 × 8.25% = 324.6375 → 325. Total 3935 + 325 = 4260.
  const lines = [
    { unitPriceCents: 1495, quantity: 2, lineTotalCents: 2990 },
    { unitPriceCents: 945, quantity: 1, lineTotalCents: 945 },
  ];

  it('sums the lines, taxes the subtotal, and keeps all three distinct', () => {
    expect(priceOrder(lines, RATE_8_25)).toEqual({
      subtotalCents: 3935,
      taxCents: 325,
      totalCents: 4260,
    });
  });

  it('still reports a tax line at a zero rate', () => {
    expect(priceOrder(lines, NO_TAX)).toEqual({
      subtotalCents: 3935,
      taxCents: 0,
      totalCents: 3935,
    });
  });

  it('taxes the SUBTOTAL once, not each line — 2990 and 945 taxed apart give 247+78=325 by luck, not by rule', () => {
    // The point of the fixture: assert the documented rule (one rounding, on
    // the subtotal) rather than an arithmetic coincidence.
    expect(priceOrder(lines, RATE_8_25).taxCents).toBe(taxOn(3935, RATE_8_25));
  });

  it('is zero across the board for an empty order', () => {
    expect(priceOrder([], RATE_8_25)).toEqual({
      subtotalCents: 0,
      taxCents: 0,
      totalCents: 0,
    });
  });
});

describe('checkClientTotal — the client total is evidence, never input', () => {
  // THE TAMPERED TOTAL (P0-2). A request claiming $0 does not change what is
  // charged; it produces a mismatch record to be logged.
  it('reports a mismatch for a tampered $0 total', () => {
    expect(checkClientTotal(4260, 0)).toEqual({
      serverTotalCents: 4260,
      clientTotalCents: 0,
    });
  });

  it('reports a mismatch when the client is merely stale, not malicious', () => {
    expect(checkClientTotal(4260, 4010)).toEqual({
      serverTotalCents: 4260,
      clientTotalCents: 4010,
    });
  });

  it('returns null when they agree', () => {
    expect(checkClientTotal(4260, 4260)).toBeNull();
  });
});

describe('parsePriceInput — the typed price becomes cents, or nothing', () => {
  // THE FAT-FINGER (P0-13). The $1.50 → $15.00 slip is a legal price, so no
  // parser can catch it — that is what the confirm-on-save step is for. What
  // this function must never do is turn a typo into a plausible number.
  it.each([
    ['15', 1500],
    ['15.00', 1500],
    ['$15', 1500],
    ['9.5', 950],
    ['0', 0],
    ['-1.50', -150],
    ['−1.50', -150], // U+2212, which is what the menu itself renders
    ['  2.25  ', 225],
  ])('reads %j as %i cents', (text, cents) => {
    expect(parsePriceInput(text)).toBe(cents);
  });

  // 15.10 * 100 is 1509.9999999999998 in binary floating point. Parsed off the
  // string it cannot be anything but 1510.
  it('is exact on the value that floating point gets wrong', () => {
    expect(parsePriceInput('15.10')).toBe(1510);
    expect(parsePriceInput('1.005')).toBeNull(); // three decimals is not money
  });

  it.each(['', ' ', 'abc', '1.5.0', '1,50', '12.345', '1e3', '--1', '10000000'])(
    'refuses %j rather than returning a number',
    (text) => {
      expect(parsePriceInput(text)).toBeNull();
    },
  );
});
