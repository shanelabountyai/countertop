import { describe, expect, it } from 'vitest';
import { SAMPLE_MENU, menuWith } from '../menu/sample-menu';
import type { Composition, Menu } from '../menu/types';
import type { RestaurantClock } from '../orders/business-day';
import {
  EMPTY_CART,
  addLine,
  confirmPrices,
  removeLine,
  replaceLine,
  reviewCart,
  type Cart,
  type CartError,
} from './cart';
import { parseCart, parseComposition, serializeCart } from './serialize';

// Every number here is hand-calculated from packages/core/menu/sample-menu.ts.
//
//   burrito                       1095
//     + protein chicken              0
//     + guacamole                  250   → unit 1345
//   bowl                          1195
//     + size large                 200
//     + protein steak              250   → unit 1645
//   chips & salsa                  350   → unit  350
const RATE_8_25 = 82_500;

// Monday lunchtime. Nothing in SAMPLE_MENU carries a daypart, so the reading
// is arbitrary here — it exists because the orderability function takes one,
// which is the point (P1-1).
const NOON: RestaurantClock = { day: '2026-09-07', weekday: 1, minuteOfDay: 12 * 60 };

const BURRITO_GUAC: Composition = {
  itemId: 'burrito',
  quantity: 1,
  selections: [
    { groupId: 'protein', optionId: 'chicken' },
    { groupId: 'addons', optionId: 'guacamole' },
  ],
};

const CHIPS: Composition = { itemId: 'chips', quantity: 1, selections: [] };

const add = (
  cart: Cart,
  id: string,
  composition: Composition,
  menu: Menu = SAMPLE_MENU,
  clock: RestaurantClock = NOON,
): Cart => {
  const result = addLine(menu, cart, id, composition, clock);
  if (!result.ok) throw new Error(`fixture did not add: ${kinds(result.errors).join(', ')}`);
  return result.cart;
};

const kinds = (errors: CartError[]) => errors.map((error) => error.kind);

const refusal = (result: ReturnType<typeof addLine>): CartError[] => {
  if (result.ok) throw new Error('expected a refusal');
  return result.errors;
};

describe('addLine — the cart-validation call site of the orderability function', () => {
  it('stores the composition and the unit price it was added at', () => {
    const cart = add(EMPTY_CART, 'line-1', BURRITO_GUAC);
    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0]).toEqual({
      id: 'line-1',
      composition: BURRITO_GUAC,
      unitPriceAtAddCents: 1345,
    });
  });

  it('leaves the cart it was given untouched', () => {
    const cart = add(EMPTY_CART, 'line-1', BURRITO_GUAC);
    add(cart, 'line-2', CHIPS);
    expect(cart.lines).toHaveLength(1);
    expect(EMPTY_CART.lines).toHaveLength(0);
  });

  it('refuses a quantity over the server-side cap, by reason', () => {
    const errors = refusal(
      addLine(SAMPLE_MENU, EMPTY_CART, 'line-1', { ...BURRITO_GUAC, quantity: 21 }, NOON),
    );
    expect(kinds(errors)).toEqual(['quantity_out_of_range']);
  });

  it('refuses a note over 140 characters, by reason', () => {
    const errors = refusal(
      addLine(SAMPLE_MENU, EMPTY_CART, 'line-1', { ...BURRITO_GUAC, note: 'x'.repeat(141) }, NOON),
    );
    expect(kinds(errors)).toEqual(['note_too_long']);
    expect(errors[0]?.message).toMatch(/140/);
  });

  it('accepts a note exactly at the cap', () => {
    const cart = add(EMPTY_CART, 'line-1', { ...BURRITO_GUAC, note: 'x'.repeat(140) });
    expect(cart.lines[0]?.composition.note).toHaveLength(140);
  });

  it('refuses an option that is 86d right now', () => {
    const menu = menuWith((m) => {
      const option = m.groups.addons?.options.find((o) => o.id === 'guacamole');
      if (option) option.available = false;
    });
    const errors = refusal(addLine(menu, EMPTY_CART, 'line-1', BURRITO_GUAC, NOON));
    expect(kinds(errors)).toEqual(['option_unavailable']);
  });

  it('prices a negation at the composed price — "NO onions" is a real line', () => {
    const cart = add(EMPTY_CART, 'line-1', {
      ...BURRITO_GUAC,
      selections: [
        ...BURRITO_GUAC.selections,
        { groupId: 'toppings', optionId: 'onions', intensity: 'none' },
      ],
    });
    expect(cart.lines[0]?.unitPriceAtAddCents).toBe(1345);
  });
});

