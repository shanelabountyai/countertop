import { notFound } from 'next/navigation';
import type { Menu } from '@countertop/core/menu';
import { loadMenu } from '@countertop/db/menu';
import { Composer } from './composer';

export default async function ItemPage({ params }: { params: Promise<{ itemId: string }> }) {
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

  return <Composer menu={scoped} itemId={item.id} />;
}
