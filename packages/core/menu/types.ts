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

/**
 * One window an item is served in, in the restaurant's local wall clock (P1-1).
 *
 * A SCHEDULE, and deliberately not the same thing as `available`. An 86 is a
 * human saying "we ran out"; a daypart is the clock saying "not yet". They are
 * kept apart because C-012 decided an 86 never restores itself overnight —
 * collapse the two into one boolean and 16:00 un-86's something a cook killed
 * at 12:40, which is food the kitchen cannot make being sold again by a
 * scheduler.
 *
 * Minutes since local midnight, compared against `RestaurantClock.minuteOfDay`
 * — never UTC, never the process timezone. Same units and same weekday
 * indexing as `StoreHoursDay`, on purpose: two ways to say "Friday at 16:00"
 * is two ways to disagree.
 *
 * These are per-ITEM and per-DAY, and an item may have more than one on a day
 * (breakfast 07:00–11:00, dinner 16:00–21:00) — which is why this is a list
 * and why the schema is a child table rather than a column pair. That is also
 * the difference from `StoreHours`, where `dayOfWeek` is the primary key
 * because C-011 deliberately foreclosed split opening hours.
 */
export type DaypartWindow = {
  /** 0 = Sunday, matching `restaurantClock` and `StoreHoursDay`. */
  dayOfWeek: number;
  /** Local wall-clock minutes since midnight, 0–1439. Inclusive. */
  startMinute: number;
  /** Local wall-clock minutes since midnight, 1–1440. EXCLUSIVE — an item
   *  served until 1440 is served through the last minute of the day. */
  endMinute: number;
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
   * When this item is served (P1-1). ABSENT means all day, every day, which is
   * what almost every item is — optional rather than a required empty list so
   * that adding a schedule is a deliberate act and the twenty-three items
   * without one read as having nothing to think about.
   *
   * Read by THE orderability function, not by the menu render on its own: a
   * daypart that closed the link but not the POST is the same defect class as
   * a pause switch that only hides a button.
   */
  windows?: readonly DaypartWindow[];
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
