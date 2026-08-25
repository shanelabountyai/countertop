import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, validateComposition } from './composition';
import type { CompositionViolation } from './composition';
import { SAMPLE_MENU, menuWith } from './sample-menu';
import type { Composition, Menu, ModifierOption } from './types';

// Violations are asserted BY REASON, never by "it failed" — a function that
// refused everything would pass a boolean-only suite.
const check = (c: Composition, menu: Menu = SAMPLE_MENU) => validateComposition(menu, c);

const kinds = (c: Composition, menu: Menu = SAMPLE_MENU): CompositionViolation['kind'][] => {
  const result = check(c, menu);
  return result.ok ? [] : result.violations.map((v) => v.kind);
};

const violation = (c: Composition, menu: Menu = SAMPLE_MENU): CompositionViolation => {
  const result = check(c, menu);
  if (result.ok) throw new Error('expected the composition to be refused');
  const [first] = result.violations;
  if (!first) throw new Error('refused with no reason given');
  return first;
};

/** A valid burrito, for tests that want to change exactly one thing about it. */
const burrito = (overrides: Partial<Composition> = {}): Composition => ({
  itemId: 'burrito',
  quantity: 1,
  selections: [{ groupId: 'protein', optionId: 'chicken' }],
  ...overrides,
});

describe('a composition that is fine', () => {
  it('accepts the simplest possible line', () => {
    expect(check({ itemId: 'chips', quantity: 1, selections: [] })).toEqual({ ok: true });
  });

  it('accepts a fully composed burrito', () => {
    expect(
      check(
        burrito({
          selections: [
            { groupId: 'protein', optionId: 'steak' },
            { groupId: 'addons', optionId: 'guacamole' },
            { groupId: 'salsa', optionId: 'chipotle', intensity: 'light' },
            { groupId: 'toppings', optionId: 'onions', intensity: 'none' },
          ],
          note: 'cut in half please',
        }),
      ),
    ).toEqual({ ok: true });
  });
});

describe('required groups (P0-1: skipping protein blocks checkout)', () => {
  it('refuses a burrito with no protein, and says so in words a customer can act on', () => {
    const v = violation(burrito({ selections: [] }));
    expect(v.kind).toBe('group_required');
    expect(v).toMatchObject({ groupId: 'protein' });
    expect(v.message).toMatch(/protein/i);
  });

  // THE ONE THAT WOULD ACTUALLY SHIP FOOD WRONG. "No chicken" is a negation,
  // not a choice of protein — if `none` satisfied a required group, a customer
  // could order a burrito with no protein in it and the kitchen would never
  // know a choice was skipped.
  it('does not let an intensity of `none` satisfy a required group', () => {
    const menu = menuWith((m) => {
      const protein = m.groups.protein;
      if (protein) protein.intensityEnabled = true;
    });
    const v = violation(
      burrito({ selections: [{ groupId: 'protein', optionId: 'chicken', intensity: 'none' }] }),
      menu,
    );
    expect(v.kind).toBe('group_required');
  });

  it('refuses a taco plate with one filling when two are required', () => {
    const v = violation({
      itemId: 'taco-plate',
      quantity: 1,
      selections: [{ groupId: 'fillings', optionId: 'fish' }],
    });
    expect(v).toMatchObject({ kind: 'below_min', groupId: 'fillings', min: 2, selected: 1 });
  });

  it('accepts the taco plate at exactly the minimum', () => {
    expect(
      check({
        itemId: 'taco-plate',
        quantity: 1,
        selections: [
          { groupId: 'fillings', optionId: 'fish' },
          { groupId: 'fillings', optionId: 'mushroom' },
        ],
      }),
    ).toEqual({ ok: true });
  });
});

