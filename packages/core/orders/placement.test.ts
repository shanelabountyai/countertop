import { describe, expect, it } from 'vitest';
import type { Cart } from '../cart/cart';
import { SAMPLE_MENU, menuWith } from '../menu/sample-menu';
import { priceOrder } from '../pricing/pricing';
import {
  buildOrderSnapshot,
  MAX_CUSTOMER_NAME_LENGTH,
  normalizeIdentity,
} from './placement';

const RATE_PPM = 82_500; // 8.25%

/**
 * Hand-calculated, and every number below is checked against it:
 *
 *   burrito                            1095
 *   + carnitas                          150
 *   + guacamole                         250
 *   + cheese at `extra` (50 + 75)       125
 *   + onions at `none` — a NEGATION       0
 *   = unit                             1620
 *   x 2                                3240 subtotal
 *   tax  3240 x 0.0825 = 267.3 ->       267
 *   = total                            3507
 */
const CART: Cart = {
  lines: [
    {
      id: 'line-1',
      unitPriceAtAddCents: 1620,
      composition: {
        itemId: 'burrito',
        quantity: 2,
        selections: [
          { groupId: 'protein', optionId: 'carnitas' },
          { groupId: 'addons', optionId: 'guacamole' },
          { groupId: 'toppings', optionId: 'cheese', intensity: 'extra' },
          { groupId: 'toppings', optionId: 'onions', intensity: 'none' },
        ],
        note: 'cut in half',
      },
    },
    {
      id: 'line-2',
      unitPriceAtAddCents: 350,
      composition: { itemId: 'chips', quantity: 1, selections: [] },
    },
  ],
};

describe('the order snapshot (P0-3, P0-9)', () => {
  it('copies names and prices as values, and totals them', () => {
    const snapshot = buildOrderSnapshot(SAMPLE_MENU, CART, RATE_PPM);

    expect(snapshot).toMatchObject({
      subtotalCents: 3240 + 350,
      taxCents: 296, // 3590 x 0.0825 = 296.175
      taxRatePpm: RATE_PPM,
      totalCents: 3590 + 296,
    });

    const [burrito, chips] = snapshot.lines;
    expect(burrito).toMatchObject({
      lineNumber: 1,
      menuItemId: 'burrito',
      itemName: 'Burrito',
      categoryName: 'Burritos & Bowls',
      basePriceCents: 1095,
      quantity: 2,
      unitPriceCents: 1620,
      lineTotalCents: 3240,
      note: 'cut in half',
    });
    // 1-based and stable: a card that renumbers its lines on a poll is a card
    // a cook misreads.
    expect(chips).toMatchObject({ lineNumber: 2, itemName: 'Chips & salsa', note: null });
  });

  it('stores what each option ACTUALLY added, negation included', () => {
    const [burrito] = buildOrderSnapshot(SAMPLE_MENU, CART, RATE_PPM).lines;

    expect(burrito?.options).toEqual([
      {
        sortOrder: 0,
        modifierGroupId: 'protein',
        modifierOptionId: 'carnitas',
        groupName: 'Protein',
        optionName: 'Carnitas',
        intensity: null, // the group has no intensity — not "regular"
        appliedDeltaCents: 150,
      },
      {
        sortOrder: 1,
        modifierGroupId: 'addons',
        modifierOptionId: 'guacamole',
        groupName: 'Add-ons',
        optionName: 'Guacamole',
        intensity: null,
        appliedDeltaCents: 250,
      },
      {
        sortOrder: 2,
        modifierGroupId: 'toppings',
        modifierOptionId: 'cheese',
        groupName: 'Toppings',
        optionName: 'Cheese',
        intensity: 'extra',
        appliedDeltaCents: 125, // 50 delta + 75 extra surcharge
      },
      {
        sortOrder: 3,
        modifierGroupId: 'toppings',
        modifierOptionId: 'onions',
        groupName: 'Toppings',
        optionName: 'Onions',
        intensity: 'none', // "NO onions" — the founding use case
        appliedDeltaCents: 0,
      },
    ]);
  });

  it('defaults a selection in an intensity group to `regular`, explicitly', () => {
    const cart: Cart = {
      lines: [
        {
          id: 'line-1',
          unitPriceAtAddCents: 1095,
          composition: {
            itemId: 'burrito',
            quantity: 1,
            selections: [
              { groupId: 'protein', optionId: 'chicken' },
              { groupId: 'salsa', optionId: 'verde' },
            ],
          },
        },
      ],
    };
    const [line] = buildOrderSnapshot(SAMPLE_MENU, cart, RATE_PPM).lines;
    expect(line?.options[1]).toMatchObject({ optionName: 'Salsa verde', intensity: 'regular' });
  });

  it('sums its options to exactly unit price minus base — the receipt adds up', () => {
    for (const line of buildOrderSnapshot(SAMPLE_MENU, CART, RATE_PPM).lines) {
      const deltas = line.options.reduce((sum, option) => sum + option.appliedDeltaCents, 0);
      expect(line.basePriceCents + deltas).toBe(line.unitPriceCents);
      expect(line.unitPriceCents * line.quantity).toBe(line.lineTotalCents);
    }
  });

  it('taxes the subtotal once, on the whole order', () => {
    const snapshot = buildOrderSnapshot(SAMPLE_MENU, CART, RATE_PPM);
    expect(snapshot.taxCents).toBe(296); // 3590 x 0.0825 = 296.175, half-up
    expect(snapshot).toMatchObject(priceOrder(snapshot.lines, RATE_PPM));
  });

  it('prices from the menu as it is NOW, not from the cart\'s stale baseline', () => {
    // The cart still says 1620. The menu says the burrito went up a dollar.
    const repriced = menuWith((menu) => {
      const burrito = menu.items.burrito;
      if (burrito) burrito.basePriceCents = 1195;
    });
    const [line] = buildOrderSnapshot(repriced, CART, RATE_PPM).lines;
    expect(line).toMatchObject({ basePriceCents: 1195, unitPriceCents: 1720 });
  });

  it('throws rather than snapshotting a zero for an item the menu lost', () => {
    const deleted = menuWith((menu) => {
      delete menu.items.burrito;
    });
    expect(() => buildOrderSnapshot(deleted, CART, RATE_PPM)).toThrow(/burrito/);
  });

  it('is an empty, zero-total snapshot for an empty cart', () => {
    expect(buildOrderSnapshot(SAMPLE_MENU, { lines: [] }, RATE_PPM)).toEqual({
      subtotalCents: 0,
      taxCents: 0,
      taxRatePpm: RATE_PPM,
      totalCents: 0,
      lines: [],
    });
  });
});