describe('replaceLine / removeLine — composed items are editable and removable', () => {
  it('edits in place, keeping the id and the position', () => {
    let cart = add(EMPTY_CART, 'line-1', BURRITO_GUAC);
    cart = add(cart, 'line-2', CHIPS);

    const result = replaceLine(SAMPLE_MENU, cart, 'line-1', { ...BURRITO_GUAC, quantity: 3 }, NOON);
    if (!result.ok) throw new Error('expected the edit to be accepted');

    expect(result.cart.lines.map((line) => line.id)).toEqual(['line-1', 'line-2']);
    expect(result.cart.lines[0]?.composition.quantity).toBe(3);
    expect(result.cart.lines[0]?.unitPriceAtAddCents).toBe(1345);
  });

  it('re-baselines the price of an edited line to the live menu', () => {
    const cart = add(EMPTY_CART, 'line-1', BURRITO_GUAC);
    const menu = menuWith((m) => {
      const option = m.groups.addons?.options.find((o) => o.id === 'guacamole');
      if (option) option.priceDeltaCents = 300;
    });

    const result = replaceLine(menu, cart, 'line-1', { ...BURRITO_GUAC, quantity: 2 }, NOON);
    if (!result.ok) throw new Error('expected the edit to be accepted');

    expect(result.cart.lines[0]?.unitPriceAtAddCents).toBe(1395);
    // The customer just saw that price in the composer, so it is not a change
    // to confirm.
    expect(reviewCart(menu, result.cart, RATE_8_25, NOON).needsPriceConfirmation).toBe(false);
  });

  it('refuses an edit to a line that is no longer in the cart', () => {
    const result = replaceLine(SAMPLE_MENU, EMPTY_CART, 'line-gone', BURRITO_GUAC, NOON);
    if (result.ok) throw new Error('expected a refusal');
    expect(kinds(result.errors)).toEqual(['unknown_line']);
  });

  it('refuses an edit that would make the line unorderable, leaving the line alone', () => {
    const cart = add(EMPTY_CART, 'line-1', BURRITO_GUAC);
    const result = replaceLine(SAMPLE_MENU, cart, 'line-1', {
      ...BURRITO_GUAC,
      selections: [{ groupId: 'addons', optionId: 'guacamole' }],
    }, NOON);
    if (result.ok) throw new Error('expected a refusal');
    expect(kinds(result.errors)).toEqual(['group_required']);
    expect(cart.lines[0]?.composition).toEqual(BURRITO_GUAC);
  });

  it('removes a line, and removing it twice is a no-op', () => {
    const cart = add(add(EMPTY_CART, 'line-1', BURRITO_GUAC), 'line-2', CHIPS);
    const once = removeLine(cart, 'line-1');
    expect(once.lines.map((line) => line.id)).toEqual(['line-2']);
    expect(removeLine(once, 'line-1').lines.map((line) => line.id)).toEqual(['line-2']);
  });
});

