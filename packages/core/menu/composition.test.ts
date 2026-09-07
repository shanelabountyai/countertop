import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, validateComposition } from './composition';
import type { CompositionViolation } from './composition';
import { SAMPLE_MENU, menuWith } from './sample-menu';
import type { RestaurantClock } from '../orders/business-day';
import type { Composition, Menu, ModifierOption } from './types';

// Monday lunchtime. Every item in SAMPLE_MENU is served all day, so this
// reading is arbitrary for the whole suite EXCEPT the daypart block at the
// bottom, which supplies its own.
const NOON: RestaurantClock = { day: '2026-09-07', weekday: 1, minuteOfDay: 12 * 60 };

// Violations are asserted BY REASON, never by "it failed" — a function that
// refused everything would pass a boolean-only suite.
const check = (c: Composition, menu: Menu = SAMPLE_MENU, clock: RestaurantClock = NOON) =>
  validateComposition(menu, c, clock);

const kinds = (
  c: Composition,
  menu: Menu = SAMPLE_MENU,
  clock: RestaurantClock = NOON,
): CompositionViolation['kind'][] => {
  const result = check(c, menu, clock);
  return result.ok ? [] : result.violations.map((v) => v.kind);
};

const violation = (
  c: Composition,
  menu: Menu = SAMPLE_MENU,
  clock: RestaurantClock = NOON,
): CompositionViolation => {
  const result = check(c, menu, clock);
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
    const result = validateComposition(SAMPLE_MENU, burrito({ quantity: 6 }), NOON, {
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

// P1-1. The 4pm lunch-to-dinner changeover, which the PRD calls the most
// common menu operation in fast casual and which was a manager 86'ing eleven
// items from a phone.
//
// Every reading here is FROZEN and handed in. Nothing in this file reads a
// clock, which is the whole reason the daypart check could go inside the one
// orderability function instead of beside it.
describe('dayparts (P1-1)', () => {
  // Friday, because the window is a Friday window: a check that filtered by
  // nothing would pass on any day and this suite would not notice.
  const FRIDAY = (minuteOfDay: number): RestaurantClock => ({
    day: '2026-09-11',
    weekday: 5,
    minuteOfDay,
  });

  /** The taco plate, served Friday 16:00–21:00 and not otherwise. */
  const dinnerOnly = (): Menu =>
    menuWith((m) => {
      m.items['taco-plate']!.windows = [{ dayOfWeek: 5, startMinute: 16 * 60, endMinute: 21 * 60 }];
    });

  // Two fillings, because the group requires two — a fixture short of a
  // required group would refuse for the wrong reason and every assertion
  // below would be about `below_min`.
  const tacos: Composition = {
    itemId: 'taco-plate',
    quantity: 1,
    selections: [
      { groupId: 'fillings', optionId: 'al-pastor' },
      { groupId: 'fillings', optionId: 'fish' },
    ],
  };

  it('refuses at 15:59 and accepts at 16:01', () => {
    expect(violation(tacos, dinnerOnly(), FRIDAY(15 * 60 + 59))).toMatchObject({
      kind: 'item_outside_daypart',
      message: 'Taco plate is served 16:00–21:00.',
    });
    expect(check(tacos, dinnerOnly(), FRIDAY(16 * 60 + 1))).toEqual({ ok: true });
  });

  it('treats the window as half-open: served at 16:00, not at 21:00', () => {
    // The changeover minute belongs to dinner and to nothing else. An
    // inclusive end would make 21:00 the one minute of the day when a closed
    // window is still open.
    expect(check(tacos, dinnerOnly(), FRIDAY(16 * 60))).toEqual({ ok: true });
    expect(kinds(tacos, dinnerOnly(), FRIDAY(21 * 60))).toEqual(['item_outside_daypart']);
  });

  it('serves an item with no windows at every minute of every day', () => {
    // The overwhelming default, and the reason `windows` is optional rather
    // than a required empty list.
    expect(check(tacos, SAMPLE_MENU, FRIDAY(3 * 60))).toEqual({ ok: true });
  });

  it('refuses on a day the item has no window at all', () => {
    // Absence is the closed signal, same as a missing StoreHours row: a
    // deleted window cannot leave an item on the menu.
    const saturday: RestaurantClock = { day: '2026-09-12', weekday: 6, minuteOfDay: 18 * 60 };
    expect(violation(tacos, dinnerOnly(), saturday)).toMatchObject({
      kind: 'item_outside_daypart',
      message: "Taco plate is not on today's menu.",
    });
  });

  it('reads two windows on one day as one sentence, in clock order', () => {
    const split = menuWith((m) => {
      m.items['taco-plate']!.windows = [
        { dayOfWeek: 5, startMinute: 16 * 60, endMinute: 21 * 60 },
        { dayOfWeek: 5, startMinute: 7 * 60, endMinute: 11 * 60 },
      ];
    });
    // 13:00 is between them — the gap is real and the sentence names both
    // sides of it. This is what a child table buys over a column pair.
    expect(violation(tacos, split, FRIDAY(13 * 60))).toMatchObject({
      message: 'Taco plate is served 07:00–11:00 and 16:00–21:00.',
    });
    expect(check(tacos, split, FRIDAY(8 * 60))).toEqual({ ok: true });
  });

  it('renders an end of 1440 as midnight, not 24:00', () => {
    const lateNight = menuWith((m) => {
      m.items['taco-plate']!.windows = [{ dayOfWeek: 5, startMinute: 22 * 60, endMinute: 1440 }];
    });
    expect(violation(tacos, lateNight, FRIDAY(12 * 60))).toMatchObject({
      message: 'Taco plate is served 22:00–midnight.',
    });
  });

  // The Open Question this item turned on, answered in code: dayparts and 86s
  // are separate facts and only one of them is ever the reason.
  it('says "sold out", not the schedule, when the item is BOTH', () => {
    // A cook killed it at 12:40; it is not "back at 16:00" and telling a
    // customer it is would be a promise the kitchen has not made.
    const killed = menuWith((m) => {
      m.items['taco-plate']!.available = false;
      m.items['taco-plate']!.windows = [{ dayOfWeek: 5, startMinute: 16 * 60, endMinute: 21 * 60 }];
    });
    expect(kinds(tacos, killed, FRIDAY(18 * 60))).toEqual(['item_unavailable']);
    expect(kinds(tacos, killed, FRIDAY(15 * 60))).toEqual(['item_unavailable']);
  });

  it('leaves an 86 in place when the window reopens', () => {
    // The C-012 decision, structurally: a schedule restores by design and an
    // 86 does not, so 16:00 must not un-86 anything. Sharing one boolean is
    // exactly the change that would break this.
    const killed = menuWith((m) => {
      m.items['taco-plate']!.available = false;
      m.items['taco-plate']!.windows = [{ dayOfWeek: 5, startMinute: 16 * 60, endMinute: 21 * 60 }];
    });
    expect(check(tacos, killed, FRIDAY(17 * 60)).ok).toBe(false);
  });

  it('is a fact about the ITEM, not the options under it', () => {
    // A daypart on the plate does not silently daypart al pastor, which is
    // shared with other items. Option-grain schedules are not modelled.
    const other: Composition = {
      itemId: 'burrito',
      quantity: 1,
      selections: [{ groupId: 'protein', optionId: 'chicken' }],
    };
    expect(check(other, dinnerOnly(), FRIDAY(9 * 60))).toEqual({ ok: true });
  });
});

// The same window, read in two timezones that disagree about what day it is.
// This is what the TZ×2 CI run is for, and it passes for a structural reason:
// nothing above converts anything — the reading arrives already converted.
describe('dayparts do not read the process timezone (P1-1)', () => {
  it('answers from the reading it was handed, whatever TZ the runner is in', () => {
    const menu = menuWith((m) => {
      m.items.chips!.windows = [{ dayOfWeek: 5, startMinute: 16 * 60, endMinute: 21 * 60 }];
    });
    const chips: Composition = { itemId: 'chips', quantity: 1, selections: [] };
    expect(check(chips, menu, { day: '2026-09-11', weekday: 5, minuteOfDay: 16 * 60 + 1 })).toEqual(
      { ok: true },
    );
    expect(
      kinds(chips, menu, { day: '2026-09-11', weekday: 5, minuteOfDay: 15 * 60 + 59 }),
    ).toEqual(['item_outside_daypart']);
  });
});