describe('order identity (P0-8)', () => {
  it('trims, and keeps the trimmed value', () => {
    expect(normalizeIdentity({ customerName: '  Dana  ' })).toEqual({
      ok: true,
      identity: { customerName: 'Dana', customerPhone: null, orderNote: null },
    });
  });

  it('requires a name — whitespace is not one', () => {
    for (const customerName of ['', '   ', undefined, null]) {
      const result = normalizeIdentity({ customerName });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.violations[0]?.kind).toBe('name_required');
    }
  });

  it('accepts a name at the column width and refuses one past it', () => {
    const atLimit = 'D'.repeat(MAX_CUSTOMER_NAME_LENGTH);
    expect(normalizeIdentity({ customerName: atLimit }).ok).toBe(true);

    const overLimit = normalizeIdentity({ customerName: `${atLimit}D` });
    expect(overLimit.ok === false && overLimit.violations[0]).toMatchObject({
      kind: 'name_too_long',
      length: 41,
      max: 40,
    });
  });

  it('normalizes an empty phone and note to null — one "absent", not three', () => {
    expect(normalizeIdentity({ customerName: 'Dana', customerPhone: '  ', orderNote: '' })).toEqual({
      ok: true,
      identity: { customerName: 'Dana', customerPhone: null, orderNote: null },
    });
  });

  it('keeps a phone and an order note when given', () => {
    expect(
      normalizeIdentity({
        customerName: 'Dana',
        customerPhone: '555-0100',
        orderNote: 'blue Honda out front',
      }),
    ).toEqual({
      ok: true,
      identity: {
        customerName: 'Dana',
        customerPhone: '555-0100',
        orderNote: 'blue Honda out front',
      },
    });
  });

  it('reports every bad field at once, not one per submit', () => {
    const result = normalizeIdentity({
      customerName: '',
      customerPhone: '5'.repeat(33),
      orderNote: 'n'.repeat(141),
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.violations.map((violation) => violation.kind)).toEqual([
      'name_required',
      'phone_too_long',
      'order_note_too_long',
    ]);
  });
});
