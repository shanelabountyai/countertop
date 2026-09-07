// Who a change reaches (P0-1).
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
// filtered the item list for itself.
import type { GroupId, Menu } from './types';

/** Names of the items carrying this group, in menu order. */
export function itemsUsingGroup(menu: Menu, groupId: GroupId): string[] {
  return Object.values(menu.items)
    .filter((item) => item.modifierGroupIds.includes(groupId))
    .map((item) => item.name);
}