describe('reviewCart — the checkout re-check', () => {
  const twoLines = () =>
    add(add(EMPTY_CART, 'line-1', { ...BURRITO_GUAC, quantity: 2 }), 'line-2', CHIPS);

  it('totals the cart server-side: 1345×2 + 350 = 3040, tax 250.8 → 251', () => {
    const review = reviewCart(SAMPLE_MENU, twoLines(), RATE_8_25, NOON);
    expect(review.totals).toEqual({
      subtotalCents: 3040,
      discountCents: 0,
      taxCents: 251,
      totalCents: 3291,
    });
    expect(review.placeable).toBe(true);
    expect(review.needsFix).toBe(false);
    expect(review.needsPriceConfirmation).toBe(false);
  });

  it('ignores a tampered stored price entirely — the server is the authority', () => {
    const cart = twoLines();
    const tampered: Cart = {
      lines: cart.lines.map((line) => ({ ...line, unitPriceAtAddCents: 1 })),
    };
    const review = reviewCart(SAMPLE_MENU, tampered, RATE_8_25, NOON);
    expect(review.totals.subtotalCents).toBe(3040);
    // It is not free food, it is a confirmation prompt showing $0.01 → real.
    expect(review.needsPriceConfirmation).toBe(true);
    expect(review.placeable).toBe(false);
  });

  it('an empty cart is not placeable', () => {
    const review = reviewCart(SAMPLE_MENU, EMPTY_CART, RATE_8_25, NOON);
    expect(review.placeable).toBe(false);
    expect(review.totals).toEqual({ subtotalCents: 0, discountCents: 0, taxCents: 0, totalCents: 0 });
  });

  it('flags a line whose option was 86d while it sat in the cart', () => {
    const menu = menuWith((m) => {
      const option = m.groups.addons?.options.find((o) => o.id === 'guacamole');
      if (option) option.available = false;
    });
    const review = reviewCart(menu, twoLines(), RATE_8_25, NOON);

    expect(review.lines[0]?.problems.map((p) => p.kind)).toEqual(['option_unavailable']);
    expect(review.lines[1]?.problems).toEqual([]);
    expect(review.needsFix).toBe(true);
    expect(review.placeable).toBe(false);
  });

  it('flags a line whose item was 86d while it sat in the cart', () => {
    const menu = menuWith((m) => {
      const item = m.items.burrito;
      if (item) item.available = false;
    });
    const review = reviewCart(menu, twoLines(), RATE_8_25, NOON);
    expect(review.lines[0]?.problems.map((p) => p.kind)).toEqual(['item_unavailable']);
    expect(review.needsFix).toBe(true);
  });

  it('flags a repriced line old → new and blocks placement until it is confirmed', () => {
    const menu = menuWith((m) => {
      const option = m.groups.addons?.options.find((o) => o.id === 'guacamole');
      if (option) option.priceDeltaCents = 300;
    });
    const review = reviewCart(menu, twoLines(), RATE_8_25, NOON);

    expect(review.lines[0]?.priceChange).toEqual({
      fromUnitPriceCents: 1345,
      toUnitPriceCents: 1395,
    });
    expect(review.lines[1]?.priceChange).toBeNull();
    expect(review.needsPriceConfirmation).toBe(true);
    expect(review.placeable).toBe(false);
    // No silent repricing — but the total shown is already the NEW one.
    expect(review.totals.subtotalCents).toBe(1395 * 2 + 350);
  });

  it('confirming the new prices re-baselines the cart and unblocks placement', () => {
    const menu = menuWith((m) => {
      const option = m.groups.addons?.options.find((o) => o.id === 'guacamole');
      if (option) option.priceDeltaCents = 300;
    });
    const confirmed = confirmPrices(menu, twoLines(), NOON);
    const review = reviewCart(menu, confirmed, RATE_8_25, NOON);

    expect(confirmed.lines[0]?.unitPriceAtAddCents).toBe(1395);
    expect(review.needsPriceConfirmation).toBe(false);
    expect(review.placeable).toBe(true);
    expect(review.totals.subtotalCents).toBe(3140);
  });

  it('survives a line whose option was DELETED from the menu, without pricing it', () => {
    const menu = menuWith((m) => {
      const group = m.groups.addons;
      if (group) group.options = group.options.filter((o) => o.id !== 'guacamole');
    });
    const review = reviewCart(menu, twoLines(), RATE_8_25, NOON);

    expect(review.lines[0]?.priced).toBeNull();
    expect(review.lines[0]?.problems.map((p) => p.kind)).toEqual(['unknown_option']);
    expect(review.needsFix).toBe(true);
    // The rest of the cart still totals; the dead line contributes nothing.
    expect(review.totals.subtotalCents).toBe(350);
  });

  it('does not re-baseline a line it cannot price', () => {
    const menu = menuWith((m) => {
      delete m.items.burrito;
    });
    const confirmed = confirmPrices(menu, twoLines(), NOON);
    expect(confirmed.lines[0]?.unitPriceAtAddCents).toBe(1345);
    expect(reviewCart(menu, confirmed, RATE_8_25, NOON).needsFix).toBe(true);
  });
});

