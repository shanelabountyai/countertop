// The hand-built menu every fixture in this package is calculated against.
// Small enough to hold in your head, wide enough to cover P0-1: a required
// single-select size group, a required protein group with a NEGATIVE delta, an
// optional min/max group, two intensity-enabled groups (one with a priced
// "extra"), a min-2 group, an item with no modifiers at all, and two groups
// (`protein`, `salsa`) REUSED across two items with no duplication.
//
// C-017's seed grows this to the PRD's ~25 items; the shape does not change.
import type { Menu } from './types';

export const SAMPLE_MENU: Menu = {
  categories: [
    { id: 'burritos', name: 'Burritos & Bowls' },
    { id: 'plates', name: 'Plates' },
    { id: 'sides', name: 'Sides' },
  ],
  groups: {
    // S/M/L is a required single-select modifier group with price deltas —
    // one mechanism, not a separate "variant" concept (P0-1).
    size: {
      id: 'size',
      name: 'Size',
      min: 1,
      max: 1,
      intensityEnabled: false,
      options: [
        { id: 'small', name: 'Small', priceDeltaCents: -150, available: true },
        { id: 'medium', name: 'Medium', priceDeltaCents: 0, available: true },
        { id: 'large', name: 'Large', priceDeltaCents: 200, available: true },
      ],
    },
    protein: {
      id: 'protein',
      name: 'Protein',
      min: 1,
      max: 1,
      intensityEnabled: false,
      options: [
        { id: 'chicken', name: 'Chicken', priceDeltaCents: 0, available: true },
        { id: 'carnitas', name: 'Carnitas', priceDeltaCents: 150, available: true },
        { id: 'steak', name: 'Steak', priceDeltaCents: 250, available: true },
        { id: 'veggie', name: 'Veggie', priceDeltaCents: -100, available: true },
      ],
    },
    addons: {
      id: 'addons',
      name: 'Add-ons',
      min: 0,
      max: 3,
      intensityEnabled: false,
      options: [
        { id: 'guacamole', name: 'Guacamole', priceDeltaCents: 250, available: true },
        { id: 'queso', name: 'Queso', priceDeltaCents: 150, available: true },
        { id: 'tortilla', name: 'Extra tortilla', priceDeltaCents: 75, available: true },
      ],
    },
    salsa: {
      id: 'salsa',
      name: 'Salsa',
      min: 0,
      max: 3,
      intensityEnabled: true,
      options: [
        { id: 'chipotle', name: 'Chipotle', priceDeltaCents: 0, extraPriceDeltaCents: 50, available: true },
        { id: 'verde', name: 'Salsa verde', priceDeltaCents: 0, available: true },
        { id: 'pico', name: 'Pico de gallo', priceDeltaCents: 0, available: true },
      ],
    },
    toppings: {
      id: 'toppings',
      name: 'Toppings',
      min: 0,
      max: 3,
      intensityEnabled: true,
      options: [
        { id: 'onions', name: 'Onions', priceDeltaCents: 0, available: true },
        { id: 'cilantro', name: 'Cilantro', priceDeltaCents: 0, available: true },
        { id: 'cheese', name: 'Cheese', priceDeltaCents: 50, extraPriceDeltaCents: 75, available: true },
      ],
    },
    fillings: {
      id: 'fillings',
      name: 'Fillings',
      min: 2,
      max: 4,
      intensityEnabled: false,
      options: [
        { id: 'al-pastor', name: 'Al pastor', priceDeltaCents: 0, available: true },
        { id: 'fish', name: 'Baja fish', priceDeltaCents: 200, available: true },
        { id: 'mushroom', name: 'Mushroom', priceDeltaCents: -50, available: true },
      ],
    },
  },
  items: {
    burrito: {
      id: 'burrito',
      categoryId: 'burritos',
      name: 'Burrito',
      basePriceCents: 1095,
      available: true,
      modifierGroupIds: ['protein', 'addons', 'salsa', 'toppings'],
    },
    bowl: {
      id: 'bowl',
      categoryId: 'burritos',
      name: 'Burrito bowl',
      basePriceCents: 1195,
      available: true,
      // `protein` and `salsa` are the SAME group objects the burrito uses.
      modifierGroupIds: ['size', 'protein', 'salsa'],
    },
    'taco-plate': {
      id: 'taco-plate',
      categoryId: 'plates',
      name: 'Taco plate',
      basePriceCents: 1250,
      available: true,
      modifierGroupIds: ['fillings'],
    },
    chips: {
      id: 'chips',
      categoryId: 'sides',
      name: 'Chips & salsa',
      basePriceCents: 350,
      available: true,
      modifierGroupIds: [],
    },
  },
};

/** A deep-ish copy so a test can 86 an option without leaking into the next test. */
export function menuWith(mutate: (menu: Menu) => void): Menu {
  const copy: Menu = structuredClone(SAMPLE_MENU);
  mutate(copy);
  return copy;
}