describe('min/max selection rules', () => {
  it('refuses more add-ons than the group allows', () => {
    const menu = menuWith((m) => {
      m.groups.addons?.options.push({
        id: 'sour-cream',
        name: 'Sour cream',
        priceDeltaCents: 50,
        available: true,
      } satisfies ModifierOption);
    });
    const v = violation(
      burrito({
        selections: [
          { groupId: 'protein', optionId: 'chicken' },
          { groupId: 'addons', optionId: 'guacamole' },
          { groupId: 'addons', optionId: 'queso' },
          { groupId: 'addons', optionId: 'tortilla' },
          { groupId: 'addons', optionId: 'sour-cream' },
        ],
      }),
      menu,
    );
    expect(v).toMatchObject({ kind: 'above_max', groupId: 'addons', max: 3, selected: 4 });
  });

  it('accepts exactly the maximum', () => {
    expect(
      check(
        burrito({
          selections: [
            { groupId: 'protein', optionId: 'chicken' },
            { groupId: 'addons', optionId: 'guacamole' },
            { groupId: 'addons', optionId: 'queso' },
            { groupId: 'addons', optionId: 'tortilla' },
          ],
        }),
      ),
    ).toEqual({ ok: true });
  });

  it('refuses two picks in a single-select group', () => {
    const v = violation({
      itemId: 'bowl',
      quantity: 1,
      selections: [
        { groupId: 'size', optionId: 'small' },
        { groupId: 'size', optionId: 'large' },
        { groupId: 'protein', optionId: 'chicken' },
      ],
    });
    expect(v).toMatchObject({ kind: 'above_max', groupId: 'size', max: 1, selected: 2 });
  });

  // A negation is not one of your three picks. "No onions, plus these three
  // toppings" must not count as four.
  it('does not count `none` selections toward the maximum', () => {
    expect(
      check(
        burrito({
          selections: [
            { groupId: 'protein', optionId: 'chicken' },
            { groupId: 'toppings', optionId: 'onions', intensity: 'none' },
            { groupId: 'toppings', optionId: 'cilantro', intensity: 'regular' },
            { groupId: 'toppings', optionId: 'cheese', intensity: 'extra' },
            { groupId: 'salsa', optionId: 'verde' },
          ],
        }),
      ),
    ).toEqual({ ok: true });
  });

  it('refuses the same option twice', () => {
    const v = violation(
      burrito({
        selections: [
          { groupId: 'protein', optionId: 'chicken' },
          { groupId: 'addons', optionId: 'guacamole' },
          { groupId: 'addons', optionId: 'guacamole' },
        ],
      }),
    );
    expect(v).toMatchObject({ kind: 'duplicate_option', groupId: 'addons', optionId: 'guacamole' });
  });
});

describe('availability at two grains (P0-6)', () => {
  it('refuses an 86-ed item', () => {
    const menu = menuWith((m) => {
      const item = m.items.burrito;
      if (item) item.available = false;
    });
    const v = violation(burrito(), menu);
    expect(v.kind).toBe('item_unavailable');
    expect(v.message).toMatch(/sold out/i);
  });

  // Out of guacamole ≠ out of burritos. The burrito is still orderable; the
  // guacamole line is what is refused.
  it('refuses an 86-ed option without condemning the item', () => {
    const menu = menuWith((m) => {
      const option = m.groups.addons?.options.find((o) => o.id === 'guacamole');
      if (option) option.available = false;
    });
    expect(check(burrito(), menu)).toEqual({ ok: true });
    expect(
      violation(
        burrito({
          selections: [
            { groupId: 'protein', optionId: 'chicken' },
            { groupId: 'addons', optionId: 'guacamole' },
          ],
        }),
        menu,
      ),
    ).toMatchObject({ kind: 'option_unavailable', groupId: 'addons', optionId: 'guacamole' });
  });

  // Asking for NO onions when the kitchen has no onions is trivially
  // satisfiable. Refusing it would be absurd, and it is exactly the case a
  // naive availability check gets wrong.
  it('allows a `none` selection of an 86-ed option', () => {
    const menu = menuWith((m) => {
      const option = m.groups.toppings?.options.find((o) => o.id === 'onions');
      if (option) option.available = false;
    });
    expect(
      check(
        burrito({
          selections: [
            { groupId: 'protein', optionId: 'chicken' },
            { groupId: 'toppings', optionId: 'onions', intensity: 'none' },
          ],
        }),
        menu,
      ),
    ).toEqual({ ok: true });
  });
});

