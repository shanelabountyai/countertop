// The hand-built menu every fixture in this package is calculated against.
// Small enough to hold in your head, wide enough to cover P0-1: a required
// single-select size group, a required protein group with a NEGATIVE delta, an
// optional min/max group, two intensity-enabled groups (one with a priced
// "extra"), a min-2 group, an item with no modifiers at all, and two groups
// (`protein`, `salsa`) REUSED across two items with no duplication.
//
// C-017 grew it to the PRD's 25 items and 8 groups (Measurement Method). The
// first four items and six groups are UNTOUCHED — every hand-calculated
// fixture in this package is priced against them, and a menu that grew by
// editing the rows the arithmetic was checked against proves nothing. The new
// items only COMPOSE the existing groups, plus the two new ones.
//
// Two groups are deliberately left alone: `salsa` stays on exactly the burrito
// and the bowl, and `fillings` on exactly the taco plate, because C-015's
// shared-group warning asserts "affects 2 items" and "affects 1 item" by name.
import type { Menu } from './types';

export const SAMPLE_MENU: Menu = {
  categories: [
    { id: 'burritos', name: 'Burritos & Bowls' },
    { id: 'plates', name: 'Plates' },
    { id: 'sides', name: 'Sides' },
    { id: 'drinks', name: 'Drinks' },
    { id: 'sweets', name: 'Sweets' },
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
    // Required, and one of its options is a NEGATION priced at zero — "No
    // rice" is a choice the kitchen has to read, not the absence of one.
    rice: {
      id: 'rice',
      name: 'Rice',
      min: 1,
      max: 1,
      intensityEnabled: false,
      options: [
        { id: 'white-rice', name: 'White rice', priceDeltaCents: 0, available: true },
        { id: 'brown-rice', name: 'Brown rice', priceDeltaCents: 50, available: true },
        { id: 'no-rice', name: 'No rice', priceDeltaCents: 0, available: true },
      ],
    },
    'tortilla-style': {
      id: 'tortilla-style',
      name: 'Tortilla',
      min: 1,
      max: 1,
      intensityEnabled: false,
      options: [
        { id: 'flour-tortilla', name: 'Flour tortilla', priceDeltaCents: 0, available: true },
        { id: 'corn-tortilla', name: 'Corn tortilla', priceDeltaCents: 0, available: true },
        { id: 'wheat-tortilla', name: 'Whole-wheat tortilla', priceDeltaCents: 50, available: true },
      ],
    },
  },
  // `prepWeight` is kitchen work, not price (P1-7): a plate off the flat-top is
  // 3, a burrito on the line is 2, a scooped side is 1, and a bottle out of the
  // fridge is 0. Weight is what the P0-6 throttle and the P0-7 estimate add up,
  // so an order of four bottled waters holds the door open and quotes nothing.
  items: {
    burrito: {
      id: 'burrito',
      categoryId: 'burritos',
      name: 'Burrito',
      basePriceCents: 1095,
      available: true,
      prepWeight: 2,
      modifierGroupIds: ['protein', 'addons', 'salsa', 'toppings'],
    },
    bowl: {
      id: 'bowl',
      categoryId: 'burritos',
      name: 'Burrito bowl',
      basePriceCents: 1195,
      available: true,
      prepWeight: 2,
      // `protein` and `salsa` are the SAME group objects the burrito uses.
      modifierGroupIds: ['size', 'protein', 'salsa'],
    },
    'taco-plate': {
      id: 'taco-plate',
      categoryId: 'plates',
      name: 'Taco plate',
      basePriceCents: 1250,
      available: true,
      prepWeight: 3,
      modifierGroupIds: ['fillings'],
    },
    chips: {
      id: 'chips',
      categoryId: 'sides',
      name: 'Chips & salsa',
      basePriceCents: 350,
      available: true,
      prepWeight: 1,
      modifierGroupIds: [],
    },

    // ── The other 21 (C-017). Composition only: no group below is new to this
    // list, and no existing item's groups changed. Item names deliberately
    // avoid containing an existing OPTION name ("Chips & guac", not "Chips &
    // queso"), because Playwright matches accessible names by substring and
    // case-insensitively — "Chips & queso" would make every `Queso` locator in
    // the availability suite ambiguous.
    'breakfast-burrito': {
      id: 'breakfast-burrito',
      categoryId: 'burritos',
      name: 'Breakfast burrito',
      basePriceCents: 950,
      available: true,
      prepWeight: 2,
      modifierGroupIds: ['protein', 'toppings'],
    },
    'california-burrito': {
      id: 'california-burrito',
      categoryId: 'burritos',
      name: 'California burrito',
      basePriceCents: 1295,
      available: true,
      prepWeight: 3,
      modifierGroupIds: ['protein', 'tortilla-style', 'addons'],
    },
    'garden-bowl': {
      id: 'garden-bowl',
      categoryId: 'burritos',
      name: 'Garden bowl',
      basePriceCents: 1050,
      available: true,
      prepWeight: 2,
      modifierGroupIds: ['size', 'rice', 'toppings'],
    },
    'enchilada-plate': {
      id: 'enchilada-plate',
      categoryId: 'plates',
      name: 'Enchilada plate',
      basePriceCents: 1395,
      available: true,
      prepWeight: 3,
      modifierGroupIds: ['protein', 'rice'],
    },
    'fajita-plate': {
      id: 'fajita-plate',
      categoryId: 'plates',
      name: 'Fajita plate',
      basePriceCents: 1595,
      available: true,
      prepWeight: 4,
      modifierGroupIds: ['protein', 'tortilla-style', 'toppings'],
    },
    'tamale-plate': {
      id: 'tamale-plate',
      categoryId: 'plates',
      name: 'Tamale plate',
      basePriceCents: 1250,
      available: true,
      prepWeight: 2,
      modifierGroupIds: [],
    },
    'torta': {
      id: 'torta',
      categoryId: 'plates',
      name: 'Torta',
      basePriceCents: 1150,
      available: true,
      prepWeight: 2,
      modifierGroupIds: ['protein', 'toppings', 'addons'],
    },
    'quesadilla': {
      id: 'quesadilla',
      categoryId: 'plates',
      name: 'Quesadilla',
      basePriceCents: 895,
      available: true,
      prepWeight: 2,
      modifierGroupIds: ['protein'],
    },
    'nachos': {
      id: 'nachos',
      categoryId: 'plates',
      name: 'Loaded nachos',
      basePriceCents: 1145,
      available: true,
      prepWeight: 2,
      modifierGroupIds: ['protein', 'addons', 'toppings'],
    },
    'chips-guac': {
      id: 'chips-guac',
      categoryId: 'sides',
      name: 'Chips & guac',
      basePriceCents: 595,
      available: true,
      prepWeight: 1,
      modifierGroupIds: [],
    },
    'taquitos': {
      id: 'taquitos',
      categoryId: 'sides',
      name: 'Taquitos',
      basePriceCents: 650,
      available: true,
      prepWeight: 1,
      modifierGroupIds: [],
    },
    'rice-side': {
      id: 'rice-side',
      categoryId: 'sides',
      name: 'Side of rice',
      basePriceCents: 300,
      available: true,
      prepWeight: 1,
      modifierGroupIds: ['rice'],
    },
    'beans-side': {
      id: 'beans-side',
      categoryId: 'sides',
      name: 'Side of beans',
      basePriceCents: 300,
      available: true,
      prepWeight: 1,
      modifierGroupIds: [],
    },
    'elote': {
      id: 'elote',
      categoryId: 'sides',
      name: 'Street corn',
      basePriceCents: 425,
      available: true,
      prepWeight: 1,
      modifierGroupIds: ['toppings'],
    },
    'horchata': {
      id: 'horchata',
      categoryId: 'drinks',
      name: 'Horchata',
      basePriceCents: 425,
      available: true,
      prepWeight: 1,
      modifierGroupIds: ['size'],
    },
    'agua-fresca': {
      id: 'agua-fresca',
      categoryId: 'drinks',
      name: 'Agua fresca',
      basePriceCents: 425,
      available: true,
      prepWeight: 1,
      modifierGroupIds: ['size'],
    },
    'mexican-coke': {
      id: 'mexican-coke',
      categoryId: 'drinks',
      name: 'Mexican Coke',
      basePriceCents: 350,
      available: true,
      prepWeight: 0,
      modifierGroupIds: [],
    },
    'bottled-water': {
      id: 'bottled-water',
      categoryId: 'drinks',
      name: 'Bottled water',
      basePriceCents: 250,
      available: true,
      prepWeight: 0,
      modifierGroupIds: [],
    },
    'churros': {
      id: 'churros',
      categoryId: 'sweets',
      name: 'Churros',
      basePriceCents: 495,
      available: true,
      prepWeight: 1,
      modifierGroupIds: [],
    },
    'tres-leches': {
      id: 'tres-leches',
      categoryId: 'sweets',
      name: 'Tres leches',
      basePriceCents: 650,
      available: true,
      prepWeight: 0,
      modifierGroupIds: [],
    },
    'paleta': {
      id: 'paleta',
      categoryId: 'sweets',
      name: 'Paleta',
      basePriceCents: 375,
      available: true,
      prepWeight: 0,
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
