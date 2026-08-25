// The customer menu (P0-1). A server component: the menu comes out of the
// database on the server, and the only thing that reaches the browser is what
// it renders.
import Link from 'next/link';
import { loadMenu } from '@countertop/db/menu';
import { formatCents } from '@/lib/money';

export const metadata = { title: 'Menu — Firebird Kitchen' };

// Rendered per request, never prerendered at build time. An 86 has to reach
// the menu the moment a manager taps it (P0-6) — a menu baked into the build
// output goes stale the first time the kitchen runs out of anything.
export const dynamic = 'force-dynamic';

export default async function MenuPage() {
  const menu = await loadMenu();
  const items = Object.values(menu.items);

  return (
    <main className="mx-auto max-w-2xl p-6">
      <header className="mb-8 flex items-baseline justify-between gap-4">
        <h1 className="text-3xl font-semibold">Firebird Kitchen</h1>
        <Link href="/cart" className="text-sm underline underline-offset-4">
          View cart
        </Link>
      </header>

      {menu.categories.map((category) => (
        <section key={category.id} className="mb-8">
          <h2 className="mb-3 text-xl font-semibold">{category.name}</h2>
          <ul className="flex flex-col gap-2">
            {items
              .filter((item) => item.categoryId === category.id)
              .map((item) => (
                <li key={item.id}>
                  {/* A sold-out item is RENDERED, not hidden (P0-6): a customer
                      who cannot find the burrito assumes the site is broken,
                      one who sees it greyed out knows the kitchen ran out. */}
                  {item.available ? (
                    <Link
                      href={`/menu/${item.id}`}
                      className="flex min-h-12 items-center justify-between gap-4 rounded-lg border border-neutral-300 px-4 py-3 hover:border-neutral-500"
                    >
                      <span className="font-medium">{item.name}</span>
                      <span className="tabular-nums">{formatCents(item.basePriceCents)}</span>
                    </Link>
                  ) : (
                    <div
                      aria-disabled="true"
                      className="flex min-h-12 items-center justify-between gap-4 rounded-lg border border-dashed border-neutral-300 px-4 py-3 text-neutral-500"
                    >
                      <span className="font-medium">
                        {item.name} <span className="font-normal">— Sold out</span>
                      </span>
                      <span className="tabular-nums">{formatCents(item.basePriceCents)}</span>
                    </div>
                  )}
                </li>
              ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