describe('parseCart — the trust boundary', () => {
  const cart = add(EMPTY_CART, 'line-1', {
    ...BURRITO_GUAC,
    note: 'extra crispy',
    selections: [
      ...BURRITO_GUAC.selections,
      { groupId: 'toppings', optionId: 'onions', intensity: 'none' },
    ],
  });

  it('round-trips a cart, negation and note included', () => {
    expect(parseCart(serializeCart(cart))).toEqual(cart);
  });

  it('reads a missing or unparseable cookie as an empty cart', () => {
    expect(parseCart(undefined)).toEqual(EMPTY_CART);
    expect(parseCart('')).toEqual(EMPTY_CART);
    expect(parseCart('{not json')).toEqual(EMPTY_CART);
    expect(parseCart('[]')).toEqual(EMPTY_CART);
    expect(parseCart('{"lines":"all of them"}')).toEqual(EMPTY_CART);
  });

  it('drops the bad line, not the whole cart', () => {
    const mangled = JSON.stringify({
      lines: [{ id: 'junk', unitPriceAtAddCents: 'free' }, ...cart.lines],
    });
    expect(parseCart(mangled).lines.map((line) => line.id)).toEqual(['line-1']);
  });

  it('rejects a line whose shape could not have come from this server', () => {
    const line = cart.lines[0];
    const withComposition = (composition: unknown) =>
      parseCart(JSON.stringify({ lines: [{ ...line, composition }] })).lines;

    expect(withComposition({ ...BURRITO_GUAC, quantity: 1.5 })).toEqual([]);
    expect(withComposition({ ...BURRITO_GUAC, quantity: '2' })).toEqual([]);
    expect(withComposition({ ...BURRITO_GUAC, selections: 'chicken' })).toEqual([]);
    expect(withComposition({ ...BURRITO_GUAC, note: 42 })).toEqual([]);
    expect(withComposition({ ...BURRITO_GUAC, itemId: '' })).toEqual([]);
    expect(
      withComposition({
        ...BURRITO_GUAC,
        selections: [{ groupId: 'toppings', optionId: 'onions', intensity: 'loads' }],
      }),
    ).toEqual([]);
  });

  it('leaves menu truth to the orderability function, not to the parser', () => {
    // Shape-valid, menu-invalid: the parser passes it, `reviewCart` refuses it.
    const parsed = parseComposition({ itemId: 'unicorn', quantity: 99, selections: [] });
    expect(parsed).not.toBeNull();
    expect(addLine(SAMPLE_MENU, EMPTY_CART, 'line-1', parsed!, NOON).ok).toBe(false);
  });
});

// P1-1, the CART call site of the acceptance criterion — the middle of the
// three. The composer refuses it, this refuses it, and placement refuses it,
// and all three are the same function reading the same third input.
describe('dayparts in an open cart (P1-1)', () => {
  const FRIDAY = (minuteOfDay: number): RestaurantClock => ({
    day: '2026-09-11',
    weekday: 5,
    minuteOfDay,
  });

  const dinnerOnlyChips = (): Menu =>
    menuWith((m) => {
      m.items.chips!.windows = [{ dayOfWeek: 5, startMinute: 16 * 60, endMinute: 21 * 60 }];
    });

  it('refuses the add at 15:59 and takes it at 16:01', () => {
    const menu = dinnerOnlyChips();
    expect(
      kinds(refusal(addLine(menu, EMPTY_CART, 'line-1', CHIPS, FRIDAY(15 * 60 + 59)))),
    ).toEqual(['item_outside_daypart']);
    expect(addLine(menu, EMPTY_CART, 'line-1', CHIPS, FRIDAY(16 * 60 + 1)).ok).toBe(true);
  });

  // The second Open Question, answered: a daypart closing under an open cart
  // is the 86 path — flagged at checkout, fix or remove — because that path is
  // already built, already honest, and already tested. The kindness is in the
  // sentence, not in a third behaviour that would let the line through.
  it('blocks checkout on a line whose window closed while it sat there', () => {
    const menu = dinnerOnlyChips();
    // Added at 17:00, inside the window. It is the CLOCK that moved, not the
    // menu — which is the difference between this and an 86.
    const cart = add(EMPTY_CART, 'line-1', CHIPS, menu, FRIDAY(17 * 60));

    const review = reviewCart(menu, cart, RATE_8_25, FRIDAY(21 * 60 + 1));

    expect(review.needsFix).toBe(true);
    expect(review.placeable).toBe(false);
    expect(review.lines[0]?.problems.map((p) => p.kind)).toEqual(['item_outside_daypart']);
    expect(review.lines[0]?.problems[0]?.message).toBe('Chips & salsa is served 16:00–21:00.');
  });

  it('still prices the blocked line — it is unavailable, not unknown', () => {
    // The distinction `UNPRICEABLE_KINDS` draws. An item outside its window
    // still exists and still has a price, so the cart can show the customer
    // what they were about to buy instead of a blank row.
    const menu = dinnerOnlyChips();
    const cart = add(EMPTY_CART, 'line-1', CHIPS, menu, FRIDAY(17 * 60));

    const review = reviewCart(menu, cart, RATE_8_25, FRIDAY(9 * 60));

    expect(review.lines[0]?.priced?.unitPriceCents).toBe(350);
    expect(review.lines[0]?.priceChange).toBeNull();
  });
});
