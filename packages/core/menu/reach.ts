// Who a change reaches (P0-1), and what a search on the 86 board turns up (P0-2).
//
// A modifier group is shared: one "Add-ons" group serves the burrito, the
// California burrito, the torta and the loaded nachos. That reuse is the point
// of the model and it is also why an 86 on Guacamole stops food on four items
// at once — correct, because it is one ingredient, and invisible unless
// something says so.
//
// ONE derivation, from the same `Menu` every other surface reads. The calm
// menu editor's shared-group warning and the mid-rush 86 board must never
// disagree about who an edit touches, which they would the moment each
// filtered the item list for itself. `itemsWithGroup` below is that one
// filter; the search reuses it rather than growing a second one.
import type { GroupId, ItemId, Menu, MenuItem, OptionId } from './types';

/** The one place `menu.items` is filtered by group membership. */
function itemsWithGroup(menu: Menu, groupId: GroupId): MenuItem[] {
  return Object.values(menu.items).filter((item) => item.modifierGroupIds.includes(groupId));
}

/** Names of the items carrying this group, in menu order. */
export function itemsUsingGroup(menu: Menu, groupId: GroupId): string[] {
  return itemsWithGroup(menu, groupId).map((item) => item.name);
}

/** What the 86 board draws for a given query. */
export type MenuSearch = { itemIds: Set<ItemId>; optionIds: Set<OptionId> };

/**
 * The 86 board's search (P0-2): item names AND option names, one box.
 *
 * A matching option drags in every item it stops — "guac" has to surface the
 * burrito, because the option is the thing being 86'd and C-107's used-on line
 * is only useful next to the rows it names. The reverse does not hold: a
 * matching ITEM does not drag in its options, because someone typing "burrito"
 * wants to 86 the burrito, not to be handed every salsa on it.
 *
 * An empty query matches everything, the same as the queue's `matchesLookup` —
 * the board is not something you clear a filter to see again.
 *
 * This narrows, where the queue's lookup only MARKS. Different rule on purpose:
 * a queue card that vanishes is a customer standing at the counter unseen; a
 * menu row that vanishes is a menu row.
 */
export function searchMenu(menu: Menu, query: string): MenuSearch {
  const needle = query.trim().toLowerCase();
  const hit = (name: string) => needle === '' || name.toLowerCase().includes(needle);

  const itemIds = new Set<ItemId>();
  const optionIds = new Set<OptionId>();

  for (const group of Object.values(menu.groups)) {
    for (const option of group.options) {
      if (!hit(option.name)) continue;
      optionIds.add(option.id);
      for (const item of itemsWithGroup(menu, group.id)) itemIds.add(item.id);
    }
  }
  for (const item of Object.values(menu.items)) {
    if (hit(item.name)) itemIds.add(item.id);
  }

  return { itemIds, optionIds };
}
