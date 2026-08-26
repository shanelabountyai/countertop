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

/** Back to the editor, unchanged. `why` replaces the generic banner when
 *  there is something specific worth saying — a value that moved under the
 *  manager is not the same as a value they mistyped. */
function rejected(why?: string): never {
  redirect(why ? `/kitchen/menu?error=${encodeURIComponent(why)}` : '/kitchen/menu?error=1');
}

/**
 * The confirm panel showed a price. This is where it is checked (C-026).
 *
 * The panel re-reads the current value on every render, so a screen left open
 * through someone else's edit already shows the truth. What it cannot cover is
 * the window between that render and the tap — and the whole purpose of this
 * screen is "here is the number you are replacing", so applying the change
 * against a DIFFERENT number is the one failure it must not have.
 *
 * The bound argument is client input like any other, which is why the answer
 * is a comparison against the database rather than trust.
 */
function stale(seen: unknown, actual: number, what: string, format: (c: number) => string): void {
  if (typeof seen !== 'number' || seen === actual) return;
  rejected(
    `${what} is ${format(actual)} now, not the ${format(seen)} you were shown. Someone else changed it — check the new value before saving.`,
  );
}

/** The three values a group's confirm panel displayed, if it sent them. */
type SeenGroup = { name: string; min: number; max: number };

function seenGroup(value: unknown): SeenGroup | null {
  if (typeof value !== 'object' || value === null) return null;
  const { name, min, max } = value as Partial<SeenGroup>;
  return typeof name === 'string' && typeof min === 'number' && typeof max === 'number'
    ? { name, min, max }
    : null;
}

/**
 * An item's base price. Non-negative: an item that pays the customer to order
 * it is a typo every time, and the composition engine has no notion of one.
 */
export async function saveItemPrice(
  itemId: unknown,
  priceText: unknown,
  seenFromCents?: unknown,
): Promise<void> {
  if (typeof itemId !== 'string' || typeof priceText !== 'string') rejected();
  const cents = parsePriceInput(priceText);
  if (cents === null || cents < 0) rejected();

  const item = await prisma.menuItem.findUnique({ where: { id: itemId } });
  if (!item) rejected();
  stale(seenFromCents, item.basePriceCents, item.name, formatCents);
  await prisma.menuItem.update({ where: { id: itemId }, data: { basePriceCents: cents } });
  done(`${item.name} is now priced at ${formatCents(cents)}`);
}

/**
 * A modifier's price delta. Negative IS legal here — "Small −$1.50" is a
 * discount, not a mistake — which is exactly why the confirm step showing
 * old → new matters more on this row than on an item's.
 */
export async function saveOptionPrice(
  optionId: unknown,
  priceText: unknown,
  seenFromCents?: unknown,
): Promise<void> {
  if (typeof optionId !== 'string' || typeof priceText !== 'string') rejected();
  const cents = parsePriceInput(priceText);
  if (cents === null) rejected();

  const option = await prisma.modifierOption.findUnique({ where: { id: optionId } });
  if (!option) rejected();
  stale(seenFromCents, option.priceDeltaCents, option.name, (c) => formatDeltaCents(c) || '$0.00');
  await prisma.modifierOption.update({
    where: { id: optionId },
    data: { priceDeltaCents: cents },
  });
  done(`${option.name} is now ${formatDeltaCents(cents) || 'free'}`);
}

/**
 * What "extra" costs, on top of the option's own delta (C-027).
 *
 * The only price on this screen that can be BLANK, and blank is a value:
 * `null` means extra is free, which is what most options are. Non-negative —
 * asking for extra cheese must not make the burrito cheaper — and the database
 * carries the same rule as a CHECK constraint (C-022).
 */
export async function saveExtraSurcharge(
  optionId: unknown,
  priceText: unknown,
  seenFromCents?: unknown,
): Promise<void> {
  if (typeof optionId !== 'string' || typeof priceText !== 'string') rejected();
  const raw = priceText.trim();
  const cents = raw === '' ? null : parsePriceInput(raw);
  if (raw !== '' && (cents === null || cents < 0)) rejected();

  const option = await prisma.modifierOption.findUnique({
    where: { id: optionId },
    include: { group: true },
  });
  if (!option) rejected();
  // A surcharge on a group with no `extra` to choose is a price nothing can
  // ever apply. Refused rather than stored as dead data.
  if (!option.group.intensityEnabled) {
    rejected(`${option.group.name} does not offer light/regular/extra, so there is no extra to price.`);
  }

  const format = (c: number | null) => (c === null ? 'free' : formatCents(c));
  const seen = seenFromCents === undefined ? undefined : seenFromCents;
  if (
    (typeof seen === 'number' || seen === null) &&
    seen !== (option.extraPriceDeltaCents ?? null)
  ) {
    rejected(
      `Extra ${option.name.toLowerCase()} is ${format(option.extraPriceDeltaCents ?? null)} now, not the ${format(seen)} you were shown. Someone else changed it — check the new value before saving.`,
    );
  }

  await prisma.modifierOption.update({
    where: { id: optionId },
    data: { extraPriceDeltaCents: cents },
  });
  done(`Extra ${option.name.toLowerCase()} is now ${format(cents)}`);
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
  seen?: unknown,
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

  // Same check as a price's, over the three values the panel displayed. A
  // group's bounds are what make every item that shares it orderable, so
  // applying "0 → 1" to a group someone else has already moved to 2 is the
  // same failure with more items downstream of it.
  const wasShown = seenGroup(seen);
  if (
    wasShown &&
    (wasShown.name !== group.name || wasShown.min !== group.min || wasShown.max !== group.max)
  ) {
    rejected(
      `${group.name} is now "choose ${group.min} to ${group.max}". Someone else changed it while you were looking — check it before saving.`,
    );
  }

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
