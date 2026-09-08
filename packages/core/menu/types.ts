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

/**
 * Where in the kitchen an item is made (C-112, PRD 4 P1-3).
 *
 * An ATTRIBUTE, and the smallest useful half of stations. What it buys is the
 * selection the 86 board could not previously express: "the fryer is down"
 * spans Sides, Plates and Sweets on this menu and excludes rice, tamales and
 * paletas inside each of them, which is precisely why C-109 rejected the
 * category grain and left the station open. A station SEEDS a selection; it is
 * not a second way to kill, and nothing was unbuilt to add it.
 *
 * What it deliberately does NOT do is reach the estimate or the auto-pause
 * threshold. Those still read ONE open weight, for two reasons written up in
 * docs/WRITEUP.md: a per-station sum cannot be computed without a station on
 * the order SNAPSHOT — the live menu must never be joined back to for it — and
 * "the estimate reads the busiest station" assumes stations run in parallel
 * with independent staff, which nothing here models.
 *
 * Order matters: the database enum stores exactly this list in exactly this
 * order, asserted by the vocabulary test in `packages/db/snapshot.test.ts`.
 */
export const STATIONS = ['fryer', 'grill', 'line', 'steam', 'drinks'] as const;
export type Station = (typeof STATIONS)[number];

/** What a station is CALLED on a screen a cook reads at arm's length.
 *
 *  Beside the list rather than in the page, so a station added to `STATIONS`
 *  without a label is a type error rather than a button reading "steam". */
export const STATION_LABELS: Record<Station, string> = {
  fryer: 'Fryer',
  grill: 'Grill',
  line: 'Cold line',
  steam: 'Steam table',
  drinks: 'Drinks',
};

export type Category = {
  id: CategoryId;
  name: string;
};

export type MenuItem = {
  id: ItemId;
  categoryId: CategoryId;
  name: string;
  /**
   * What the food is, in a sentence (P0-4). A LIVE-MENU field, and the only
   * one on this type that exists purely to be read by a human — nothing in
   * `packages/core` reasons about it.
   *
   * It must never follow an order into a snapshot. `SnapshotLine` copies
   * `itemName` because a receipt has to survive a rename; it deliberately does
   * NOT copy this, because a receipt that showed a description would either be
   * a menu join (the defect this project exists to prevent) or a second
   * snapshotted column for text no customer needs on a receipt they are
   * holding the food from. Live surfaces only: `/menu` and the composer.
   *
   * Optional rather than a required nullable, the same
   * `exactOptionalPropertyTypes` reason as `station` and `windows` below —
   * absent and `undefined` are different values, and an item nobody has
   * described yet is absent.
   */
  description?: string;
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
   * WHERE the work in `prepWeight` happens (C-112). ABSENT means nowhere, and
   * that is a claim rather than a gap: a bottled drink and a paleta are
   * `prepWeight: 0`, so no station owes them anything. `sample-menu.test.ts`
   * asserts the direction that matters — an item with prep weight has a
   * station — because the compiler cannot.
   *
   * Optional rather than a required nullable, for the same
   * `exactOptionalPropertyTypes` reason as `windows` below: absent and
   * `undefined` are different values, and only the first matches an item
   * written with no station.
   */
  station?: Station;
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
