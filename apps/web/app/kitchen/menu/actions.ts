'use server';

// The menu editor's writes (P0-13). Every one of these runs AFTER the manager
// has confirmed a panel that spelled out what changes — but the confirm panel
// is UX, not the mechanism, so each action re-parses and re-checks its own
// arguments here. A bound argument is client input like any other.
//
// None of these can reach a placed order. The snapshot tables carry copied
// names and prices as columns and hold no foreign key back to the menu, so a
// reprice or a deleted group is invisible to every order already in the queue
// — the regression test in packages/db/snapshot.test.ts is what keeps that
// true rather than merely intended.
import { parsePriceInput } from '@countertop/core';
import { prisma } from '@countertop/db';
import { formatCents, formatDeltaCents } from '@/lib/money';
import { revalidateMenuSurfaces } from '@/lib/revalidate-menu';
import { redirect } from 'next/navigation';

/** Back to the editor with a one-line outcome. The confirm panel is a URL, so
 *  clearing it and reporting the result are the same navigation. */
function done(saved: string): never {
  revalidateMenuSurfaces();
  redirect(`/kitchen/menu?saved=${encodeURIComponent(saved)}`);
}

function rejected(): never {
  redirect('/kitchen/menu?error=1');
}

/**
 * An item's base price. Non-negative: an item that pays the customer to order
 * it is a typo every time, and the composition engine has no notion of one.
 */
export async function saveItemPrice(itemId: unknown, priceText: unknown): Promise<void> {
  if (typeof itemId !== 'string' || typeof priceText !== 'string') rejected();
  const cents = parsePriceInput(priceText);
  if (cents === null || cents < 0) rejected();

  const item = await prisma.menuItem.findUnique({ where: { id: itemId } });
  if (!item) rejected();
  await prisma.menuItem.update({ where: { id: itemId }, data: { basePriceCents: cents } });
  done(`${item.name} is now priced at ${formatCents(cents)}`);
}

/**
 * A modifier's price delta. Negative IS legal here — "Small −$1.50" is a
 * discount, not a mistake — which is exactly why the confirm step showing
 * old → new matters more on this row than on an item's.
 */
export async function saveOptionPrice(optionId: unknown, priceText: unknown): Promise<void> {
  if (typeof optionId !== 'string' || typeof priceText !== 'string') rejected();
  const cents = parsePriceInput(priceText);
  if (cents === null) rejected();

  const option = await prisma.modifierOption.findUnique({ where: { id: optionId } });
  if (!option) rejected();
  await prisma.modifierOption.update({
    where: { id: optionId },
    data: { priceDeltaCents: cents },
  });
  done(`${option.name} is now ${formatDeltaCents(cents) || 'free'}`);
}

/**
 * A group's name and its min/max. `min > 0` is what "required" means, so
 * raising a min from 0 to 1 makes the group required on EVERY item that shares
 * it — which is the change the affected-items list in the confirm panel exists
 * to make visible before it is applied.
 */
export async function saveGroup(
  groupId: unknown,
  name: unknown,
  minText: unknown,
  maxText: unknown,
): Promise<void> {
  if (typeof groupId !== 'string') rejected();
  const bounds = parseBounds(minText, maxText);
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!bounds || trimmed === '' || trimmed.length > 60) rejected();

  const group = await prisma.modifierGroup.findUnique({
    where: { id: groupId },
    include: { options: true },
  });
  if (!group) rejected();
  // A MIN above the number of options is a rule no composition can satisfy —
  // the item becomes unorderable and the composer can only say so. A max above
  // it is merely slack ("choose up to 4" of 3), which the seeded Fillings group
  // already ships and which nothing downstream minds.
  if (bounds.min > group.options.length) rejected();

  await prisma.modifierGroup.update({
    where: { id: groupId },
    data: { name: trimmed, min: bounds.min, max: bounds.max },
  });
  done(`${trimmed} updated`);
}

/**
 * Deleting a group, and with it the joins to every item that used it.
 *
 * `ItemModifierGroup.group` is `onDelete: Restrict`, so the joins must go
 * first and deliberately — the database refuses to let this happen as a side
 * effect. One transaction, so no item is left pointing at a group that is
 * already gone. The group's options cascade.
 */
export async function deleteGroup(groupId: unknown): Promise<void> {
  if (typeof groupId !== 'string') rejected();

  const group = await prisma.modifierGroup.findUnique({ where: { id: groupId } });
  if (!group) rejected();
  await prisma.$transaction([
    prisma.itemModifierGroup.deleteMany({ where: { groupId } }),
    prisma.modifierGroup.delete({ where: { id: groupId } }),
  ]);
  done(`${group.name} deleted`);
}

/** "0"/"3" → bounds, or null. A max below the min is the one pair that makes
 *  the group unsatisfiable rather than merely odd. */
function parseBounds(minText: unknown, maxText: unknown): { min: number; max: number } | null {
  if (typeof minText !== 'string' || typeof maxText !== 'string') return null;
  const min = Number(minText);
  const max = Number(maxText);
  const whole = (n: number) => Number.isInteger(n) && n >= 0 && n <= 20;
  if (!whole(min) || !whole(max) || max < min || max < 1) return null;
  return { min, max };
}
