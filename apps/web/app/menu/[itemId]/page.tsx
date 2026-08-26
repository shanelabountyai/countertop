import { notFound } from 'next/navigation';
import type { Menu } from '@countertop/core/menu';
import { loadMenu } from '@countertop/db/menu';
import { readCart } from '@/lib/cart-session';
import { Composer } from './composer';

export default async function ItemPage({
  params,
  searchParams,
}: {
  params: Promise<{ itemId: string }>;
  searchParams: Promise<{ line?: string }>;
}) {
  const { itemId } = await params;
  const menu = await loadMenu();
  const item = menu.items[itemId];
  if (!item) notFound();

  // The composer gets a menu containing exactly this item and the groups it
  // uses — everything `validateComposition` and `priceLine` need, and nothing
  // else. The client is not the price authority; it is a preview of one.
  const scoped: Menu = {
    categories: [],
    items: { [item.id]: item },
    groups: Object.fromEntries(
      item.modifierGroupIds.flatMap((id) => (menu.groups[id] ? [[id, menu.groups[id]]] : [])),
    ),
  };

  // `?line=` re-opens this composer on a cart line the customer already has
  // (C-021). Resolved HERE, from the cookie, rather than being passed in the
  // URL: a composition in a query string is a composition the client wrote.
  //
  // A line id that is not in the cart — removed in another tab, or a stale
  // back button — falls through to composing a fresh one, which is what the
  // screen would honestly do next anyway. So does a line id belonging to a
  // DIFFERENT item: saving it would silently turn a burrito into a bowl.
  const lineId = (await searchParams).line;
  const line = lineId
    ? (await readCart()).lines.find((candidate) => candidate.id === lineId)
    : undefined;
  const editing =
    line && line.composition.itemId === item.id
      ? { lineId: line.id, composition: line.composition }
      : undefined;

  return <Composer menu={scoped} itemId={item.id} {...(editing && { editing })} />;
}