describe('selections that do not belong', () => {
  it('refuses an unknown item', () => {
    expect(violation({ itemId: 'lobster', quantity: 1, selections: [] })).toMatchObject({
      kind: 'unknown_item',
    });
  });

  it('refuses a group the item does not offer', () => {
    expect(
      violation({
        itemId: 'chips',
        quantity: 1,
        selections: [{ groupId: 'protein', optionId: 'steak' }],
      }),
    ).toMatchObject({ kind: 'unknown_group', groupId: 'protein' });
  });

  it('refuses an option that is not in the group named', () => {
    expect(
      violation(
        burrito({
          selections: [
            { groupId: 'protein', optionId: 'chicken' },
            { groupId: 'addons', optionId: 'steak' },
          ],
        }),
      ),
    ).toMatchObject({ kind: 'unknown_option', groupId: 'addons', optionId: 'steak' });
  });

  it('refuses an intensity on a group that does not enable it', () => {
    expect(
      violation(burrito({ selections: [{ groupId: 'protein', optionId: 'chicken', intensity: 'extra' }] })),
    ).toMatchObject({ kind: 'intensity_not_supported', groupId: 'protein' });
  });
});

describe('server-enforced caps (P0-3)', () => {
  it('refuses quantity 0', () => {
    expect(violation(burrito({ quantity: 0 }))).toMatchObject({ kind: 'quantity_out_of_range' });
  });

  it('refuses a fractional quantity', () => {
    expect(violation(burrito({ quantity: 1.5 }))).toMatchObject({ kind: 'quantity_out_of_range' });
  });

  it('accepts the default cap and refuses one past it', () => {
    expect(check(burrito({ quantity: DEFAULT_LIMITS.maxQuantity }))).toEqual({ ok: true });
    expect(violation(burrito({ quantity: DEFAULT_LIMITS.maxQuantity + 1 }))).toMatchObject({
      kind: 'quantity_out_of_range',
      maxQuantity: 20,
    });
  });

  it('honours a configured cap instead of the default', () => {
    const result = validateComposition(SAMPLE_MENU, burrito({ quantity: 6 }), {
      ...DEFAULT_LIMITS,
      maxQuantity: 5,
    });
    expect(result).toMatchObject({ ok: false });
  });

  it('accepts a note at exactly 140 characters and refuses 141', () => {
    expect(check(burrito({ note: 'x'.repeat(140) }))).toEqual({ ok: true });
    expect(violation(burrito({ note: 'x'.repeat(141) }))).toMatchObject({
      kind: 'note_too_long',
      length: 141,
      maxNoteLength: 140,
    });
  });
});

describe('reporting', () => {
  it('reports every violation at once, not just the first', () => {
    const found = kinds({
      itemId: 'burrito',
      quantity: 0,
      selections: [{ groupId: 'addons', optionId: 'caviar' }],
      note: 'x'.repeat(200),
    });
    expect(found).toContain('quantity_out_of_range');
    expect(found).toContain('note_too_long');
    expect(found).toContain('unknown_option');
    expect(found).toContain('group_required');
  });
});

describe('the modifier structure is one level deep (P0-1)', () => {
  it('gives an option nowhere to hang a nested group', () => {
    const option: ModifierOption = {
      id: 'guacamole',
      name: 'Guacamole',
      priceDeltaCents: 250,
      available: true,
      // @ts-expect-error — options cannot own modifier groups. Combos and
      // nesting are P2; the type is what makes that structural rather than a
      // convention someone forgets.
      groups: [],
    };
    expect(option.id).toBe('guacamole');
  });
});
