// The menu model (P0-1). Pure data — no database, no clock, no I/O.
//
// Money is integer cents everywhere (CLAUDE.md). A price delta may be negative
// or zero: "Small −$1.50" and "Veggie −$1.00" are ordinary options, not a
// second mechanism.

export type CategoryId = string;
export type ItemId = string;
export type GroupId = string;
export type OptionId = string;

/**
 * How much of an option the customer wants. `none` is the NEGATION — "NO
 * onions" — and it is the founding use case of this whole product: a removal
 * rendered like an addition is the phone-transcription bug Countertop exists
 * to kill. It is a real selection, carried through to the kitchen ticket, not
 * the absence of one.
 */
export const INTENSITIES = ['none', 'light', 'regular', 'extra'] as const;
export type Intensity = (typeof INTENSITIES)[number];

export type ModifierOption = {
  id: OptionId;
  name: string;
  /** Added to the item's base price when selected. May be negative or zero. */
  priceDeltaCents: number;
  /**
   * Surcharge added ON TOP of priceDeltaCents when chosen at `extra`. Only
   * meaningful inside an intensity-enabled group; absent means "extra" is free.
   */
  extraPriceDeltaCents?: number;
  /** The option grain of 86'ing: out of avocado ≠ out of burritos (P0-6). */
  available: boolean;
};

export type ModifierGroup = {
  id: GroupId;
  name: string;
  /**
   * Selection bounds. `min > 0` IS what "required" means — there is no
   * separate `required` flag, because two ways to say the same thing is two
   * ways to disagree. Same reasoning as S/M/L being a modifier group rather
   * than its own variant mechanism.
   */
  min: number;
  max: number;
  /** Enables none/light/regular/extra per option (P0-1, OPS). */
  intensityEnabled: boolean;
  options: ModifierOption[];
  // NOTE: there is deliberately no `groups` field here. The modifier structure
  // is exactly one level deep — item → group → option — and an option cannot
  // own nested groups (P0-1). That is enforced by this type having nowhere to
  // put them; combos and nesting are P2.
};

export type Category = {
  id: CategoryId;
  name: string;
};

export type MenuItem = {
  id: ItemId;
  categoryId: CategoryId;
  name: string;
  basePriceCents: number;
  /** The item grain of 86'ing. Unavailable items render "sold out", not hidden. */
  available: boolean;
  /**
   * How much kitchen work this item is (P1-7). The P0-6 auto-pause threshold
   * and the P0-7 estimate SUM this across open orders rather than counting the
   * orders, so ten canned drinks and ten fajita plates stop meaning the same
   * thing to both.
   *
   * A whole number, and 0 is legal: a drink pulled out of the fridge costs the
   * kitchen nothing and should neither hold the door shut nor lengthen anyone
   * else's quote. Required rather than defaulted, because a weight nobody set
   * is a weight nobody thought about — and the compiler is the thing that asks.
   */
  prepWeight: number;
  /**
   * References, not copies — which is what makes one "salsa" group reusable
   * across every item that has salsa, with no duplication to drift apart.
   */
  modifierGroupIds: GroupId[];
};

export type Menu = {
  categories: Category[];
  items: Record<ItemId, MenuItem>;
  groups: Record<GroupId, ModifierGroup>;
};

/** One option the customer picked, and how much of it. */
export type OptionSelection = {
  groupId: GroupId;
  optionId: OptionId;
  /** Omitted in a group without intensity enabled; defaults to `regular`. */
  intensity?: Intensity;
};

/** One composed cart line, before it is priced or placed. */
export type Composition = {
  itemId: ItemId;
  quantity: number;
  selections: OptionSelection[];
  note?: string;
};
